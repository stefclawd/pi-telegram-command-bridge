# Proposal: add-bridge-commands-command

## Why

The bridge forwards Telegram-originated prompts to pi extension commands
and skill commands, but the set of forwardable commands is invisible to
the Telegram user: `pi.getCommands()` is an internal lookup, and the
bridge deliberately ignores unknown slash names (built-in TUI commands,
prompt templates) with no feedback. From the chat there is no way to ask
"what can I actually run through this bridge?" — discovering a command
means reading the extension source or trying it and watching it fall
through to the model.

## What Changes

1. **New registered extension command `/bridge-commands`** (the bridge
   itself registers it via `pi.registerCommand`, so it lands in
   `pi.getCommands()` with source `extension` and is therefore
   forwardable through the bridge's own machinery).
2. **Handler behavior:** lists the commands the bridge can forward,
   grouped:
   - extension-registered commands (`pi.getCommands()` with source
     `"extension"`), with their descriptions when present — each rendered
     as a `telegram_button` cell queuing the command (tappable in the
     chat, same pattern as pi-project-switcher's `/project` list);
   - skill commands (`pi.getCommands()` with source `"skill"`, shown
     as `/skill:<name>`);
   - explicitly NOT listed and NOT forwarded: built-in TUI commands
     (`/model`, `/new`, …) and prompt templates (source `"prompt"`) — a
     one-line note says these are not bridgeable.
3. **Delivery to the chat:** the handler output must reach the Telegram
   chat, not just the local UI. The handler follows the established
   pattern: `ctx.ui.notify` for the local surface, plus a
   `pi.sendUserMessage` follow-up prompt instructing the model to copy
   the authoritative list verbatim (same approach as
   pi-project-switcher's status list). That turn also settles the
   bridge's pending dispatch for the `/bridge-commands` message itself.
4. **Settle interplay:** `/bridge-commands` produces its own agent turn
   (the follow-up), so the existing 3 s settle timer finds an agent turn
   and never fires; no special-casing is needed, but tests must cover
   that ordering (turn scheduled from inside the command handler counts
   as settling).

## Impact

- Specs: new spec `command-bridge` with the command-listing requirement.
- Code: `index.ts` — register the command, build the list from
  `pi.getCommands()` filtered by source ("extension" / "skill"), notify +
  follow-up delivery.
- Tests: `test/extension.test.ts` — registration, list content,
  unbridgeable note, follow-up dispatched from the handler, settle
  consumed by the follow-up turn, no-op for interactive sources
  (native surfaces already show the list through ctx.ui).
- Docs: README — new section for `/bridge-commands`.
- Version bump to 0.3.0.
