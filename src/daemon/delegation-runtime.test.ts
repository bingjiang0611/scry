import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { DaemonDelegationRuntime } from './delegation-runtime'

const PEER_A = `peer:${'a'.repeat(64)}`
const tempDirs: string[] = []
const runtimes: DaemonDelegationRuntime[] = []
const sinks: EventSink[] = []

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.close()
  while (sinks.length) sinks.pop()!.close()
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function openRuntime(opts?: {
  hasLocalSubscriber?: () => boolean
  trustFp?: () => string
  dispatchOutcome?: () => Promise<{ status: 'completed' | 'failed' | 'cancelled'; finalMessage?: { status: 'available'; quality: 'exact'; source: string[]; value: string }; reason?: string }>
}) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p6-3-runtime-'))
  tempDirs.push(dir)
  const cwd = join(dir, 'repo')
  mkdirSync(cwd, { recursive: true })
  const sink = EventSink.open({ userDataDir: dir, authorizedActors: [PEER_A], fullfsync: false, checkpointFullfsync: false })
  sinks.push(sink)

  const stopCalls: string[] = []
  const dispatched: Array<{ taskId: string; childRunId: string; prompt: string }> = []

  const runtime = new DaemonDelegationRuntime({
    sink,
    currentTrustFingerprint: () => opts?.trustFp?.() ?? 'trust-fp-v1',
    hasLocalSubscriber: opts?.hasLocalSubscriber ?? (() => true),
    requestRunStop: (runId) => { stopCalls.push(runId); return true },
    dispatchChildRun: async (input) => {
      dispatched.push({ taskId: input.task.taskId, childRunId: input.childRunId, prompt: input.prompt })
      if (opts?.dispatchOutcome) return await opts.dispatchOutcome()
      return {
        status: 'completed',
        finalMessage: { status: 'available', quality: 'exact', source: ['trace-archive'], value: '子任务分析完成' }
      }
    }
  })
  runtimes.push(runtime)
  return { dir, cwd, sink, runtime, stopCalls, dispatched }
}

function submitParentRun(sink: EventSink, cwd: string, runId = 'parent-run-1', sessionKey = 'session-parent-1') {
  const payload = {
    runId,
    sessionKey,
    provider: 'qoder',
    profile: null,
    cwd,
    promptPreview: '请委派子任务',
    claimMode: 'immediate' as const,
    dispatchImmediately: true,
    leaseOwner: 'daemon:test',
    origin: 'local' as const
  }
  const res = sink.execute({
    type: 'run.submit',
    commandId: `submit:${runId}`,
    actor: PEER_A,
    scope: 'local',
    at: 1000,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
  expect(res.kind).toBe('accepted')
  return { runId, sessionKey }
}

describe('DaemonDelegationRuntime (P6-3)', () => {
  it('omits orchestrationTools when project switch is off or no local subscriber, and issues SDK/HTTP tools when enabled', async () => {
    let localAttached = false
    const { cwd, sink, runtime } = openRuntime({ hasLocalSubscriber: () => localAttached })
    const { runId, sessionKey } = submitParentRun(sink, cwd)

    // Switch off -> no tools (still records baseline)
    const off = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd, sessionKey, permissionMode: 'default'
    })
    expect(off.orchestrationTools).toBeUndefined()
    off.cleanup()

    // Switch on, but no local subscriber -> still no tools
    expect(runtime.setProjectPolicy(PEER_A, { cwd, enabled: true }).ok).toBe(true)
    const noSub = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd, sessionKey, permissionMode: 'default'
    })
    expect(noSub.orchestrationTools).toBeUndefined()
    noSub.cleanup()

    // Local subscriber attached -> SDK tools for qoder, HTTP tools for codex, none for child run
    localAttached = true
    const qoder = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd, sessionKey, permissionMode: 'default'
    })
    expect(qoder.orchestrationTools?.kind).toBe('in_process')
    qoder.cleanup()

    const codex = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'codex', cwd, sessionKey, permissionMode: 'default'
    })
    expect(codex.orchestrationTools?.kind).toBe('codex_http')
    if (codex.orchestrationTools?.kind === 'codex_http') {
      expect(codex.orchestrationTools.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
      expect(codex.orchestrationTools.bearerToken.length).toBeGreaterThan(20)
    }
    codex.cleanup()

    // Depth-1 child run never receives orchestrationTools
    const child = await runtime.prepareRunOrchestration({
      runId: 'child-1', canonicalRunId: 'child-1', providerId: 'qoder', cwd, sessionKey: 'child-sess', permissionMode: 'default', isAgentRun: true
    })
    expect(child.orchestrationTools).toBeUndefined()
    child.cleanup()
  })

  it('runs full delegate -> confirm -> dispatch -> settle -> summary loop', async () => {
    const { cwd, sink, runtime, dispatched } = openRuntime()
    const { runId, sessionKey } = submitParentRun(sink, cwd)
    expect(runtime.setProjectPolicy(PEER_A, { cwd, enabled: true }).ok).toBe(true)

    const prepared = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd, sessionKey, permissionMode: 'default'
    })
    expect(prepared.orchestrationTools?.kind).toBe('in_process')
    if (prepared.orchestrationTools?.kind !== 'in_process') throw new Error('expected in_process')

    const req = await prepared.orchestrationTools.callTool('scry_task_delegate', {
      task: '检查构建脚本',
      title: '检查构建',
      clientRequestId: 'req-1'
    })
    expect(req).toEqual(expect.objectContaining({ ok: true }))

    const stateBefore = runtime.getState({ cwd, parentSessionKey: sessionKey })
    expect(stateBefore.projectDelegationEnabled).toBe(true)
    expect(stateBefore.tasks).toHaveLength(1)
    const task = stateBefore.tasks[0]!
    expect(task.status).toBe('awaiting_confirmation')
    expect(task.confirmationQuestionId).toBeTruthy()

    const confirmed = await runtime.confirmTask(PEER_A, {
      taskId: task.taskId,
      questionId: task.confirmationQuestionId!,
      approved: true
    })
    expect(confirmed).toEqual({ ok: true, status: 'queued' })

    // Wait for async child dispatch + settle
    await vi.waitFor(() => {
      const stateAfter = runtime.getState({ cwd, parentSessionKey: sessionKey })
      expect(stateAfter.tasks[0]?.status).toBe('completed')
      expect(stateAfter.tasks[0]?.summary?.value).toBe('子任务分析完成')
    })
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.prompt).toBe('检查构建脚本')
    prepared.cleanup()
  })

  it('rejects dispatch when repo baseline fingerprint changes before confirmation dispatch', async () => {
    let fp = 'trust-v1'
    const { cwd, sink, runtime, dispatched } = openRuntime({ trustFp: () => fp })
    const { runId, sessionKey } = submitParentRun(sink, cwd)
    runtime.setProjectPolicy(PEER_A, { cwd, enabled: true })

    const prepared = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd, sessionKey, permissionMode: 'default'
    })
    if (prepared.orchestrationTools?.kind !== 'in_process') throw new Error('expected in_process')
    await prepared.orchestrationTools.callTool('scry_task_delegate', {
      task: '敏感任务',
      clientRequestId: 'req-fp'
    })
    const task = runtime.getState({ cwd, parentSessionKey: sessionKey }).tasks[0]!

    // Mutate trust fingerprint after user run baseline was recorded
    fp = 'trust-v2-tampered'
    const confirmed = await runtime.confirmTask(PEER_A, {
      taskId: task.taskId,
      questionId: task.confirmationQuestionId!,
      approved: true
    })
    expect(confirmed.ok).toBe(false)
    expect(confirmed.status).toBe('unavailable')
    expect(dispatched).toHaveLength(0)
    expect(runtime.getState({ cwd, parentSessionKey: sessionKey }).tasks[0]?.status).toBe('unavailable')
    prepared.cleanup()
  })

  it('stops all child runs when stopSessionSubtasks is called', async () => {
    let resolveChild!: (v: { status: 'cancelled' }) => void
    const childPromise = new Promise<{ status: 'cancelled' }>((r) => { resolveChild = r })
    const { cwd, sink, runtime, stopCalls } = openRuntime({
      dispatchOutcome: () => childPromise
    })
    const { runId, sessionKey } = submitParentRun(sink, cwd)
    runtime.setProjectPolicy(PEER_A, { cwd, enabled: true })

    const prepared = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd, sessionKey, permissionMode: 'default'
    })
    if (prepared.orchestrationTools?.kind !== 'in_process') throw new Error('expected in_process')
    await prepared.orchestrationTools.callTool('scry_task_delegate', {
      task: '长跑子任务',
      clientRequestId: 'req-stop'
    })
    const task = runtime.getState({ cwd, parentSessionKey: sessionKey }).tasks[0]!
    await runtime.confirmTask(PEER_A, {
      taskId: task.taskId,
      questionId: task.confirmationQuestionId!,
      approved: true
    })

    const stopped = runtime.stopSessionSubtasks(PEER_A, { parentSessionKey: sessionKey })
    expect(stopped.ok).toBe(true)
    expect(stopCalls.length).toBe(1)
    resolveChild({ status: 'cancelled' })
    prepared.cleanup()
  })
})
