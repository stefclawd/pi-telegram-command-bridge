# pi-telegram-command-bridge

A [pi coding agent](https://github.com/earendil-works/pi) companion extension for [@llblab/pi-telegram](https://github.com/llblab/pi-telegram): executes pi extension commands (e.g. `/project`) and skill commands (`/skill:name`) natively from Telegram-originated prompts — with their full `ExtensionCommandContext`, no pi-telegram source changes required.

## Why

`pi-telegram` deliberately does not forward arbitrary TUI slash commands (a documented safety boundary). Telegram prompts reach the agent via `sendUserMessage()` with template expansion disabled, so `/project foo` arrives as literal chat text instead of executing the command handler.

This extension closes that gap for the **safe subset**: extension-registered commands and skill commands. Built-in TUI commands (`/model`, `/new`, …) are still not forwarded.

## How it works

`pi.on("input")` fires for every prompt before skill/template expansion when the extension-command check was skipped. For prompts with source `"extension"` (how `sendUserMessage` labels Telegram queue dispatch) that name a known extension command or skill command, this extension re-dispatches the same text through `pi.sendUserMessage(text, { expandPromptTemplates: true })`. `prompt()` then runs the extension-command check first — before the input event — so the real handler executes with its full context (`ctx.ui`, `ctx.switchSession`, `ctx.sessionManager`, …) and no second input event fires. Non-commands fall through once; a re-dispatch marker prevents loops.

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
- The Telegram side shows no command echo; the command's own announcements land in the session and the bridge replies normally on the next turn.

## Development

Single-file TypeScript extension (`index.ts`), loaded directly by pi via jiti — no build step.

```bash
npm install
npm test        # vitest
npm run typecheck
```

## License

MIT
