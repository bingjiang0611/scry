import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { DaemonDelegationRuntime } from './delegation-runtime'
import { computePortableMcpTrustFingerprint } from './delegation-host-wiring'
import { createDelegatedWorktreePreparer } from './delegation-worktree'

const PEER_A = `peer:${'c'.repeat(64)}`
const tempDirs: string[] = []
const runtimes: DaemonDelegationRuntime[] = []
const sinks: EventSink[] = []

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.close()
  while (sinks.length) sinks.pop()!.close()
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function initGitRepo(root: string): string {
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return realpathSync(repo)
}

function submitParent(sink: EventSink, cwd: string, runId = 'wt-parent-1', sessionKey = 'wt-sess-1') {
  const payload = {
    runId,
    sessionKey,
    provider: 'qoder',
    profile: null,
    cwd,
    promptPreview: 'delegate worktree',
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

describe('P6-4 worktree isolation for delegated tasks', () => {
  it('creates an isolated worktree, verifies content fingerprint against source baseline, and runs child in worktree cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-p6-4-wt-'))
    tempDirs.push(root)
    const userDataDir = join(root, 'userdata')
    mkdirSync(userDataDir, { recursive: true })
    const repoCwd = initGitRepo(root)

    const sink = EventSink.open({ userDataDir, authorizedActors: [PEER_A], fullfsync: false, checkpointFullfsync: false })
    sinks.push(sink)
    const { runId, sessionKey } = submitParent(sink, repoCwd)

    const seenCwds: string[] = []
    const runtime = new DaemonDelegationRuntime({
      sink,
      // B1 regression: use real `buildMcpExecutionSnapshot` via `computePortableMcpTrustFingerprint`
      currentTrustFingerprint: (provider, cwd) => computePortableMcpTrustFingerprint(provider as 'qoder', cwd, root),
      hasLocalSubscriber: () => true,
      requestRunStop: () => true,
      prepareChildWorktree: createDelegatedWorktreePreparer({ userDataDir, authorizeDirectory: (d) => d }),
      dispatchChildRun: async (input) => {
        seenCwds.push(input.executionCwd)
        return {
          status: 'completed',
          finalMessage: { status: 'available', quality: 'exact', source: ['wt-test'], value: 'worktree done' }
        }
      }
    })
    runtimes.push(runtime)
    runtime.setProjectPolicy(PEER_A, { cwd: repoCwd, enabled: true })

    const prep = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd: repoCwd, sessionKey, permissionMode: 'default', via: 'local'
    })
    if (prep.orchestrationTools?.kind !== 'in_process') throw new Error('expected in_process')

    const req = await prep.orchestrationTools.callTool('scry_task_delegate', {
      task: '在独立工作树修改文件',
      isolation: 'worktree',
      clientRequestId: 'wt-1'
    })
    expect(req).toMatchObject({ ok: true })
    const task = runtime.getState({ cwd: repoCwd, parentSessionKey: sessionKey }).tasks[0]!
    const confirmed = await runtime.confirmTask(PEER_A, {
      taskId: task.taskId,
      questionId: task.confirmationQuestionId!,
      approved: true
    })
    expect(confirmed).toEqual({ ok: true, status: 'running' })

    await vi.waitFor(() => {
      expect(runtime.getState({ cwd: repoCwd, parentSessionKey: sessionKey }).tasks[0]?.status).toBe('completed')
    })
    expect(seenCwds).toHaveLength(1)
    expect(seenCwds[0]).not.toBe(repoCwd)
    expect(existsSync(join(seenCwds[0]!, 'README.md'))).toBe(true)
    expect(sink.countNonTerminalAgentRuns()).toBe(0)
    prep.cleanup()
  })

  it('rejects worktree dispatch and cleans up when worktree repo config fingerprint diverges from source baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-p6-4-wt-tamper-'))
    tempDirs.push(root)
    const userDataDir = join(root, 'userdata')
    mkdirSync(userDataDir, { recursive: true })
    const repoCwd = initGitRepo(root)

    const sink = EventSink.open({ userDataDir, authorizedActors: [PEER_A], fullfsync: false, checkpointFullfsync: false })
    sinks.push(sink)
    const { runId, sessionKey } = submitParent(sink, repoCwd)

    const basePreparer = createDelegatedWorktreePreparer({ userDataDir, authorizeDirectory: (d) => d })
    let createdWtCwd = ''
    const runtime = new DaemonDelegationRuntime({
      sink,
      currentTrustFingerprint: () => 'fp-clean',
      hasLocalSubscriber: () => true,
      requestRunStop: () => true,
      prepareChildWorktree: async (input) => {
        const wt = await basePreparer(input)
        createdWtCwd = wt.cwd
        // Simulate tampered repo setting inside the newly created worktree
        mkdirSync(join(wt.cwd, '.qoder'), { recursive: true })
        writeFileSync(join(wt.cwd, '.qoder', 'settings.json'), JSON.stringify({ tampered: true }))
        return wt
      },
      dispatchChildRun: async () => { throw new Error('must not dispatch tampered worktree') }
    })
    runtimes.push(runtime)
    runtime.setProjectPolicy(PEER_A, { cwd: repoCwd, enabled: true })

    const prep = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd: repoCwd, sessionKey, permissionMode: 'default', via: 'local'
    })
    if (prep.orchestrationTools?.kind !== 'in_process') throw new Error('expected in_process')

    await prep.orchestrationTools.callTool('scry_task_delegate', {
      task: '被篡改的 worktree',
      isolation: 'worktree',
      clientRequestId: 'wt-tamper'
    })
    const task = runtime.getState({ cwd: repoCwd, parentSessionKey: sessionKey }).tasks[0]!
    const confirmed = await runtime.confirmTask(PEER_A, {
      taskId: task.taskId,
      questionId: task.confirmationQuestionId!,
      approved: true
    })
    expect(confirmed).toMatchObject({ ok: false, status: 'failed', reason: 'trust_gate_rejected' })
    expect(existsSync(createdWtCwd)).toBe(false)
    expect(sink.countNonTerminalAgentRuns()).toBe(0)
    prep.cleanup()
  })

  it('B4: cancels and cleans up worktree if stopSessionSubtasks arrives during async worktree preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-p6-4-wt-race-'))
    tempDirs.push(root)
    const userDataDir = join(root, 'userdata')
    mkdirSync(userDataDir, { recursive: true })
    const repoCwd = initGitRepo(root)

    const sink = EventSink.open({ userDataDir, authorizedActors: [PEER_A], fullfsync: false, checkpointFullfsync: false })
    sinks.push(sink)
    const { runId, sessionKey } = submitParent(sink, repoCwd)

    const basePreparer = createDelegatedWorktreePreparer({ userDataDir, authorizeDirectory: (d) => d })
    let releasePrep!: () => void
    const prepGate = new Promise<void>((r) => { releasePrep = r })
    let createdWtCwd = ''

    const runtime = new DaemonDelegationRuntime({
      sink,
      currentTrustFingerprint: (provider, cwd) => computePortableMcpTrustFingerprint(provider as 'qoder', cwd, root),
      hasLocalSubscriber: () => true,
      requestRunStop: () => true,
      prepareChildWorktree: async (input) => {
        const wt = await basePreparer(input)
        createdWtCwd = wt.cwd
        await prepGate
        return wt
      },
      dispatchChildRun: async () => { throw new Error('must not dispatch cancelled worktree') }
    })
    runtimes.push(runtime)
    runtime.setProjectPolicy(PEER_A, { cwd: repoCwd, enabled: true })

    const prep = await runtime.prepareRunOrchestration({
      runId, canonicalRunId: runId, providerId: 'qoder', cwd: repoCwd, sessionKey, permissionMode: 'default', via: 'local'
    })
    if (prep.orchestrationTools?.kind !== 'in_process') throw new Error('expected in_process')

    await prep.orchestrationTools.callTool('scry_task_delegate', {
      task: '准备期间被停止',
      isolation: 'worktree',
      clientRequestId: 'wt-race'
    })
    const task = runtime.getState({ cwd: repoCwd, parentSessionKey: sessionKey }).tasks[0]!
    const confirmPromise = runtime.confirmTask(PEER_A, {
      taskId: task.taskId,
      questionId: task.confirmationQuestionId!,
      approved: true
    })
    await vi.waitFor(() => { expect(createdWtCwd).not.toBe('') })
    runtime.stopSessionSubtasks(PEER_A, { parentSessionKey: sessionKey, reason: 'stop during prep' })
    releasePrep()

    const res = await confirmPromise
    expect(res).toMatchObject({ ok: false, status: 'cancelled' })
    expect(existsSync(createdWtCwd)).toBe(false)
    expect(sink.countNonTerminalAgentRuns()).toBe(0)
    prep.cleanup()
  })
})
