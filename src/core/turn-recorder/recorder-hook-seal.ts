import { join } from 'node:path'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import type { RecorderEnablement } from './config.js'
import { appendRotatingLog } from './io.js'
import type { RecorderHookInput } from './recorder-contracts.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import type { RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'
import { describeErrorForLog } from './store.js'

export function isLockTimeout(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKTIMEOUT'
}

export async function sealUnreadableTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  input: RecorderHookInput,
  fallbackStatus: AgentTurnRecord['status'],
  error: unknown
): Promise<void> {
  const detail = describeErrorForLog(error)
  const reason = `the previous turn's evidence could not be read (${detail}); only its lifecycle evidence is recorded`
  await appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN ${input.provider} ${open.sessionId} generation ${open.generation}: sealing on lifecycle evidence after a read failure: ${detail}`
  ).catch(() => undefined)
  try {
    await finalizeOpenTurn(enablement, open, input.payload, fallbackStatus, {
      allowUnstableTranscript: true,
      transcriptUnavailable: reason
    })
  } catch (sealError) {
    await appendRotatingLog(
      join(enablement.dataRoot, 'logs', 'recorder.log'),
      `${new Date().toISOString()} ERROR ${input.provider} ${open.sessionId} generation ${open.generation}: sealing after a read failure also failed: ${describeErrorForLog(sealError)}`
    ).catch(() => undefined)
  }
}
