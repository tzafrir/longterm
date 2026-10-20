import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, ToolSpec } from 'claude-code'

import type { Snippet } from '../types'
import {
  MAX_BODY,
  MAX_TITLE,
  earlierOf,
  edit,
  keep,
  listOf,
  metaOf,
  mineOf,
  missing,
  parseDraft,
  parseId,
  parsePatch,
  pruned,
  remove,
  sorted,
  storeKeyOf,
  storedOf,
} from './longterm'
import type { Stored } from './longterm'
import { plural } from './lib/text'

const SAVE = 'mcp__longterm__save_snippet'
const EDIT = 'mcp__longterm__edit_snippet'
const REMOVE = 'mcp__longterm__remove_snippet'
const LIST = 'mcp__longterm__list_snippets'

const PANE = 'longterm'
const COMMAND = 'longterm'

/**
 * The end of the system prompt: when to keep a snippet, and that it belongs
 * to the session. Said as what to do, so Claude keeps the list without being asked.
 */
const STEERING = [
  'When you give the user a plan, a numbered list of steps, or anything else they will work through over several turns, keep it with mcp__longterm__save_snippet. It stays in their Longterm pane, so they still see step 3 after step 2 took an hour.',
  'Edit it with edit_snippet as the work moves: mark what is done, and add what you learned. Remove it with remove_snippet when nothing in it is left to do.',
  'Snippets belong to this session, and a new session starts with an empty pane. When the user asks to pick up earlier work, call list_snippets with earlier: true, then edit_snippet with an id to bring that snippet into this session.',
].join('\n')

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'save_snippet',
    description: [
      "Keep a snippet in the user's Longterm pane: a plan, a numbered list of steps, a checklist, or a note they will come back to over several turns.",
      'It stays in the pane for the rest of this session, until you or the user remove it.',
      'Keep it when you give the user a list they will work through one item at a time, so the later items are still in front of them.',
      'The result gives the snippet its number. Edit it with edit_snippet as the work moves.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `One line that says what the snippet is for. Under ${MAX_TITLE} characters.` },
        body: { type: 'string', description: `The snippet in markdown, as you would write it in a reply. Under ${MAX_BODY} characters.` },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'edit_snippet',
    description: [
      'Change a snippet in the Longterm pane: a new title, a new body, or both. The body you give replaces the old one whole.',
      'Use it as the work moves: mark a step done (strike it through, or tick it), add a step, or note what you learned.',
      "An earlier session's snippet comes into this session when you edit it. Give its id alone to bring it here unchanged.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The snippet\'s number.' },
        title: { type: 'string', description: 'Optional: the new title.' },
        body: { type: 'string', description: 'Optional: the new body, whole, in markdown.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'remove_snippet',
    description: 'Take a snippet out of the Longterm pane when nothing in it is left to do, or the plan changed and a new snippet replaces it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The snippet\'s number.' } },
      required: ['id'],
    },
  },
  {
    name: 'list_snippets',
    description: [
      "Read this session's snippets in the Longterm pane, whole, with their numbers.",
      "With earlier: true, also read what earlier sessions in this project left, to pick up their work. Call it that way when the user asks to continue from an earlier session.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        earlier: { type: 'boolean', description: 'Optional: also list earlier sessions\' snippets in this project.' },
        id: { type: 'number', description: 'Optional: one snippet\'s number, to read only that one.' },
      },
    },
  },
]

const snippets = atom({ plugin: 'longterm', key: 'snippets' } as const, [] as readonly Snippet[])
const current = atom({ plugin: 'longterm', key: 'sessionId' } as const, '')
const confirming = atom({ plugin: 'longterm', key: 'confirming' } as const, null as number | null)
const isShowingEarlier = atom({ plugin: 'longterm', key: 'isShowingEarlier' } as const, false)

/** A tool call that broke answers Claude with the reason, never silence. */
const FAILED = () => ({ deny: 'Longterm could not read or write its store, so nothing changed in the pane. Tell the user, and give them the list in your reply.' })

/** How long an earlier session's snippet waits to be brought here (`keepDays`). */
let keepMs = 3 * 86_400_000

/** Snippets the person brought here with a press, for Claude to read with its next prompt. A reload starts it over. */
const brought: Snippet[] = []

export const register: Register = (on, options) => {
  keepMs = (typeof options['keepDays'] === 'number' && options['keepDays'] > 0 ? options['keepDays'] : 3) * 86_400_000

  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register(tool)
    }
    await $.command.register({ name: COMMAND, description: 'Show the snippets Claude keeps for you in this session, and load earlier ones' })

    // A resumed session has its own snippets back. A new one starts empty.
    const sessionId = await refresh($)
    if (mineOf(await read($, snippets), sessionId).length > 0 && e.isInteractive) {
      await show($, false)
    }

    return next(e)
  })

  // After /clear the process goes on as a new session, with no session.start.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)

    if (e.reason === 'clear') {
      $.clock.after(0, () => void refresh($).catch(() => undefined))
    }

    return ended
  })

  // Another session in the project may have changed the snippets since.
  on('turn.start', async ($, e, next) => {
    await refresh($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const sessionId = await refresh($)
    const kept = await read($, snippets)

    if (kept.length === 0) {
      return { text: 'Claude keeps no snippets for this project yet.' }
    }
    if (mineOf(kept, sessionId).length === 0) {
      await update($, isShowingEarlier, () => true)
    }

    await show($, true)

    return {}
  })

  // Claude reads what the person brought here, once, with the next prompt.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const told = brought.splice(0)

    if (told.length === 0) {
      return result
    }

    const text = told.map(s => `The user brought #${s.id} "${s.title}" into this session from an earlier one. It reads:\n${s.body}`).join('\n\n')

    return { ...result, blocks: [...result.blocks, { name: 'longterm', text }] }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isReachable = e.tools.some(tool => tool === SAVE || tool === 'ToolSearch')

    if (!isReachable || e.traits.includes('print') || e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'longterm:snippets', text: STEERING, scope: 'session' }] }
  })

  // In the prompt's tool list, not behind ToolSearch: the description is what
  // makes Claude keep the list without being asked.
  on('tool.describe', { tool: 'mcp__longterm__save_snippet' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__longterm__edit_snippet' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__longterm__remove_snippet' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__longterm__list_snippets' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: SAVE }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent keeps snippets for the user. Put the list in your result instead.' }
    }

    const draft = parseDraft(e as unknown as Record<string, unknown>)
    if ('error' in draft) {
      return { deny: draft.error }
    }

    const kept = keep(await load($), draft, await $.session.id(), await $.clock.now())
    if ('error' in kept) {
      return { deny: kept.error }
    }

    await persist($, kept.stored)
    await show($, false)

    return { result: `Kept #${kept.snippet.id} "${kept.snippet.title}" in the user's Longterm pane. Edit it with edit_snippet as the work moves.` }
  }).catch(FAILED)

  on('tool.call', { tool: EDIT }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent edits the user\'s snippets. Say what changed in your result instead.' }
    }

    const patch = parsePatch(e as unknown as Record<string, unknown>)
    if ('error' in patch) {
      return { deny: patch.error }
    }

    const edited = edit(await load($), patch, await $.session.id(), await $.clock.now())
    if ('error' in edited) {
      return { deny: edited.error }
    }

    await persist($, edited.stored)
    await show($, false)

    const done = edited.isBrought ? 'Brought' : 'Updated'
    const where = edited.isBrought ? 'into this session\'s Longterm pane' : 'in the Longterm pane'

    return { result: `${done} #${edited.snippet.id} "${edited.snippet.title}" ${where}.` }
  }).catch(FAILED)

  on('tool.call', { tool: REMOVE }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent removes the user\'s snippets.' }
    }

    const id = parseId(e as unknown as Record<string, unknown>)
    if (typeof id !== 'number') {
      return { deny: id.error }
    }

    const removed = remove(await load($), id)
    if ('error' in removed) {
      return { deny: removed.error }
    }

    await persist($, removed.stored)

    return { result: `Removed #${id} "${removed.snippet.title}" from the Longterm pane.` }
  }).catch(FAILED)

  on('tool.call', { tool: LIST }, async ($, e) => {
    const sessionId = await refresh($)
    const kept = await read($, snippets)

    if (e.id !== undefined) {
      const one = kept.filter(s => s.id === e.id)
      if (one.length === 0) {
        return { deny: missing(e.id) }
      }
      return { result: listOf(one, one[0]?.sessionId ?? sessionId, await $.clock.now(), false) }
    }

    return { result: listOf(kept, sessionId, await $.clock.now(), e.earlier === true) }
  }).catch(FAILED)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const kept = await read($, snippets)
    const sessionId = await read($, current)
    const pending = await read($, confirming)
    const isEarlierShown = await read($, isShowingEarlier)
    const nowMs = await $.clock.now()
    const mine = mineOf(kept, sessionId)
    const earlier = earlierOf(kept, sessionId)

    const card = (s: Snippet, isEarlier: boolean) => {
      const buttons =
        pending === s.id
          ? [
              <Button key={`remove-${s.id}`} plain label="Remove it" onPress={() => removePressed($, s.id)} />,
              <Button key={`keep-${s.id}`} plain label="Keep" onPress={() => update($, confirming, () => null)} />,
            ]
          : [
              ...(isEarlier ? [<Button key={`bring-${s.id}`} plain label="Bring here" onPress={() => bringPressed($, s.id)} />] : []),
              <Button key={`copy-${s.id}`} plain label="Copy" onPress={() => copyPressed($, s, e.surface)} />,
              <Button key={`remove-${s.id}`} plain label="Remove" onPress={() => update($, confirming, () => s.id)} />,
            ]

      return (
        <Box key={`snippet-${s.id}`} flexDirection="column" marginBottom={1}>
          <Box key={`head-${s.id}`} flexDirection="row" columnGap={2}>
            <Text bold={!isEarlier} dimColor={isEarlier} wrap="truncate-end">{`#${s.id} ${s.title}`}</Text>
            <Text dimColor wrap="truncate-end">{metaOf(s, nowMs)}</Text>
          </Box>
          <Markdown key={`body-${s.id}`} text={s.body} dimColor={isEarlier} />
          <Box flexDirection="row" columnGap={3}>
            {buttons}
          </Box>
        </Box>
      )
    }

    const rows = mine.map(s => card(s, false))

    if (mine.length === 0) {
      rows.push(
        <Box key="empty" flexDirection="column" marginBottom={1}>
          <Text dimColor>Nothing kept in this session. Claude keeps a plan or a list of steps here when you work through it over several turns.</Text>
        </Box>,
      )
    }

    if (earlier.length > 0) {
      const label = isEarlierShown ? 'Hide earlier sessions' : `Earlier sessions: ${plural(earlier.length, 'snippet')}`
      rows.push(
        <Box key="earlier" flexDirection="row">
          <Button key="toggle-earlier" plain label={label} onPress={() => update($, isShowingEarlier, shown => !shown)} />
        </Box>,
      )
      if (isEarlierShown) {
        rows.push(...earlier.map(s => card(s, true)))
      }
    }

    return <Box flexDirection="column">{rows}</Box>
  })
}

/** Reads the project's snippets, less the earlier ones past `keepDays`. */
async function load($: EngineInterface): Promise<Stored> {
  const stored = storedOf(await $.store.get(storeKeyOf(await $.session.root())))

  return pruned(stored, await $.session.id(), await $.clock.now(), keepMs)
}

/** Writes the project's snippets to the store and to the pane. */
async function persist($: EngineInterface, stored: Stored) {
  await $.store.set(storeKeyOf(await $.session.root()), stored)
  await update($, snippets, () => sorted(stored.snippets))
}

/** Reads the project's snippets and this session's id into the pane, and returns the id. */
async function refresh($: EngineInterface): Promise<string> {
  const sessionId = await $.session.id()
  const kept = sorted((await load($)).snippets)
  await update($, snippets, () => kept)
  await update($, current, () => sessionId)

  return sessionId
}

/** The pane is a view of the snippets: one that can't open costs the user a /longterm, never the snippet. */
async function show($: EngineInterface, isAsked: boolean) {
  await $.ui.open({ id: PANE, title: 'Longterm', ...(isAsked ? { focus: true as const } : {}) }).catch(() => undefined)
}

async function copyPressed($: EngineInterface, snippet: Snippet, surface: RenderSurface) {
  const copied = await $.ui.copy({ text: snippet.body, surface })
  $.ui.toast(copied.isCopied ? `Copied #${snippet.id}.` : `Could not copy #${snippet.id}. Select it in the pane.`)
}

async function bringPressed($: EngineInterface, id: number) {
  const moved = edit(await load($), { id }, await $.session.id(), await $.clock.now())
  if ('error' in moved) {
    $.ui.toast(moved.error)
    await refresh($)
    return
  }

  await persist($, moved.stored)
  brought.push(moved.snippet)
  $.ui.toast(`Brought #${id} into this session. Claude reads it with your next prompt.`)
}

async function removePressed($: EngineInterface, id: number) {
  await update($, confirming, () => null)

  const removed = remove(await load($), id)
  if ('error' in removed) {
    await refresh($)
    return
  }

  await persist($, removed.stored)
  $.ui.toast(`Removed #${id}.`)
}
