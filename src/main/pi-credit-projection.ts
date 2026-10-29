import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { creditUsageEvidence, isCreditUsageEvidence, type CreditUsageEvidence } from '../shared/credit-usage'
import type { LoadedSessionTurn } from '../shared/session-history'
import type { TraceEvent } from '../shared/trace'
import { piCreditRequests } from './pi-credit-usage'
import { readPiNativeSession } from './pi-native-history'

// Larger sessions stay unavailable; add indexed/byte-offset metering before raising this read budget.
const MAX_BYTES = 64 * 1024 * 1024

// Only the adapter supplies this path, from its persisted session receipt. History
// uses the catalog-authorized default root instead; no renderer path is accepted.
async function readLiveSession(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Pi credit session is not a regular file within 64 MiB')
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw new Error('Pi credit session was truncated during read')
      offset += bytesRead
    }
    return buffer.toString('utf8')
  } finally { await file.close() }
}

export async function readPiCreditUsage(args: {
  cwd: string
  sessionId: string
  turns: Array<{ runId: string; providerTurnId?: string }>
  sessionFile?: string
  sessionRoot?: string
}): Promise<Map<string, CreditUsageEvidence>> {
  const evidence = new Map<string, CreditUsageEvidence>()
  if (!args.turns.length) return evidence
  try {
    const content = args.sessionFile ? await readLiveSession(args.sessionFile) : await readPiNativeSession({
      cwd: args.cwd, sessionId: args.sessionId,
      sessionRoot: args.sessionRoot ?? join(homedir(), '.pi', 'agent', 'sessions'), maxBytes: MAX_BYTES
    })
    if (content == null) throw new Error('Pi credit session is unavailable in the default session root')
    const parsed = piCreditRequests(content, args, args.turns)
    for (const turn of args.turns) {
      const value = creditUsageEvidence(parsed.requests.filter((request) => request.runId === turn.runId), 'pi_qoder_credit_observation')
      if (parsed.incomplete) value.omissionReason += ' Native JSONL tail is incomplete; only complete entries are covered.'
      evidence.set(turn.runId, value)
    }
  } catch (error) {
    // Metering cannot change the Provider outcome or hide an intact history page.
    for (const turn of args.turns) {
      const value = creditUsageEvidence([], 'pi_qoder_credit_observation')
      value.omissionReason += ` ${error instanceof Error ? error.message : String(error)}`
      evidence.set(turn.runId, value)
    }
  }
  return evidence
}

export async function enrichPiHistoryCredits(
  turns: LoadedSessionTurn[],
  identity: { cwd: string; sessionId: string; sessionRoot?: string }
): Promise<LoadedSessionTurn[]> {
  const pending = turns.filter((turn) => turn.runId && turn.providerTurnId &&
    !turn.items.some((event) => isCreditUsageEvidence(event.creditUsage) && event.creditUsage.value?.amount != null) &&
    turn.items.some((event) => event.upstreamProvider === 'qoder' || event.contextProvider === 'qoder' ||
      event.creditUsage?.value?.provider === 'qoder' || event.modelUsage?.some((row) => row.upstreamProvider === 'qoder')))
  const evidence = await readPiCreditUsage({
    cwd: identity.cwd, sessionId: identity.sessionId, sessionRoot: identity.sessionRoot,
    turns: pending.map((turn) => ({ runId: turn.runId!, providerTurnId: turn.providerTurnId }))
  })
  return turns.map((turn) => {
    const creditUsage = turn.runId && evidence.get(turn.runId)
    if (!creditUsage) return turn
    const id = `${turn.runId}:pi-credit-usage`
    const event: TraceEvent = {
      id, runId: turn.runId!, ts: turn.items.at(-1)!.ts,
      kind: 'harness', stage: 'credit_usage', providerId: 'pi', runtimeProvider: 'pi_rpc', creditUsage
    }
    return { ...turn, items: [...turn.items.filter((item) => item.id !== id), event] }
  })
}
