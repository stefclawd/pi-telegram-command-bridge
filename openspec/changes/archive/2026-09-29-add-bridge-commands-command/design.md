# Design: add-bridge-commands-command

## Context

- **Command discovery**: `pi.getCommands()` returns `SlashCommandInfo`
  with `source: "extension" | "prompt" | "skill"` and optional
  `description`. The bridge already uses it to decide forwarding;
  listing is the same lookup with a rendering layer. No new pi API
  surface is needed.

- **Self-forwardability**: the bridge registers `/bridge-commands` via
  `pi.registerCommand`, which puts it in `getCommands()` with source
  `extension` — the bridge's own input handler will therefore forward a
  Telegram `/bridge-commands` to the handler automatically. No special
  casing anywhere: the command is forwardable exactly like `/project`.

- **Delivery pattern** (established by pi-project-switcher): the command
  handler does `ctx.ui.notify(...)` for the local surface and then
  `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` with an
  authoritative prompt instructing the model to copy a pre-rendered
  list verbatim. The follow-up is an agent turn → the bridge's settle
  timer (3 s) finds `agent_start` and never fires; the reply reaches
  the chat as the answer to the command message. One subtlety: the
  settle timer arms on the INPUT pass that re-dispatched the command;
  the follow-up must be dispatched from within the command handler
  (before the timer window elapses) — which it is, synchronously in the
  handler.

- **Unsafe names**: project names contain safe characters, but command
  names come from other extensions and could contain markup-breaking
  characters (`{}|`). The same `isUnsafeButtonName` guard used by the
  switcher applies: unsafe names render as plain list text without a
  button cell.

- **Naming**: `/bridge-commands` (not `/commands`) to avoid colliding
  with any current or future built-in or other extension's command.

## Goals / Non-Goals

Goals:

- Telegram users can discover forwardable commands from the chat, with
  tappable buttons that queue each command.
- The list is derived from the live registry at handler run time, not
  baked in.
- Native surfaces (TUI/RPC) get the same list via `ctx.ui.notify`.

Non-Goals:

- Forwarding built-in TUI commands or prompt templates (safety boundary
  unchanged).
- Argument completion for `/bridge-commands` itself (it takes none).

## Risks / Trade-offs

- A command listed but registered by an extension that opens dialogs
  (`ctx.ui.confirm`) without a non-interactive opt-in can hang on the
  headless daemon. The list can show the command's description; the
  README caveat already covers this. Accepted.
- Button-row length limits in Telegram: large command sets produce many
  buttons. pi-telegram paginates button rows; the switcher's full
  project list (11 cells) renders fine. Accepted for now.

## Migration Plan

- Single-file extension: add the registration in the factory. No state,
  no config. Rollout: version bump + push; daemon checkout sync.
