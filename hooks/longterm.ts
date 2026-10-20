import type { Snippet } from '../types'
import { ago, plural, printable } from './lib/text'

/** At most this many snippets wait per project: past it, Claude edits or removes one first. */
export const MAX_SNIPPETS = 30
export const MAX_TITLE = 80
export const MAX_BODY = 8_000

/** What the store keeps per project. */
export type Stored = { nextId: number; snippets: readonly Snippet[] }

export type Draft = { title: string; body: string }
export type Patch = { id: number; title?: string; body?: string }
type Failed = { error: string }

export function storeKeyOf(root: string): string {
  return `project:${root}`
}

/** Reads the store's value back, keeping only well-formed snippets. */
export function storedOf(value: unknown): Stored {
  const raw = (value ?? {}) as { nextId?: unknown; snippets?: unknown }
  const snippets = Array.isArray(raw.snippets) ? raw.snippets.filter(isSnippet) : []
  const highest = snippets.reduce((max, s) => Math.max(max, s.id), 0)
  const nextId = typeof raw.nextId === 'number' && raw.nextId > highest ? raw.nextId : highest + 1

  return { nextId, snippets }
}

function isSnippet(value: unknown): value is Snippet {
  const s = value as Partial<Snippet> | null

  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.id === 'number' &&
    typeof s.title === 'string' &&
    typeof s.body === 'string' &&
    typeof s.sessionId === 'string' &&
    typeof s.createdMs === 'number' &&
    typeof s.updatedMs === 'number'
  )
}

/** Newest change first: the snippet Claude just touched is on top. */
export function sorted(snippets: readonly Snippet[]): readonly Snippet[] {
  return [...snippets].sort((a, b) => b.updatedMs - a.updatedMs || b.id - a.id)
}

/** A title the pane can draw: one line. */
function titleOf(text: string): string {
  return printable(text, MAX_TITLE)
}

/** Markdown the pane can draw: tab and newline are its only control characters. */
function bodyOf(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, c => (c === '\n' || c === '\t' ? c : ''))
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
}

function bodyTooLong(body: string): string {
  return `The body is ${body.length} characters. Keep it under ${MAX_BODY}: the pane is for what the user works through, not a document. Shorten it, or keep the long part in a file and name the file here.`
}

export function parseDraft(input: Record<string, unknown>): Draft | Failed {
  const title = typeof input.title === 'string' ? titleOf(input.title) : ''
  const body = typeof input.body === 'string' ? bodyOf(input.body) : ''

  if (title === '') {
    return { error: 'Give the snippet a title: one line that says what the list is for.' }
  }
  if (body === '') {
    return { error: 'Give the snippet a body: the plan, the steps or the note, in markdown.' }
  }
  if (body.length > MAX_BODY) {
    return { error: bodyTooLong(body) }
  }

  return { title, body }
}

export function parsePatch(input: Record<string, unknown>): Patch | Failed {
  const id = parseId(input)

  if (typeof id !== 'number') {
    return id
  }

  const patch: Patch = { id }

  if (typeof input.title === 'string') {
    const title = titleOf(input.title)
    if (title === '') {
      return { error: 'The new title is empty. Leave title out to keep the one it has.' }
    }
    patch.title = title
  }
  if (typeof input.body === 'string') {
    const body = bodyOf(input.body)
    if (body === '') {
      return { error: 'The new body is empty. To take the snippet away, call remove_snippet.' }
    }
    if (body.length > MAX_BODY) {
      return { error: bodyTooLong(body) }
    }
    patch.body = body
  }
  return patch
}

export function parseId(input: Record<string, unknown>): number | Failed {
  const id = input.id

  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : { error: 'Give the snippet\'s number as id, as list_snippets shows it.' }
}

export function missing(id: number): string {
  return `No snippet #${id}. The user may have removed it, or it expired. list_snippets shows what is kept.`
}

/** This session's snippets, newest change first. */
export function mineOf(snippets: readonly Snippet[], sessionId: string): readonly Snippet[] {
  return sorted(snippets.filter(s => s.sessionId === sessionId))
}

/** Earlier sessions' snippets in the project, newest change first. */
export function earlierOf(snippets: readonly Snippet[], sessionId: string): readonly Snippet[] {
  return sorted(snippets.filter(s => s.sessionId !== sessionId))
}

/**
 * Drops earlier sessions' snippets nobody changed for `keepMs`. This
 * session's own stay as long as it runs.
 */
export function pruned(stored: Stored, sessionId: string, nowMs: number, keepMs: number): Stored {
  const snippets = stored.snippets.filter(s => s.sessionId === sessionId || nowMs - s.updatedMs < keepMs)

  return snippets.length === stored.snippets.length ? stored : { ...stored, snippets }
}

export function keep(stored: Stored, draft: Draft, sessionId: string, nowMs: number): { stored: Stored; snippet: Snippet } | Failed {
  if (mineOf(stored.snippets, sessionId).length >= MAX_SNIPPETS) {
    return { error: `The pane holds ${MAX_SNIPPETS} snippets for this session already. Edit one that covers this work, or remove one that is done, then keep this one.` }
  }

  const snippet: Snippet = { id: stored.nextId, ...draft, sessionId, createdMs: nowMs, updatedMs: nowMs }

  return { stored: { nextId: stored.nextId + 1, snippets: [...stored.snippets, snippet] }, snippet }
}

/**
 * Changes a snippet. A snippet from an earlier session comes into this one,
 * with or without a change: `isBrought` says so.
 */
export function edit(stored: Stored, patch: Patch, sessionId: string, nowMs: number): { stored: Stored; snippet: Snippet; isBrought: boolean } | Failed {
  const old = stored.snippets.find(s => s.id === patch.id)

  if (old === undefined) {
    return { error: missing(patch.id) }
  }

  const isBrought = old.sessionId !== sessionId

  if (!isBrought && patch.title === undefined && patch.body === undefined) {
    return { error: `#${old.id} is in this session already. Give a new title, a new body, or both.` }
  }
  if (isBrought && mineOf(stored.snippets, sessionId).length >= MAX_SNIPPETS) {
    return { error: `The pane holds ${MAX_SNIPPETS} snippets for this session already. Remove one that is done, then bring #${old.id} here.` }
  }

  const snippet: Snippet = { ...old, title: patch.title ?? old.title, body: patch.body ?? old.body, sessionId, updatedMs: nowMs }

  return { stored: { ...stored, snippets: stored.snippets.map(s => (s.id === patch.id ? snippet : s)) }, snippet, isBrought }
}

export function remove(stored: Stored, id: number): { stored: Stored; snippet: Snippet } | Failed {
  const snippet = stored.snippets.find(s => s.id === id)

  if (snippet === undefined) {
    return { error: missing(id) }
  }

  return { stored: { ...stored, snippets: stored.snippets.filter(s => s.id !== id) }, snippet }
}

/** The pane's dim line beside a title: when it last changed. */
export function metaOf(snippet: Snippet, nowMs: number): string {
  const when = ago(nowMs - snippet.updatedMs)

  return when === 'now' ? 'changed now' : `changed ${when} ago`
}

function blockOf(snippet: Snippet, nowMs: number): string {
  return `#${snippet.id} ${snippet.title} (${metaOf(snippet, nowMs)})\n${snippet.body}`
}

/**
 * What list_snippets answers: this session's snippets whole, so Claude can
 * edit one, and earlier sessions' too when asked for them.
 */
export function listOf(snippets: readonly Snippet[], sessionId: string, nowMs: number, isEarlierAsked: boolean): string {
  const mine = mineOf(snippets, sessionId)
  const earlier = earlierOf(snippets, sessionId)
  const parts = [
    mine.length === 0
      ? 'The Longterm pane holds no snippets for this session.'
      : `The Longterm pane holds ${plural(mine.length, 'snippet')} for this session, newest change first:`,
    ...mine.map(s => blockOf(s, nowMs)),
  ]

  if (isEarlierAsked) {
    parts.push(
      earlier.length === 0
        ? 'Earlier sessions in this project left no snippets.'
        : `Earlier sessions in this project left ${plural(earlier.length, 'snippet')}. To bring one into this session, call edit_snippet with its id:`,
      ...earlier.map(s => blockOf(s, nowMs)),
    )
  } else if (earlier.length > 0) {
    parts.push(`Earlier sessions in this project left ${plural(earlier.length, 'snippet')}. Call list_snippets with earlier: true to read them.`)
  }

  return parts.join('\n\n')
}
