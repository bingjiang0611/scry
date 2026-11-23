export interface RemoteHistoryTurn {
  // Scry run id, only on structured turn pages (see history-reader pageTurn).
  runId?: string
  userText: string
  items: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }[]
}

export interface RemoteHistoryTurnsPage {
  turns: RemoteHistoryTurn[]
  offset: number
  totalTurns: number
  hasOlder: boolean
  snapshot: string
  source: 'active_memory' | 'indexed_archive' | 'index_rebuild' | 'monolithic' | 'claude_transcript' | 'pi_native'
  completeness: 'partial' | 'complete'
  sourceWarning?: 'native_unavailable'
}
