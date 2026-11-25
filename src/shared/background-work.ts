export interface BackgroundTask {
  taskId: string
  toolUseId: string
  tool: 'Bash' | 'Agent'
  description: string
  observedAt: number
  stopState?: 'requested' | 'unconfirmed'
  status?: 'unconfirmed'
}

export interface BackgroundWork {
  providerId: 'qoder' | 'pi'
  phase: 'working' | 'waiting' | 'inactive'
  quiet: boolean
  lastEventAt: number
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
