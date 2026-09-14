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
 * daemon logs. Telegram side shows no echo — the command's own
 * announcement (pi.sendUserMessage followUp from the handler) lands in
 * the session and the bridge replies normally on the next turn.
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

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event: InputEvent): Promise<InputEventResult> => {
    if (event.source !== "extension") return { action: "continue" };

    const raw = event.text.trimStart();
    if (!raw.startsWith("/") && !TELEGRAM_PREFIX_RE.test(raw)) {
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
    pi.sendUserMessage(commandText, {
      expandPromptTemplates: true,
      ...(event.streamingBehavior
        ? { deliverAs: event.streamingBehavior }
        : {}),
    });
    return { action: "handled" };
  });
}
