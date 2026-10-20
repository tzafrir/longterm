/** A snippet Claude keeps for the user: a plan, a list of steps, a note. */
export type Snippet = {
  /** Counts up per project: #1, #2, … */
  id: number
  /** One line. */
  title: string
  /** Markdown, as Claude wrote it. */
  body: string
  /** The session that kept it, or last brought it into itself. */
  sessionId: string
  createdMs: number
  updatedMs: number
}

declare module 'claude-code' {
  /** The tools Longterm serves, as their inputSchema says, so a matcher on one narrows `e`. */
  interface McpToolInputs {
    'mcp__longterm__save_snippet': { title: string; body: string }
    'mcp__longterm__edit_snippet': { id: number; title?: string; body?: string }
    'mcp__longterm__remove_snippet': { id: number }
    'mcp__longterm__list_snippets': { earlier?: boolean; id?: number }
  }

  interface PluginState {
    'longterm': {
      /** The project's snippets, every session's, newest change first, as the store last read. */
      snippets: readonly Snippet[]
      /** This session's id, so the pane draws again after /clear starts a new one. */
      sessionId: string
      /** Whether the pane shows earlier sessions' snippets below this session's. */
      isShowingEarlier: boolean
      /** The snippet whose Remove the person pressed once, waiting for the second press. */
      confirming: number | null
    }
  }
}
