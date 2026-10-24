import type { TurnDiffSnapshot, WorkspaceDiffResult } from './trace.js'

/** Both totals and patch bodies are projected from these same immutable Git trees. */
export type WorkspaceDiffSnapshotResult =
  | {
      status: 'captured'
      head: string
      revision: string
      collectedAt: string
      snapshot: TurnDiffSnapshot
    }
  | Exclude<WorkspaceDiffResult, { status: 'captured' }>
