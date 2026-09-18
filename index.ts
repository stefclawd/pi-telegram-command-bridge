/**
 * pi-telegram-command-bridge
 *
 * Companion extension for @llblab/pi-telegram: lets Telegram-originated
 * messages execute pi extension commands (e.g. /project) and skill
 * commands (/skill:name) natively, with full ExtensionCommandContext.
 *
 * Why this is needed:
 *   pi-telegram deliberately does not forward arbitrary TUI slash commands
 *   (safety boundary). Telegram prompts reach the agent via
 *   sendUserMessage() with expandPromptTemplates disabled, so
 *   "/project foo" arrives as literal text instead of executing.
 *
 * How it works (no pi-telegram source changes):
 *   pi.on("input") fires for every prompt BEFORE skill/template expansion
 *   when the extension-command check was skipped. For prompts with
 *   source "extension" (which is how sendUserMessage labels them, i.e.
 *   Telegram queue dispatch) that start with a known extension command
 *   name, this extension re-dispatches the SAME text through
 *   pi.sendUserMessage(text, { expandPromptTemplates: true }).
 *   prompt() then runs the extension-command check FIRST — before the
 *   input event — so the real handler executes with its full context
 *   (ctx.ui, ctx.switchSession, ctx.sessionManager, ...) and no second
 *   input event fires. Non-commands fall through once; a re-dispatch
 *   marker prevents loops.
 *
 * Settling the Telegram dispatch queue:
 *   pi-telegram marks a dispatched prompt as pending and only settles it
 *   (clears its pending flag and consumes the queue item) when an agent
 *   turn starts (agent_start). Extension commands run without a model
 *   turn, so a bridged command that triggers no LLM interaction of its
 *   own (e.g. "/project" with no arguments, which only calls
 *   ctx.ui.notify) would leave the pending flag set forever — every later
 *   Telegram message then queues up but is never dispatched (status shows
 *   "+N", the typing indicator never stops, the bridge is wedged until
 *   the session restarts).
 *
 *   After re-dispatching a command, the bridge therefore watches for the
 *   next agent_start. Commands that start a turn themselves settle the
 *   queue that way (session switches announce via a sendUserMessage
 *   follow-up; skill commands expand into real prompts). If no agent turn
 *   arrives within the check window, the bridge sends one short settle
 *   prompt: that turn gives pi-telegram the agent_start it needs, and its
 *   reply is delivered to Telegram as the answer to the original command
 *   message — which also gives the user visible confirmation on the phone.
 *
 *   Session replacement (switchSession/newSession/fork/reload) invalidates
 *   the captured `pi` between the re-dispatch and the settle timer firing:
 *   a command like /project <name> can REPLACE the session, and the stale
 *   timer then throws on pi.sendUserMessage and kills the daemon
 *   (uncaught exception in a setTimeout callback). The pending settles are
 *   therefore cleared on session_shutdown (fires on the old runtime before
 *   invalidation) and on session_start (fresh runtime), and the timer
 *   callback additionally guards the stale-ctx call. Skipping the settle
 *   after a session switch is correct, not just safe: pi-telegram resets
 *   its queue state on session replacement anyway, and the switcher
 *   announces the switch from inside the replacement session.
 *
 * Scope:
 *   - Only source "extension" prompts are intercepted (Telegram queue
 *     dispatch, generated-control-surface buttons, generative-app
 *     prompts). TUI ("interactive") and RPC ("rpc") prompts are
 *     untouched — they already dispatch commands natively.
 *   - Only extension-registered commands (pi.getCommands() with
 *     source "extension") and skill commands (/skill:name) are
 *     forwarded. Built-in TUI commands (/model, /new, ...) and prompt
 *     templates are not (pi-telegram expands prompt templates itself).
 *   - The leading telegram tag is stripped: plain "[telegram] " but also
 *     attribute variants "[telegram|thread:...]", "[telegram|from-thread:...]"
 *     (square brackets cannot appear in the attribute values — they are
 *     stripped by pi-telegram's own formatter).
 *
 *   - Only the FIRST LINE of the message is inspected for a command.
 *     pi-telegram appends context sections to the dispatched prompt:
 *     "\n\n[time] ..." (turn timestamp), "\n\n[attachments] ...",
 *     "\n\n[reply|from:...] ...", "\n\n[forward|...] ...",
 *     "\n\n[outputs] ...", "\n\n[voice] ...", and a "\n\n[guest] ..."
 *     note. Splitting on whitespace would glue the command to those
 *     sections ("/project\n\n[time] ..." matched nothing in v0.1.x), so
 *     the command is extracted from the first line only and the REST of
 *     the message is discarded when re-dispatching: context sections are
 *     transport metadata, not user input for command arguments.
 *
 *   - Reply turns are left alone: "[telegram] [reply|from:X] ..." has
 *     no slash command on its first line, so it falls through to the
 *     model as a normal prompt. A reply to a command message should
 *     reach the agent as text, not silently re-execute a command.
 *
 * Reply visibility: command handlers notify via ctx.ui (TUI/RPC notify);
 * in RPC mode those surface as extension_ui_request events, which the
 * daemon logs. Telegram side shows no echo — but every bridged command
 * that produces no agent turn of its own is followed by the settle turn
 * described above, whose confirmation reply does reach the Telegram chat.
 */

import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

const TELEGRAM_PREFIX_RE = /^\[telegram(?:\|[^\]]*)?\]\s?/;

/** Marks texts we re-dispatched so the fall-through pass is ignored (loop guard). */
const redispatched = new Set<string>();

/**
 * Command plus arguments: the first line of a telegram prompt, with the
 * leading telegram tag stripped. Context sections that pi-telegram
 * appends ([time], [attachments], [reply], [forward], [outputs],
 * [voice], [guest]) are separated by blank lines and are NOT part of
 * the command text.
 *
 * Returns "" when there is no usable command line.
 */
function extractCommandText(raw: string): string {
  const stripped = raw.replace(TELEGRAM_PREFIX_RE, "").trimStart();
  if (!stripped.startsWith("/")) return "";
  return stripped.slice(0, stripped.indexOf("\n") === -1 ? undefined : stripped.indexOf("\n"));
}

/** First whitespace-delimited token of the command line ("/project" in "/project foo bar"). */
function firstToken(text: string): string {
  const trimmed = text.trimStart();
  const spaceIndex = trimmed.search(/\s/);
  return spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
}

/**
 * How long to wait for an agent turn (agent_start) after re-dispatching a
 * command before assuming the command produced none and sending the settle
 * prompt. Command handlers that announce via sendUserMessage follow-ups
 * start their turn within the handler execution itself, so this window is
 * generous.
 */
const SETTLE_CHECK_MS = 3000;

interface PendingSettle {
  command: string;
  timer: NodeJS.Timeout;
}

/**
 * Commands dispatched from the Telegram queue that have not yet been
 * settled by an agent turn. FIFO order matches pi-telegram's queue
 * consumption (agent_start consumes the oldest dispatched item).
 */
const pendingSettles: PendingSettle[] = [];
let settleToken = 0;

function clearPendingSettles(): void {
  for (const entry of pendingSettles) {
    clearTimeout(entry.timer);
  }
  pendingSettles.length = 0;
}

/**
 * One short prompt whose only job is to start an agent turn so pi-telegram
 * settles the dispatched command. Its reply is delivered to Telegram as the
 * answer to the original command message.
 */
function settlePromptText(command: string): string {
  return (
    `[telegram-command-bridge] The extension command \`${command}\` was just executed natively ` +
    `outside the model loop; its output was routed to the local UI channel and is not visible in this conversation. ` +
    `Reply with exactly one short line confirming the command ran (e.g. "✅ ${command} executed"). ` +
    `Do not run it again and do not invent its output.`
  );
}

export default function (pi: ExtensionAPI) {
  /**
   * Any agent turn start settles pi-telegram's pending dispatch: its
   * agent-start hook consumes the dispatched queue item and clears the
   * pending flag. Session starts do the same via a fresh session runtime
   * (session switches reset the bridge state).
   *
   * session_shutdown runs on the OLD runtime BEFORE it is invalidated, so
   * it is the last safe place to drop pending settle timers when a
   * re-dispatched command is replacing the session right now
   * (ctx.switchSession/newSession/fork/reload inside the command handler).
   * Without this, a surviving 3s timer fires after invalidation and the
   * stale pi.sendUserMessage throws uncaught → daemon exit.
   */
  pi.on("agent_start", () => {
    clearPendingSettles();
  });
  pi.on("session_start", () => {
    clearPendingSettles();
  });
  pi.on("session_shutdown", () => {
    clearPendingSettles();
  });

  pi.on("input", async (event: InputEvent): Promise<InputEventResult> => {
    if (event.source !== "extension") return { action: "continue" };

    const raw = event.text.trimStart();
    const telegramTagged = TELEGRAM_PREFIX_RE.test(raw);
    if (!raw.startsWith("/") && !telegramTagged) {
      return { action: "continue" };
    }

    const commandText = extractCommandText(raw);
    if (!commandText) return { action: "continue" };

    // Loop guard: this is the fall-through pass of a text we already
    // re-dispatched (command not found). The re-dispatched text is the
    // extracted command line, so match on that. Let it continue as a
    // normal prompt exactly once.
    if (redispatched.has(commandText)) {
      redispatched.delete(commandText);
      return { action: "continue" };
    }

    const token = firstToken(commandText);
    const name = token.slice(1); // without "/"

    let forward = false;
    if (token.startsWith("/skill:")) {
      forward = true;
    } else {
      const commands = pi.getCommands();
      forward = commands.some(
        (c) => c.source === "extension" && c.name === name,
      );
    }
    if (!forward) {
      // Not a known command (or a reply turn without a leading slash
      // command): pi-telegram delivered this as a normal prompt on
      // purpose. Fall through untouched.
      return { action: "continue" };
    }

    // Re-dispatch the extracted command line (WITHOUT the [telegram]
    // tag and context sections: prompt() requires text.startsWith("/")
    // for the extension-command check). prompt() runs that check
    // before emitting input, so the real handler executes here with
    // its full ExtensionCommandContext. On success no second input
    // event fires; expire the guard entry defensively so repeated
    // identical commands keep working.
    redispatched.add(commandText);
    setTimeout(() => redispatched.delete(commandText), 60_000).unref?.();

    // Watch for the settle: if this command produces no agent turn of its
    // own, the Telegram dispatch pending flag would stay set forever and
    // wedge the queue. Schedule a settle prompt (only for tagged telegram
    // dispatches — other sendUserMessage surfaces have no Telegram queue
    // to wedge). An arriving agent_start clears the entry first.
    if (telegramTagged) {
      const entry: PendingSettle = { command: commandText } as PendingSettle;
      entry.timer = setTimeout(() => {
        const index = pendingSettles.indexOf(entry);
        if (index === -1) return; // settled meanwhile
        pendingSettles.splice(index, 1);
        // The re-dispatched command may have replaced the session (e.g.
        // /project <name>), invalidating this captured `pi`. Never let a
        // stale-context error escape into an uncaught timer callback.
        try {
          pi.sendUserMessage(settlePromptText(commandText), { deliverAs: "followUp" });
        } catch {
          // Session was replaced or the runtime reloaded: pi-telegram
          // resets its dispatch queue on session replacement anyway, so
          // there is nothing left to settle.
        }
      }, SETTLE_CHECK_MS);
      entry.timer.unref?.();
      pendingSettles.push(entry);
    }

    pi.sendUserMessage(commandText, {
      expandPromptTemplates: true,
      ...(event.streamingBehavior
        ? { deliverAs: event.streamingBehavior }
        : {}),
    });
    return { action: "handled" };
  });
}
