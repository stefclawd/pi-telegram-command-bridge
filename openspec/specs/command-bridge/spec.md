# command-bridge Specification

## Purpose
TBD - created by archiving change add-bridge-commands-command. Update Purpose after archive.

## Requirements

### Requirement: Bridgeable Command Listing

The extension SHALL register an extension command `bridge-commands` that
lists, at execution time, the commands the bridge can forward from
Telegram-originated prompts: all commands from `pi.getCommands()` with
source `extension` (rendered as `/name`, with description when
available) and all commands with source `skill` (rendered as
`/skill:name`). The list SHALL NOT include built-in TUI commands or
prompt-template commands (source `prompt`), and the output SHALL state
that those are not bridgeable. The handler SHALL report the list to the
local UI (`ctx.ui.notify`) and, to deliver the list to the Telegram
chat, dispatch a follow-up prompt (`pi.sendUserMessage` with
`deliverAs: "followUp"`) whose text contains the authoritative list and
a pre-rendered `telegram_button` block with one cell per bridgeable
command (cell label showing the command name — and description when
short —, payload queuing the command). Command names containing
markup-unsafe characters SHALL be rendered as plain list text without a
button cell. The follow-up turn doubles as the settle turn for the
bridge's pending dispatch of the `/bridge-commands` message itself; the
bridge's settle timer MUST therefore never fire for a dispatched
`/bridge-commands`.

#### Scenario: Lists extension and skill commands from the live registry

- **WHEN** `/bridge-commands` executes and `pi.getCommands()` contains
  an extension command `project` (with description) and a skill command
  `voice`
- **THEN** the local UI notification and the follow-up prompt both
  list `/project` (with its description) and `/skill:voice`

#### Scenario: Built-in and prompt-template commands are excluded and noted

- **WHEN** `pi.getCommands()` contains commands with source `prompt`
  and built-in TUI commands exist
- **THEN** none of them appear in the list
- **AND** the output states that built-in TUI commands and prompt
  templates are not bridgeable from Telegram

#### Scenario: Follow-up delivers the list to the chat with buttons

- **WHEN** the handler runs
- **THEN** a follow-up prompt is dispatched with `deliverAs: "followUp"`
- **AND** its text instructs the model to copy the list verbatim and
  includes a `telegram_button` block with one cell per bridgeable
  command, each cell queuing that command

#### Scenario: Unsafe command names get no button cell

- **WHEN** a bridgeable command name contains any of `{`, `}`, `|`,
  a backtick, or a newline
- **THEN** it appears in the plain list text but has no button cell

#### Scenario: The follow-up turn settles the pending dispatch

- **WHEN** `/bridge-commands` was dispatched from a Telegram-tagged
  prompt and the handler dispatches its follow-up
- **THEN** the bridge's 3 s settle timer finds the follow-up turn's
  `agent_start` and sends no settle prompt

#### Scenario: Self-forwardable like any extension command

- **WHEN** a Telegram prompt `/bridge-commands` arrives through the
  bridge's input handler
- **THEN** it is forwarded and executed exactly like any other
  extension command (no special casing in the input path)
