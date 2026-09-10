export interface BackgroundTask {
  taskId: string
  toolUseId: string
  tool: 'Bash' | 'Agent'
  description: string
  /** When Scry received launch evidence, not the process's execution start. */
  observedAt: number
  stopState?: 'requested' | 'unconfirmed'
}

/** Observed Provider events, not an exhaustive task registry or process audit. */
export interface BackgroundWork {
  providerId: 'qoder'
  phase: 'working' | 'waiting' | 'inactive'
  quiet: boolean
  lastEventAt: number
  tasks: BackgroundTask[]
  coverage: 'partial'
  taskStop: 'available' | 'unavailable'
}

export type BackgroundTaskStopResult = {
  status: 'requested' | 'unavailable' | 'rejected' | 'unknown'
  message: string
}

export function latestBackgroundWork(items: readonly { backgroundWork?: BackgroundWork }[]): BackgroundWork | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].backgroundWork) return items[i].backgroundWork
  }
  return undefined
}
