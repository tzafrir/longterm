import type { On, PaneOpenArgs } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MAX_BODY, MAX_SNIPPETS, storedOf } from '../hooks/longterm'

const SAVE = 'mcp__longterm__save_snippet'
const EDIT = 'mcp__longterm__edit_snippet'
const REMOVE = 'mcp__longterm__remove_snippet'
const LIST = 'mcp__longterm__list_snippets'

const NOW = Date.parse('2026-10-13T09:00:00Z')
const KEY = 'project:/repo'

const PANE = {
  plugin: 'longterm',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'longterm',
  props: {
    title: 'Longterm',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PLAN = {
  tool: SAVE,
  title: 'Ship the funnel fix',
  body: '1. Fix the guest count\n2. Add the test\n3. Push to main\n4. Watch CI',
} as const

/** A snippet an earlier session kept in the same project an hour ago. */
const EARLIER = {
  id: 4,
  title: 'Preprod checklist',
  body: '- [ ] migrations\n- [ ] soak',
  sessionId: 'session-0',
  createdMs: NOW - 3_600_000,
  updatedMs: NOW - 3_600_000,
}

/** The engine beneath the mod: a store, a session, panes, toasts and the clipboard, kept in `world`. */
function seat(on: On, store: Record<string, unknown> = {}) {
  const world = {
    store: JSON.parse(JSON.stringify(store)) as Record<string, unknown>,
    opens: [] as PaneOpenArgs[],
    toasts: [] as string[],
    copied: [] as string[],
    tools: [] as { name: string; description: string }[],
    sessionId: 'session-1',
    /** What an unasked open answers: drawn, or waiting undrawn and why. */
    placement: { isPlaced: true } as { isPlaced: true } | { isPlaced: false; reason: string },
  }

  const clock = mock.clock(on, { now: NOW })
  on('store.get', ($, e) => ({ value: world.store[e.key] }))
  on('store.set', ($, e) => {
    world.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('session.id', () => ({ value: world.sessionId }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.register', ($, e) => {
    world.tools.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__longterm__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    world.opens.push(e)
    return { value: e.focus === true ? { isPlaced: true } : world.placement }
  })
  on('ui.copy', ($, e) => {
    world.copied.push(e.text)
    return { value: { isCopied: true } }
  })

  return { world, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

type Answer = { deny?: string; result?: unknown }

async function call($: Engine, input: Record<string, unknown> & { tool: string }): Promise<Answer> {
  return (await $.tool.call(input as never)) as Answer
}

async function textOf($: Engine, key: string): Promise<string> {
  const ui = await $.ui.mount(PANE)
  const text = (await ui.find({ key }))?.text ?? ''
  await ui.unmount()
  return text
}

async function press($: Engine, key: string) {
  const ui = await $.ui.mount(PANE)
  await ui.press({ key })
  await ui.unmount()
}

describe('keeping a list', () => {
  test('Claude keeps a numbered plan, and the pane shows all of it with its number', async ($, on) => {
    const { world } = seat(on)
    await start($)

    const answer = await call($, PLAN)

    expect(answer.result).toBe('Kept #1 "Ship the funnel fix" in the user\'s Longterm pane. Edit it with edit_snippet as the work moves.')
    expect(world.opens.at(-1)).toEqual({ id: 'longterm', title: 'Longterm' })
    expect(await textOf($, 'head-1')).toContain('#1 Ship the funnel fix')
    expect(await textOf($, 'head-1')).toContain('changed now')
    expect(await textOf($, 'body-1')).toContain('3. Push to main')
    expect(await textOf($, 'body-1')).toContain('4. Watch CI')
    expect(storedOf(world.store[KEY]).snippets.map(s => s.id)).toEqual([1])
  })

  test('an edit replaces the body, and the snippet moves to the top', async ($, on) => {
    const { clock } = seat(on)
    await start($)
    await call($, PLAN)
    await clock.advance(5 * 60_000)
    await call($, { tool: SAVE, title: 'Preprod checklist', body: '- [ ] migrations\n- [ ] soak' })
    await clock.advance(20 * 60_000)

    const answer = await call($, { tool: EDIT, id: 1, body: '1. ~~Fix the guest count~~\n2. Add the test' })

    expect(answer.result).toBe('Updated #1 "Ship the funnel fix" in the Longterm pane.')
    expect(await textOf($, 'body-1')).toContain('~~Fix the guest count~~')
    const listed = String((await call($, { tool: LIST })).result)
    expect(listed.indexOf('#1 Ship')).toBeLessThan(listed.indexOf('#2 Preprod'))
  })

  test('Claude removes a finished snippet, and a later edit of it says the snippet is gone', async ($, on) => {
    const { world } = seat(on)
    await start($)
    await call($, PLAN)

    expect((await call($, { tool: REMOVE, id: 1 })).result).toBe('Removed #1 "Ship the funnel fix" from the Longterm pane.')
    expect((await call($, { tool: EDIT, id: 1, body: 'x' })).deny).toBe('No snippet #1. The user may have removed it, or it expired. list_snippets shows what is kept.')
    expect(storedOf(world.store[KEY]).snippets).toEqual([])
    expect(await textOf($, 'empty')).toContain('Nothing kept in this session.')
  })

  test('a removed snippet\'s number is never given again', async ($, on) => {
    seat(on)
    await start($)
    await call($, PLAN)
    await call($, { tool: REMOVE, id: 1 })

    expect((await call($, PLAN)).result).toContain('Kept #2')
  })
})

describe('a new session', () => {
  test('starts with an empty pane: an earlier session\'s snippet opens nothing', async ($, on) => {
    const { world } = seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    await start($)

    expect(world.opens).toEqual([])
    expect(await textOf($, 'head-4')).toBe('')
    expect(await textOf($, 'toggle-earlier')).toBe('Earlier sessions: 1 snippet')
  })

  test('a resumed session gets its own snippets back, and the pane opens', async ($, on) => {
    const { world } = seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    world.sessionId = 'session-0'
    await start($)

    expect(world.opens).toEqual([{ id: 'longterm', title: 'Longterm' }])
    expect(await textOf($, 'head-4')).toContain('#4 Preprod checklist')
  })

  test('/longterm with only earlier snippets opens the pane with them shown', async ($, on) => {
    const { world } = seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    await start($)

    await $.command.run({ command: 'longterm', args: '' } as never)

    expect(world.opens).toEqual([{ id: 'longterm', title: 'Longterm', focus: true }])
    expect(await textOf($, 'head-4')).toContain('#4 Preprod checklist')
    expect(await textOf($, 'bring-4')).toBe('Bring here')
  })

  test('/longterm with nothing in the project says so', async ($, on) => {
    seat(on)
    await start($)

    expect((await $.command.run({ command: 'longterm', args: '' } as never)).text).toBe('Claude keeps no snippets for this project yet.')
  })

  test('Bring here moves the snippet into this session, and Claude reads it with the next prompt, once', async ($, on) => {
    const { world } = seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    await start($)
    await press($, 'toggle-earlier')

    await press($, 'bring-4')

    expect(storedOf(world.store[KEY]).snippets[0]?.sessionId).toBe('session-1')
    expect(await textOf($, 'toggle-earlier')).toBe('')
    expect(await textOf($, 'head-4')).toContain('changed now')
    expect(world.toasts).toContain('Brought #4 into this session. Claude reads it with your next prompt.')
    const first = await $.prompt.context({ blocks: [] } as never)
    expect(first.blocks.at(-1)?.text).toBe('The user brought #4 "Preprod checklist" into this session from an earlier one. It reads:\n- [ ] migrations\n- [ ] soak')
    expect((await $.prompt.context({ blocks: [] } as never)).blocks).toEqual([])
  })

  test('Claude reads earlier snippets only when it asks, and an edit brings one here', async ($, on) => {
    seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    await start($)
    await call($, PLAN)

    expect((await call($, { tool: LIST })).result).toBe(
      [
        'The Longterm pane holds 1 snippet for this session, newest change first:',
        '#5 Ship the funnel fix (changed now)\n1. Fix the guest count\n2. Add the test\n3. Push to main\n4. Watch CI',
        'Earlier sessions in this project left 1 snippet. Call list_snippets with earlier: true to read them.',
      ].join('\n\n'),
    )
    expect(String((await call($, { tool: LIST, earlier: true })).result)).toContain(
      'Earlier sessions in this project left 1 snippet. To bring one into this session, call edit_snippet with its id:\n\n#4 Preprod checklist (changed 1h ago)\n- [ ] migrations\n- [ ] soak',
    )

    expect((await call($, { tool: EDIT, id: 4 })).result).toBe('Brought #4 "Preprod checklist" into this session\'s Longterm pane.')
    expect(await textOf($, 'head-4')).toContain('#4 Preprod checklist')
    expect((await call($, { tool: EDIT, id: 4 })).deny).toBe('#4 is in this session already. Give a new title, a new body, or both.')
  })

  test('an earlier snippet nobody changed for keepDays (3 by default) is gone', async ($, on) => {
    const old = { ...EARLIER, id: 3, title: 'Old plan', updatedMs: NOW - 4 * 86_400_000 }
    const { world } = seat(on, { [KEY]: { nextId: 5, snippets: [old, EARLIER] } })
    await start($)

    expect(await textOf($, 'toggle-earlier')).toBe('Earlier sessions: 1 snippet')
    await call($, PLAN)
    expect(storedOf(world.store[KEY]).snippets.map(s => s.id)).toEqual([4, 5])
  })
})

describe('what Claude may not keep', () => {
  test('a long body, an empty one, or a full session is denied with what to do', async ($, on) => {
    const full = Array.from({ length: MAX_SNIPPETS }, (_, i) => ({ ...EARLIER, id: i + 1, sessionId: 'session-1' }))
    seat(on, { [KEY]: { nextId: MAX_SNIPPETS + 1, snippets: full } })
    await start($)

    expect((await call($, { ...PLAN, body: 'x'.repeat(MAX_BODY + 1) })).deny).toContain(`Keep it under ${MAX_BODY}`)
    expect((await call($, { ...PLAN, body: '  \n ' })).deny).toBe('Give the snippet a body: the plan, the steps or the note, in markdown.')
    expect((await call($, PLAN)).deny).toBe(`The pane holds ${MAX_SNIPPETS} snippets for this session already. Edit one that covers this work, or remove one that is done, then keep this one.`)
  })

  test('the title is one line, and the body keeps what Claude wrote', async ($, on) => {
    seat(on)
    await start($)

    await call($, { tool: SAVE, title: 'Fix\nthe — funnel', body: '1. Count guests — then test' })

    expect(await textOf($, 'head-1')).toContain('#1 Fix the — funnel')
    expect(await textOf($, 'body-1')).toContain('1. Count guests — then test')
  })

  test('a subagent keeps nothing for the user', async ($, on) => {
    seat(on)
    await start($)

    const answer = await call($, { ...PLAN, agentId: 'agent-1' })

    expect(answer.deny).toBe('Only the main agent keeps snippets for the user. Put the list in your result instead.')
  })
})

describe('the person in the pane', () => {
  test('Remove asks once more, Keep takes it back, and Remove it removes it', async ($, on) => {
    const { world } = seat(on)
    await start($)
    await call($, PLAN)

    await press($, 'remove-1')
    expect(await textOf($, 'keep-1')).toBe('Keep')

    await press($, 'keep-1')
    expect(await textOf($, 'remove-1')).toBe('Remove')
    expect(storedOf(world.store[KEY]).snippets).toHaveLength(1)

    await press($, 'remove-1')
    await press($, 'remove-1')

    expect(storedOf(world.store[KEY]).snippets).toEqual([])
    expect(world.toasts).toContain('Removed #1.')
  })

  test('Copy puts the body on the clipboard', async ($, on) => {
    const { world } = seat(on)
    await start($)
    await call($, PLAN)

    await press($, 'copy-1')

    expect(world.copied).toEqual([PLAN.body])
    expect(world.toasts).toContain('Copied #1.')
  })

  test('a change another session made shows at the next turn', async ($, on) => {
    const { world } = seat(on)
    await start($)
    await call($, PLAN)

    const stored = storedOf(world.store[KEY])
    world.store[KEY] = { ...stored, snippets: stored.snippets.map(s => ({ ...s, body: '1. ~~Fix the guest count~~ done' })) }
    await $.turn.start({ turnId: 't2' } as never)

    expect(await textOf($, 'body-1')).toContain('done')
  })
})

describe('a terminal too narrow for the pane', () => {
  /** What the engine answers an unasked open under 144 columns. */
  const NARROW = { isPlaced: false, reason: 'opened unasked under 144 columns (100 now)' } as const

  test('a kept snippet, or one Claude brings here, says so in a toast with /longterm', async ($, on) => {
    const { world } = seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    world.placement = NARROW
    await start($)

    await call($, PLAN)
    expect(world.toasts).toEqual(['Kept #5 "Ship the funnel fix" · /longterm'])

    await call($, { tool: EDIT, id: 5, body: '- [x] Fix the guest count' })
    expect(world.toasts).toHaveLength(1)

    await call($, { tool: EDIT, id: 4 })
    expect(world.toasts.at(-1)).toBe('Brought #4 "Preprod checklist" here · /longterm')
  })

  test('a resumed session with snippets says so as it starts', async ($, on) => {
    const { world } = seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    world.sessionId = 'session-0'
    world.placement = NARROW

    await start($)

    expect(world.toasts).toEqual(['This session: 1 snippet · /longterm'])
  })

  test('a pane drawn, or a session with no screen, toasts nothing', async ($, on) => {
    const { world } = seat(on)
    await start($)
    await call($, PLAN)

    world.placement = { isPlaced: false, reason: 'no-surface: none attached' }
    await call($, { ...PLAN, title: 'Second plan' })

    expect(world.toasts).toEqual([])
  })
})

describe('/resume in place', () => {
  test('the pane shows the resumed session\'s snippets as its own', async ($, on) => {
    const { world, clock } = seat(on, { [KEY]: { nextId: 5, snippets: [EARLIER] } })
    await start($)
    expect(await textOf($, 'toggle-earlier')).toBe('Earlier sessions: 1 snippet')

    world.sessionId = 'session-0'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-0' } } as never)
    await clock.settle()

    expect(await textOf($, 'head-4')).toContain('#4 Preprod checklist')
    expect(await textOf($, 'toggle-earlier')).toBe('')
  })
})

describe('steering', () => {
  test('edit_snippet asks for a tick, which the pane draws, not a strikethrough, which it does not', async ($, on) => {
    const { world } = seat(on)
    await start($)

    const description = world.tools.find(t => t.name === 'edit_snippet')?.description ?? ''

    expect(description).toContain('tick it, `- [x]`')
    expect(description).not.toContain('strike it through')
  })

  test('the system prompt says when to keep a snippet, where Claude can reach the tool', async ($, on) => {
    seat(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await start($)

    const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], outputStyle: null } as const
    const offered = await $.prompt.compose({ ...base, tools: ['Bash', SAVE], traits: [] } as never)
    const headless = await $.prompt.compose({ ...base, tools: ['Bash', SAVE], traits: ['print'] } as never)
    const without = await $.prompt.compose({ ...base, tools: ['Bash'], traits: [] } as never)

    expect(offered.sections.at(-1)?.text).toContain('keep it with mcp__longterm__save_snippet')
    expect(offered.sections.at(-1)?.text).toContain('a new session starts with an empty pane')
    expect(headless.sections).toHaveLength(1)
    expect(without.sections).toHaveLength(1)
  })
})
