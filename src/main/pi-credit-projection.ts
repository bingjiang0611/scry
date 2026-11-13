import { creditUsageEvidence, isCreditUsageEvidence, type CreditUsageEvidence } from '../shared/credit-usage'
import type { LoadedSessionTurn } from '../shared/session-history'
import type { TraceEvent } from '../shared/trace'
import { readPiCreditRequests } from './pi-credit-reader'

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
    const parsed = await readPiCreditRequests(args)
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
