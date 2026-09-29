# Tasks: add-bridge-commands-command

## 1. Command registration & list building

- [x] 1.1 Register `bridge-commands` via `pi.registerCommand` (no
      arguments; description explains it lists bridgeable commands).
- [x] 1.2 List builder: filter `pi.getCommands()` by source
      ("extension" → `/name`, "skill" → `/skill:name`); include
      descriptions; sort by name; exclude `prompt`-source commands.
- [x] 1.3 Render: plain list text (local UI notify + follow-up prompt)
      + `telegram_button` block, with the unsafe-name guard (no button
      cell for names containing `{}|` backtick or newline).
- [x] 1.4 Include the one-line note that built-in TUI commands and
      prompt templates are not bridgeable.

## 2. Delivery & settle interplay

- [x] 2.1 Handler: `ctx.ui.notify` (plain list) then
      `pi.sendUserMessage(followUpPrompt, { deliverAs: "followUp" })`
      with the authoritative "copy verbatim" instruction.
- [x] 2.2 Follow-up dispatched synchronously inside the handler, so
      the existing settle timer always finds an agent turn (never
      fires) for a bridged `/bridge-commands`.

## 3. Tests

- [x] 3.1 Registration: command appears with description.
- [x] 3.2 List content: extension + skill commands listed with
      descriptions; prompt-source commands excluded; not-bridgeable
      note present.
- [x] 3.3 Unsafe names: plain text, no button cell.
- [x] 3.4 Handler dispatches follow-up with button block + verbatim
      instruction; local notify called.
- [x] 3.5 Settle: a dispatched `/bridge-commands` is settled by the
      follow-up turn; no settle prompt within the timer window.
- [x] 3.6 Existing suites keep passing.

## 4. Docs & release

- [x] 4.1 README: document `/bridge-commands` (what it lists, the
      buttons, the not-bridgeable boundary).
- [x] 4.2 openspec: validate, apply to specs, archive.
- [ ] 4.3 Version bump 0.3.0, tests + typecheck green, commit, push,
      tag, sync daemon checkout.
