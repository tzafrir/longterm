# Longterm: design

A Claude Code mod in which Claude keeps the plan, a list of steps or a note it gives the user in a pane, and edits it as the work moves, so the later steps stay in front of the user however long the earlier ones take.

Status: v1.0.0, checked against the mod API of Claude Code 2.1.304: 18 kit tests and the live render check pass, strict validation passes.

## The problem

Claude writes "Let's do: 1. 2. 3. 4." The user starts on 1, then 2, and by then 3 and 4 are far up the scroll. Nothing keeps the plan in view, and nothing marks what is done.

## The idea

Claude calls `save_snippet` when it gives the user something they will work through over several turns. The snippet stays in the Longterm pane for the session. Claude edits it with `edit_snippet` as steps finish, and removes it with `remove_snippet` when nothing is left.

## Decisions

- **Steered by the system prompt and the tool descriptions.** Three lines at the end of the system prompt say when to keep a snippet. The four tools are not deferred (`tool.describe` returns `isDeferred: false`), so their descriptions sit in the prompt and Claude keeps the list without being asked. The lines are left out where Claude can't reach the tools, and in print and bare modes.
- **A snippet belongs to its session.** A new session starts with an empty pane; a resumed session has its own snippets back, and its pane opens. Several sessions in one project each see their own, and the others' under `Earlier sessions`.
- **Earlier work waits, then goes.** An earlier session's snippet waits `keepDays` (3 by default) after its last change, for the user's **Bring here** or Claude's `edit_snippet`, which move it into this session. Past that it is pruned on the next read. This session's own never expire while it runs.
- **Bring here tells Claude once.** A snippet the user brings here rides the next prompt as a context block, then is forgotten: Claude has it in the conversation from then on.
- **One store value per project** (`project:<root>`): the snippets and the next number. Numbers count up per project and are never given again, so `#4` means one snippet for as long as it exists.
- **Only the main agent writes.** A subagent may list snippets; keeping, editing or removing is the user's main thread's.
- **Limits that say what to do.** 30 snippets per session, a one-line title of 80 characters, a body of 8,000. Past a limit Claude is denied with the reason and the way out; nothing is cut.
- **The person can always undo.** Remove asks once more; Copy puts the body on the clipboard.
- **A broken store answers, never hangs.** Each tool call catches a failure and tells Claude to give the user the list in its reply instead.

## Testing

- `claude plugin test .`: the kit, for every tool, the pane's buttons, sessions new and resumed, and the system prompt.
- `python3 tests/live/test_pane.py`: the pane in a real Claude Code in tmux, at 36, 60, 100 and 150 columns, because the kit never lays out a screen. CI keeps every screen as a `renders` artifact and on the run's summary.
