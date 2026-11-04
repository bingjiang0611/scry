import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_DIFF_STAGE, TURN_DIFF_STAGE, type ActiveRun, type TraceEvent } from '../../shared/trace'
import { normalizeTurnDiffSnapshot } from '../../shared/turn-diff'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { beginGitTurnDiff, cloneGitTurnDiffCapture } from '../git'
import { appendCoalescedTrace } from '../live-trace'
import { RunDiffPreviewer, SessionDiffBaselineRegistry } from '../session-diff'
import { WorkspaceOverlapTracker } from '../workspace-overlap'
import { createRunDiffLifecycle } from './run-diff'

const pexecFile = promisify(execFile)
const repos: string[] = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-overlap-diff-'))
  repos.push(root)
  await pexecFile('git', ['init'], { cwd: root })
  await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
  await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
  await writeFile(join(root, 'README.md'), 'baseline\n')
  await pexecFile('git', ['add', '.'], { cwd: root })
  await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
  return root
}

interface Harness {
  runId: string
  runState: ActiveRun
  baselines: SessionDiffBaselineRegistry
  key: string
  finalize: () => Promise<void>
  /** 走 legacy/scoped 发布的终态事件（用于确认终态 diff 仍会被投递）。 */
  published: TraceEvent[]
}

/** 生产 diff 生命周期 + 真实 Git 仓库；Provider 只由 runState 代表，不启动 adapter。 */
async function harness(cwd: string, runId: string, observe: boolean,
  before?: (baselines: SessionDiffBaselineRegistry) => void): Promise<Harness> {
  // 单调递增的观测时钟：每次观测/采集都晚于上一次，避免同一毫秒掩盖先后关系。
  const time = { value: 1_000 }
  const baselines = new SessionDiffBaselineRegistry(undefined, undefined,
    new WorkspaceOverlapTracker(() => (time.value += 1)))
  const key = JSON.stringify(['overlap', runId])
  const published: TraceEvent[] = []
  const runState: ActiveRun = { runId, providerId: 'claude', cwd, userText: runId, items: [], done: true, providerSettled: true }
  await writeFile(join(cwd, 'baseline-marker.txt'), 'unchanged\n')
  await pexecFile('git', ['add', '.'], { cwd })
  await pexecFile('git', ['commit', '-m', 'marker'], { cwd })
  // 先让兄弟 run 在这轮基线之前开始（并可先采集一次中间证据），再观测本轮。
  before?.(baselines)
  if (observe) baselines.observeRunWorkspace(runId, cwd)
  // 基线必须在任何写入落盘前完成采集，否则本轮改动会被折进 before 快照。
  const turnBaseline = await beginGitTurnDiff(cwd)
  const baseline = baselines.ensure({ key, revision: 0, cwd, initialCapture: Promise.resolve(turnBaseline) })
  await baseline.capture
  // 生产里 turn 与 session 复用同一时刻的基线，但各有独立清理周期。
  const turnCapture = Promise.resolve(cloneGitTurnDiffCapture(turnBaseline))
  const lifecycle = createRunDiffLifecycle({
    isRemoteRun: false,
    diffPreviewer: new RunDiffPreviewer({
      runId,
      turnCapture,
      sessionCapture: baseline.capture,
      hints: () => ({}),
      emit: () => undefined
    }),
    turnDiffCapture: turnCapture,
    turnChangeJournal: null,
    patchExcludeBasenames: [],
    cwd,
    contextKey: 'context',
    runId,
    providerId: 'claude',
    runtimeProvider: 'claude_sdk',
    runState,
    sessionDiffBaselines: baselines,
    getDiffContextKey: () => key,
    getObservedSessionId: () => undefined,
    getResume: () => undefined,
    getContextRevision: () => 0,
    mainEventId: (prefix, id) => `${prefix}-${id}`,
    appendCoalescedTrace,
    publishTrace: (event) => published.push(event)
  })
  return {
    runId, runState, baselines, key, published,
    finalize: async () => {
      await lifecycle.finalizeTurnDiff()
      await lifecycle.finalizeSessionDiff()
    }
  }
}

const diffEvent = (runState: ActiveRun, stage: string): TraceEvent => {
  const event = runState.items.find((item) => item.stage === stage)
  if (!event) throw new Error(`missing ${stage} event`)
  return event
}

describe('parallel workspace diff evidence', () => {
  it('records overlapping runs on the turn and session snapshots it actually publishes', async () => {
    const cwd = await initRepo()
    const current = await harness(cwd, 'run-main', true)
    // 兄弟在本轮基线观测期间启动并写入自己的工作区改动。
    current.baselines.observeRunWorkspace('run-sibling', cwd)
    await writeFile(join(cwd, 'main.txt'), 'main\n')
    await writeFile(join(cwd, 'sibling.txt'), 'sibling\n')
    await current.finalize()

    const turnDiff = diffEvent(current.runState, TURN_DIFF_STAGE).turnDiff
    const sessionDiff = diffEvent(current.runState, SESSION_DIFF_STAGE).turnDiff
    expect(turnDiff?.status).toBe('captured')
    expect(sessionDiff?.status).toBe('captured')
    expect(turnDiff?.workspaceOverlap).toMatchObject({ coverage: 'observed', runIds: ['run-sibling'] })
    expect(sessionDiff?.workspaceOverlap).toMatchObject({ coverage: 'observed', runIds: ['run-sibling'] })
    // 两个文件都在同一次采集里：证据只能说「重叠」，不能把文件归给某一个 run。
    expect(turnDiff?.files.map((file) => file.path.split('/').pop()).sort()).toEqual(['main.txt', 'sibling.txt'])

    // 归档读取路径（normalize）保留证据；缺失字段仍然表示未观测。
    expect(normalizeTurnDiffSnapshot(turnDiff)?.workspaceOverlap).toEqual(turnDiff?.workspaceOverlap)
    // .scry 记录投影（aggregate）保留证据。
    const record = aggregateTurnEvidence({ events: current.runState.items })
    expect(record.diff.value?.find((diff) => diff.workspaceOverlap)).toMatchObject({
      workspaceOverlap: { runIds: ['run-sibling'] }
    })

    // run 收口后不再声称仍在观测。
    current.baselines.releaseRunWorkspace('run-main')
    expect(current.baselines.workspaceOverlap('run-main')).toBeUndefined()
    // 终态 diff 是 done=true 之后才算完的：它必须仍被投递（legacy 焦点通道与 scoped 流各自一份）。
    expect(current.published.map((event) => event.stage)).toEqual(expect.arrayContaining([TURN_DIFF_STAGE, SESSION_DIFF_STAGE]))
  })

  it('still reports a sibling that captured intermediate evidence and is still running', async () => {
    const cwd = await initRepo()
    // 兄弟先开始、并在本轮基线之前采集过一次中间证据，但它没有收口。
    const current = await harness(cwd, 'run-main', true, (baselines) => {
      baselines.observeRunWorkspace('run-sibling', cwd)
      baselines.workspaceOverlap('run-sibling')
    })
    await writeFile(join(cwd, 'main.txt'), 'main\n')
    await writeFile(join(cwd, 'sibling.txt'), 'sibling\n')
    await current.finalize()
    const turnDiff = diffEvent(current.runState, TURN_DIFF_STAGE).turnDiff
    expect(turnDiff?.workspaceOverlap).toMatchObject({ coverage: 'observed', runIds: ['run-sibling'] })
    // 兄弟真正收口之后才结算窗口末端，此后的 run 不再与它重叠。
    current.baselines.releaseRunWorkspace('run-sibling')
    current.baselines.releaseRunWorkspace('run-main')
    current.baselines.observeRunWorkspace('run-after', cwd)
    expect(current.baselines.workspaceOverlap('run-after')?.runIds).toEqual([])
  })

  it('leaves old or unobserved captures without the field instead of claiming exclusivity', async () => {
    const cwd = await initRepo()
    const current = await harness(cwd, 'run-standalone', false)
    await writeFile(join(cwd, 'only.txt'), 'only\n')
    await current.finalize()
    const turnDiff = diffEvent(current.runState, TURN_DIFF_STAGE).turnDiff
    expect(turnDiff?.status).toBe('captured')
    expect(turnDiff && 'workspaceOverlap' in turnDiff).toBe(false)
    expect(normalizeTurnDiffSnapshot(turnDiff)?.workspaceOverlap).toBeUndefined()
  })

  it('keeps an unobserved/partial capture honest through the record projection', () => {
    const resolved = { version: 1 as const, status: 'captured' as const, files: [], beforeAt: '2026-01-01T00:00:00.000Z',
      afterAt: '2026-01-01T00:00:01.000Z', captureMs: 1, cleanup: 'ok' as const }
    const record = aggregateTurnEvidence({ events: [{
      id: 'session-diff', ts: '2026-01-01T00:00:01.000Z', runId: 'run-1', kind: 'harness', stage: SESSION_DIFF_STAGE,
      providerId: 'claude', runtimeProvider: 'claude_sdk',
      turnDiff: { ...resolved, workspaceOverlap: { coverage: 'partial', runIds: ['run-2'], truncated: true,
        observedFrom: '2026-01-01T00:00:00.000Z', observedTo: '2026-01-01T00:00:01.000Z' } }
    }] })
    expect(record.diff.value?.[0].workspaceOverlap).toMatchObject({ coverage: 'partial', truncated: true })
    // 伪造/畸形证据不能变成「观察过」。
    const forged = normalizeTurnDiffSnapshot({ ...resolved, workspaceOverlap: { coverage: 'exclusive', runIds: [] } })
    expect(forged?.workspaceOverlap).toBeUndefined()
  })
})
