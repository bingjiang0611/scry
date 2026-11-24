import { expect, it } from 'vitest'
import { sha256Hex } from './canonical-json'
import { decide, type OrchestrationCommand, type OrchestratorReadView } from './orchestrator'

const PEER_A = `peer:${'a'.repeat(64)}`
const SESSION = 'session-queued'

function busyRun() {
  return {
    runId: 'busy-run',
    sessionKey: SESSION,
    ownerActor: PEER_A,
    scope: 'local',
    origin: 'local',
    provider: 'claude',
    profile: 'default',
    cwd: '/tmp/ws',
    promptPreview: 'busy',
    lifecycle: 'dispatched',
    stopState: null,
    outputSeq: 0,
    intentSeq: 1,
    body: null,
    settledAt: null,
    recoveredAt: null,
    outcome: null,
    revSeq: 2,
    parentRunId: null
  }
}

function submit(runId: string, claimMode: 'immediate' | 'queued'): OrchestrationCommand {
  const text = `prompt ${runId}`
  return {
    type: 'run.submit',
    commandId: `cmd-${runId}`,
    actor: PEER_A,
    scope: 'local',
    at: 1_000,
    payloadSha256: sha256Hex(text),
    payload: {
      runId,
      sessionKey: SESSION,
      provider: 'claude',
      profile: 'default',
      cwd: '/tmp/ws',
      promptPreview: text,
      body: { storage: 'inline' as const, sha256: sha256Hex(text), bytes: text.length, inline: text },
      claimMode,
      leaseOwner: 'daemon-1'
    }
  } as OrchestrationCommand
}

function view(): OrchestratorReadView {
  const runs = new Map([['busy-run', busyRun() as never]])
  return {
    isActorAuthorized: () => true,
    getReceipt: () => undefined,
    getRun: (runId: string) => runs.get(runId),
    getSession: () => undefined,
    getInteraction: () => undefined,
    listNonTerminalChildRuns: () => [],
    listNonTerminalChildRunsBySession: () => [],
    nextQueuePosition: () => 1,
    hasActiveRunForSession: () => true,
    activeRunCount: () => 0,
    maxActiveRuns: () => 4,
    isProviderAuthenticating: () => false
  } as unknown as OrchestratorReadView
}

it('D1: a queued submit waits behind the live run instead of being rejected', () => {
  const decision = decide(submit('queued-run', 'queued'), view())
  expect(decision.kind).toBe('accepted')
  if (decision.kind !== 'accepted') return
  const queued = decision.events.find((event) => event.type === 'run.queued')
  expect(queued?.payload?.queuePosition).toBe(1)
  expect(decision.events.filter((event) => event.type === 'run.dispatched')).toHaveLength(0)
})

it('D1: a plain submit while the session is busy still returns session_run_active', () => {
  const decision = decide(submit('immediate-run', 'immediate'), view())
  expect(decision).toMatchObject({ kind: 'rejected', reason: 'session_run_active' })
})
