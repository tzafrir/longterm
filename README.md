# Longterm

**Claude keeps the plan in a pane, so step 3 is still there after step 2 took an hour.**

## Why

Claude writes "Let's do: 1. 2. 3. 4." You start on 1, then 2, and by then 3 and 4 are far up the scroll.

With this mod, Claude keeps that list in your **Longterm** pane. It edits the list as the work moves, and removes it when nothing is left to do.

## An example

> Fix the guest count in the signup funnel and ship it.

Claude lays out four steps and keeps them. Two steps in, the pane reads:

```
╭──────────────────────────────────────────────────────────────────✕─╮
│ #4 Ship the funnel fix  changed 10m ago                            │
│ - [x] Fix the guest count in funnel.ts                             │
│ - [x] Add the test                                                 │
│ - [ ] Push to main                                                 │
│ - [ ] Watch CI                                                     │
│ Copy   Remove                                                      │
│                                                                    │
│ Earlier sessions: 1 snippet                                        │
╰────────────────────────────────────────────────────────────────────╯
```

When CI is green, Claude removes the snippet. The `Earlier sessions` row holds what an earlier session in this project left, for you or Claude to bring back.

## How it works

- **Claude keeps snippets.** A plan, a numbered list of steps, a checklist, a note. Claude decides when, from the system prompt: anything you will work through over several turns.
- **Claude edits them.** It marks a step done, adds a step, or notes what it learned. The snippet it changed moves to the top.
- **A snippet belongs to its session.** A new session starts with an empty pane. A resumed session gets its own snippets back.
- **Earlier work waits a few days.** Press `Earlier sessions` to see what earlier sessions in this project left, and press **Bring here** to move one into this session. Claude reads it with your next prompt. You can also ask Claude to pick up earlier work: it lists earlier snippets and brings one here. An earlier snippet nobody changed for `keepDays` (3 by default) is gone.
- **You can remove one.** Press **Remove**, then **Remove it**. **Copy** puts the snippet on the clipboard.
- `/longterm` opens the pane. With nothing kept in this session, it opens on the earlier ones.

## Claude's tools

| Tool | What it does |
|---|---|
| `save_snippet` | Keeps a new snippet: a title and a markdown body. |
| `edit_snippet` | Gives a snippet a new title, a new body, or both. An earlier session's snippet comes into this session. |
| `remove_snippet` | Takes a snippet out of the pane. |
| `list_snippets` | Reads this session's snippets whole, or one by its number. With `earlier: true`, earlier sessions' snippets too. |

The tools sit in the prompt's tool list, not behind ToolSearch. Only the main agent keeps, edits or removes snippets; a subagent can read them.

## Limits

- A session holds up to 30 snippets.
- A title is one line of up to 80 characters; a body is up to 8,000 characters.
- Past a limit, Claude gets the reason and what to do, and nothing is cut.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `keepDays` | 3 | How long an earlier session's snippet waits after its last change, for you or Claude to bring it into a new session. |

## Install

In Claude Code:

```
/plugin marketplace add tzafrir/longterm
/plugin install longterm@longterm
```

Or from your shell:

```
claude plugin marketplace add tzafrir/longterm
claude plugin install longterm@longterm
```

Then start a new session (or run `/reload-plugins`).

**Requirements:** Claude Code in a terminal, or in the desktop app's Code tab. The plugin is a [mod](https://github.com/anthropics/claude-code/blob/main/mods/README.md), written with Claude Code's function hooks, which are early access: they load only where function hooks are enabled, and their API may change between releases.

## Data and privacy

- **Stays on your machine.** Snippets live in the session's own state and in the plugin's own store, a JSON file under your Claude Code configuration directory, keyed by project folder. No network, no files of yours, no processes.
- **Snippets are part of the conversation.** Claude wrote them, and Claude reads them back when it lists them or when you bring one here. The session's transcript on disk keeps them, like anything Claude writes.
- **What it adds to the conversation:** the four tools, three lines at the end of the system prompt telling Claude when to keep a snippet, what each tool call answers, and a snippet you bring here with **Bring here**.

### What the mod puts in the prompts it submits

The mod submits no prompt of its own. It adds to the prompts you send in one case:

- **A snippet you brought here.** After you press **Bring here**, your next prompt carries a note Claude reads: "The user brought #4 "Preprod checklist" into this session from an earlier one. It reads:", then the snippet's body. It goes once, with the next prompt only.

Nothing else goes into a prompt. The mod reads two facts about the session, the session's id and its project folder, and puts neither in a prompt or a tool's answer. It uses the folder to keep each project's snippets apart, and the id to mark which session each snippet belongs to, both in the plugin's own store on your machine.

### Which tool calls it answers

Only calls to its own four tools, `save_snippet`, `edit_snippet`, `remove_snippet` and `list_snippets`, which the mod itself serves. Every other tool call passes through untouched. Their answers name snippets by number and title, and `list_snippets` gives their bodies and when each last changed: nothing about you, your files or the session.

## Support

Report a problem or ask for a feature in [GitHub Issues](https://github.com/tzafrir/longterm/issues). Read the [privacy policy](https://github.com/tzafrir/longterm/blob/main/docs/privacy.md).

## Develop

Load the plugin from a clone; the session reloads it as you edit:

```
git clone https://github.com/tzafrir/longterm
claude --plugin-dir longterm
```

```
claude plugin validate --strict longterm/.claude-plugin/plugin.json
claude plugin test longterm
```

The test kit checks the tree the plugin draws, never how a terminal lays it out. `python3 tests/live/test_pane.py` draws the pane in a real Claude Code in tmux, at narrow and wide widths, and reads the screen back; no model is called. With `RENDERS_DIR` set it keeps every screen, and `python3 tests/live/renders.py "$RENDERS_DIR"` lays them out. Loading the plugin lays the engine's types in `.claude-plugin/types/`; then `tsc -p .` type-checks.

| File | What it does |
|------|--------------|
| `hooks/register.tsx` | The tools Claude calls, the system prompt lines, the Longterm pane, `/longterm`, a brought snippet with the next prompt |
| `hooks/longterm.ts` | Reading a snippet from Claude's call, keeping, editing, removing and expiring snippets, what `list_snippets` answers |
| `hooks/lib/text.ts` | Printable labels, ages, counts |
| `types/index.d.ts` | The `$.state` contract: the snippets, the session, the earlier row, a Remove waiting for its second press |
| `tests/register.test.ts` | Keeping, editing and removing, a new and a resumed session, bringing earlier work here, limits, the pane's buttons, the system prompt |
| `tests/live/` | The pane drawn in a real Claude Code, and its renders laid out for a person |
| `docs/DESIGN.md` | The design and the decisions behind it |

## License

MIT. See [LICENSE](LICENSE).
