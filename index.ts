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
 *   - A leading "[telegram] " tag (the bridge prefix) is stripped
 *     before matching; anything after the command text is preserved.
 *
 * Reply visibility: command handlers notify via ctx.ui (TUI/RPC notify);
 * in RPC mode those surface as extension_ui_request events, which the
 * daemon logs. Telegram side shows no echo — the command's own
 * announcement (pi.sendUserMessage followUp from the handler) lands in
 * the session and the bridge replies normally on the next turn.
 */

import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

const TELEGRAM_PREFIX_RE = /^\[telegram\]\s?/;

/** Marks texts we re-dispatched so the fall-through pass is ignored (loop guard). */
const redispatched = new Set<string>();

function firstToken(text: string): string {
  const trimmed = text.trimStart();
  const spaceIndex = trimmed.indexOf(" ");
  return spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event: InputEvent): Promise<InputEventResult> => {
    if (event.source !== "extension") return { action: "continue" };

    const raw = event.text.trimStart();
    if (!raw.startsWith("/") && !TELEGRAM_PREFIX_RE.test(raw)) {
      return { action: "continue" };
    }

    const stripped = raw.replace(TELEGRAM_PREFIX_RE, "").trimStart();
    if (!stripped.startsWith("/")) return { action: "continue" };

    // Loop guard: this is the fall-through pass of a text we already
    // re-dispatched (command not found). The re-dispatched text is the
    // stripped command, so match on that. Let it continue as a normal
    // prompt exactly once.
    if (redispatched.has(stripped)) {
      redispatched.delete(stripped);
      return { action: "continue" };
    }

    const token = firstToken(stripped);
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
    if (!forward) return { action: "continue" };

    // Re-dispatch the stripped command text (WITHOUT the [telegram] tag:
    // prompt() requires text.startsWith("/") for the extension-command
    // check). prompt() runs that check before emitting input, so the real
    // handler executes here with its full ExtensionCommandContext.
    // On success no second input event fires; expire the guard entry
    // defensively so repeated identical commands keep working.
    redispatched.add(stripped);
    setTimeout(() => redispatched.delete(stripped), 60_000).unref?.();
    pi.sendUserMessage(stripped, {
      expandPromptTemplates: true,
      ...(event.streamingBehavior
        ? { deliverAs: event.streamingBehavior }
        : {}),
    });
    return { action: "handled" };
  });
}
