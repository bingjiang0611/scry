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

it('D1: stopping a session holds its queued runs instead of letting them fire', () => {
  const queued = { ...busyRun(), runId: 'queued-run', lifecycle: 'queued' as const, queuePosition: 1 }
  const base = view()
  const withQueue = {
    ...base,
    listQueuedRuns: () => [queued as never]
  } as unknown as OrchestratorReadView
  const stop: OrchestrationCommand = {
    type: 'run.stop',
    commandId: 'cmd-stop',
    actor: PEER_A,
    scope: 'local',
    at: 2_000,
    payloadSha256: sha256Hex('stop'),
    payload: { runId: 'busy-run' }
  } as OrchestrationCommand
  const decision = decide(stop, withQueue)
  expect(decision.kind).toBe('accepted')
  if (decision.kind !== 'accepted') return
  const held = decision.events.find((event) => event.type === 'run.queue_held')
  expect(held?.runId).toBe('queued-run')
  expect(held?.payload?.heldBy).toBe('busy-run')
})


// B3 (review): a hold that changes nothing is worse than no hold — the copy promises the entry will not
// send itself. Release is its own command, and a second release is refused rather than clearing more.
it('D1: a held entry can be released, and releasing it twice is refused', () => {
  const held = { ...busyRun(), runId: 'queued-run', lifecycle: 'queued' as const, queuePosition: 1, queueHeld: true }
  const release: OrchestrationCommand = {
    type: 'run.release_queue',
    commandId: 'cmd-release',
    actor: PEER_A,
    scope: 'local',
    at: 3_000,
    payloadSha256: sha256Hex('release'),
    payload: { runId: 'queued-run' }
  } as OrchestrationCommand
  const withHeld = { ...view(), getRun: (runId: string) => (runId === 'queued-run' ? (held as never) : undefined) } as unknown as OrchestratorReadView
  const first = decide(release, withHeld)
  expect(first.kind).toBe('accepted')
  if (first.kind !== 'accepted') return
  expect(first.events.map((event) => event.type)).toEqual(['run.queue_released'])

  const released = { ...held, queueHeld: false }
  const afterRelease = { ...view(), getRun: (runId: string) => (runId === 'queued-run' ? (released as never) : undefined) } as unknown as OrchestratorReadView
  expect(decide({ ...release, commandId: 'cmd-release-2' } as OrchestrationCommand, afterRelease))
    .toMatchObject({ kind: 'rejected', reason: 'invalid_target' })

  const dispatched = { ...held, lifecycle: 'dispatched' as const }
  const notQueued = { ...view(), getRun: (runId: string) => (runId === 'queued-run' ? (dispatched as never) : undefined) } as unknown as OrchestratorReadView
  expect(decide({ ...release, commandId: 'cmd-release-3' } as OrchestrationCommand, notQueued))
    .toMatchObject({ kind: 'rejected', reason: 'illegal_transition' })
})

// D1: "用户排的队在重启后保留（不受 pending 的 60 秒 TTL 约束）". The queue entry must carry no expiry,
// because the TTL exists to void a dispatch nobody claimed — a queue may legitimately wait minutes.
it('D1: a queued submit carries no pending TTL', () => {
  const decision = decide(submit('queued-run', 'queued'), view())
  expect(decision.kind).toBe('accepted')
  if (decision.kind !== 'accepted') return
  expect(decision.effects[0]).toMatchObject({ kind: 'provider.run.start', state: 'pending', expiresAt: null })
})
