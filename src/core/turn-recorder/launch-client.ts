import { join } from 'node:path'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, writeJsonAtomic } from './io.js'

export const LAUNCH_CLIENT_ENV = 'SCRY_LAUNCH_CLIENT'
const LAUNCH_CLIENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export function launchClientOf(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[LAUNCH_CLIENT_ENV]?.trim()
  return raw && LAUNCH_CLIENT_PATTERN.test(raw) ? raw : undefined
}

export interface LaunchClientSource {
  schemaVersion: 1
  recordId: string
  provider: AgentTurnRecord['provider']['id']
  sessionId: string
  generation: number
  client: string
}

export function launchClientSourcePath(dataRoot: string, recordId: string): string {
  return join(dataRoot, 'local', 'launch-client', `${recordId}.json`)
}

export async function recordLaunchClientSource(dataRoot: string, source: LaunchClientSource): Promise<void> {
  try {
    await writeJsonAtomic(launchClientSourcePath(dataRoot, source.recordId), source, { sync: false })
  } catch (error) {
    await appendRotatingLog(
      join(dataRoot, 'logs', 'recorder.log'),
      `${new Date().toISOString()} WARN launch client source ${source.recordId}: ${error instanceof Error ? error.message : String(error)}`
    ).catch(() => undefined)
  }
}