# pi-telegram-command-bridge

A [pi coding agent](https://github.com/earendil-works/pi) companion extension for [@llblab/pi-telegram](https://github.com/llblab/pi-telegram): executes pi extension commands (e.g. `/project`) and skill commands (`/skill:name`) natively from Telegram-originated prompts — with their full `ExtensionCommandContext`, no pi-telegram source changes required.

## Why

`pi-telegram` deliberately does not forward arbitrary TUI slash commands (a documented safety boundary). Telegram prompts reach the agent via `sendUserMessage()` with template expansion disabled, so `/project foo` arrives as literal chat text instead of executing the command handler.

This extension closes that gap for the **safe subset**: extension-registered commands and skill commands. Built-in TUI commands (`/model`, `/new`, …) are still not forwarded.

## How it works

`pi.on("input")` fires for every prompt before skill/template expansion when the extension-command check was skipped. For prompts with source `"extension"` (how `sendUserMessage` labels Telegram queue dispatch) that name a known extension command or skill command, this extension re-dispatches the same text through `pi.sendUserMessage(text, { expandPromptTemplates: true })`. `prompt()` then runs the extension-command check first — before the input event — so the real handler executes with its full context (`ctx.ui`, `ctx.switchSession`, `ctx.sessionManager`, …) and no second input event fires. Non-commands fall through once; a re-dispatch marker prevents loops.

## Settling the Telegram dispatch queue

pi-telegram marks a dispatched prompt as pending and only settles it (clears its pending flag and consumes the queue item) when an agent turn starts. Extension commands run without a model turn, so a bridged command that triggers no LLM interaction of its own (e.g. `/project` with no arguments, which only calls `ctx.ui.notify`) would leave the pending flag set forever: every later Telegram message queues up but is never dispatched, the typing indicator never stops, and the bridge stays wedged until the session restarts.

After re-dispatching a command, the bridge watches for the next `agent_start` (or a session start, which resets pi-telegram's bridge state). Commands that start a turn themselves settle the queue that way — session switches announce via a `sendUserMessage` follow-up, skill commands expand into real prompts. If no agent turn arrives within three seconds, the bridge sends one short settle prompt: that turn gives pi-telegram the `agent_start` it needs, and its one-line confirmation reply is delivered to Telegram as the answer to the original command message.

Scope:

- Only `source: "extension"` prompts are intercepted (Telegram queue dispatch, generated-control-surface buttons, generative-app prompts). TUI (`"interactive"`) and RPC (`"rpc"`) prompts are untouched — they already dispatch commands natively.
- Only extension-registered commands (`pi.getCommands()` with `source: "extension"`) and skill commands (`/skill:name`) are forwarded. Built-in TUI commands and prompt templates are not (pi-telegram expands prompt templates itself).
- A leading `[telegram]` tag (the bridge prefix) is stripped before matching; everything after the command name is preserved as arguments.

## Install

```bash
pi install npm:pi-telegram-command-bridge
```

Or from git:

```bash
pi install git:github.com/stefclawd/pi-telegram-command-bridge
```

Requires `@llblab/pi-telegram` — this extension only does anything for prompts that arrive through it (or another `sendUserMessage`-based surface).

## Caveats

- Commands whose handlers open `ctx.ui.confirm`-style dialogs without a timeout can hang on headless/RPC surfaces, since nothing answers dialog requests there. Prefer commands with non-interactive opt-ins (e.g. `pi-project-switcher`'s `/project <name>!` create opt-in).
- Commands whose handlers only use `ctx.ui.notify` (no agent turn) are followed by a short settle prompt three seconds later; the model's one-line confirmation is delivered to Telegram as the reply to the command message.
- Command output is routed through `ctx.ui.notify` (TUI/RPC channel), not the Telegram chat itself; the settle-turn confirmation is the Telegram-visible feedback.

## Development

Single-file TypeScript extension (`index.ts`), loaded directly by pi via jiti — no build step.

```bash
npm install
npm test        # vitest
npm run typecheck
```

## License

MIT
