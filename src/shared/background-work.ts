export interface BackgroundTask {
  taskId: string
  toolUseId: string
  tool: 'Bash' | 'Agent'
  description: string
  /** When Scry received launch evidence, not the process's execution start. */
  observedAt: number
  stopState?: 'requested' | 'unconfirmed'
  /** Observation ended without a Provider task terminal; not proof of stopped work. */
  status?: 'unconfirmed'
}

/** Observed Provider events, not an exhaustive task registry or process audit. */
export interface BackgroundWork {
  providerId: 'qoder' | 'pi'
  phase: 'working' | 'waiting' | 'inactive'
  quiet: boolean
  lastEventAt: number
  /** Monotonic per-run snapshot revision; absent in older archives. */
  revision?: number
  tasks: BackgroundTask[]
  coverage: 'partial'
  taskStop: 'available' | 'unavailable'
}

export type BackgroundTaskStopResult = {
  status: 'requested' | 'unavailable' | 'rejected' | 'unknown'
  message: string
}

export function isOlderBackgroundWork(candidate: BackgroundWork, previous: BackgroundWork): boolean {
  return candidate.revision !== undefined && previous.revision !== undefined && candidate.revision < previous.revision
}

export function latestBackgroundWork(items: readonly { backgroundWork?: BackgroundWork }[]): BackgroundWork | undefined {
  let latest: BackgroundWork | undefined
  for (const { backgroundWork } of items) {
    if (backgroundWork && (!latest || !isOlderBackgroundWork(backgroundWork, latest))) latest = backgroundWork
  }
  return latest
}
