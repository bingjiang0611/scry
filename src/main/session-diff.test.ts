import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_DIFF_STAGE, TURN_DIFF_STAGE, type TraceEvent, type TurnDiffSnapshot } from '../shared/trace'
import { beginGitTurnDiff, cancelGitTurnDiff, finishGitTurnDiff, previewGitTurnDiff, snapshotSessionNetDiff, type GitTurnDiffCapture } from './git'
import { appendCoalescedTrace, upsertTraceById } from './live-trace'
import { RunRegistry } from './run-registry'
import {
  DIFF_PREVIEW_MIN_INTERVAL_MS,
  RunDiffPreviewer,
  SessionDiffBaselineRegistry,
  WriteCompletionTracker,
  type DiffPreviewEvent
} from './session-diff'

const pexecFile = promisify(execFile)

// deferred：手动决定 Promise 何时 resolve，用来在测试里精确编排「运行中 → 终态」的时序，
// 不依赖真实计时器。
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

// fakeClock：now() 与 schedule() 共用一条手动推进的时间轴，用来测「节流窗口到期自动补发」
// 而不真的等 8 秒。set() 只挪时钟，advance() 挪时钟并跑掉所有到期任务。
function fakeClock() {
  let nowMs = 0
  let seq = 0
  const tasks = new Map<number, { at: number; run: () => void }>()
  return {
    now: (): number => nowMs,
    set(toMs: number): void { nowMs = toMs },
    pending: (): number => tasks.size,
    schedule(run: () => void, delayMs: number): () => void {
      const id = seq++
      tasks.set(id, { at: nowMs + delayMs, run })
      return () => { tasks.delete(id) }
    },
    advance(toMs: number): void {
      nowMs = toMs
      for (const [id, task] of [...tasks].sort((a, b) => a[1].at - b[1].at)) {
        if (task.at > nowMs) continue
        tasks.delete(id)
        task.run()
      }
    }
  }
}

const repos: string[] = []
afterEach(async () => {
  // 每个用例的临时仓库都在这里回收，绝不污染用户仓库。
  await Promise.all(repos.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-session-diff-test-'))
  repos.push(root)
  await pexecFile('git', ['init'], { cwd: root })
  await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
  await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
  return root
}

async function commit(root: string, message: string): Promise<void> {
  await pexecFile('git', ['add', '.'], { cwd: root })
  await pexecFile('git', ['commit', '-m', message], { cwd: root })
}

function fileNames(snapshot: TurnDiffSnapshot): string[] {
  return snapshot.files.map((file) => file.path.split('/').pop()!).sort()
}

describe('SessionDiffBaselineRegistry', () => {
  function fakeCapture(id: string): GitTurnDiffCapture {
    return { beforeAt: id, captureMs: 0, status: 'ready', repoRoot: '/repo', beforeTree: id }
  }

  it('同 revision + 同 session 复用「会话首轮前」原始基线（resume 不重锚）', () => {
    const created: string[] = []
    const registry = new SessionDiffBaselineRegistry(
      async () => { const c = fakeCapture(`c${created.length}`); created.push(c.beforeAt); return c },
      async () => undefined
    )
    const first = registry.ensure({ key: 'claude\0/repo', revision: 0, cwd: '/repo' })
    expect(first.origin).toBe('session_start')
    registry.bind('claude\0/repo', 0, 'ses_abc')
    // 拿到原生 session id 后的续接轮：同 revision + 同 session → 复用同一 capture。
    const second = registry.ensure({ key: 'claude\0/repo', revision: 0, cwd: '/repo', sessionId: 'ses_abc' })
    expect(second.capture).toBe(first.capture)
    expect(second.origin).toBe('session_start')
    expect(created).toHaveLength(1)
  })

  it('恢复/选择会话后进程内无基线：当场重锚并标 origin=resumed', () => {
    const registry = new SessionDiffBaselineRegistry(async () => fakeCapture('c'), async () => undefined)
    // 应用重启 / loadSession 后第一轮就带着 resume id 进来，且此前没有基线。
    const entry = registry.ensure({ key: 'claude\0/repo', revision: 0, cwd: '/repo', sessionId: 'ses_resumed' })
    expect(entry.origin).toBe('resumed')
  })

  it('revision 变化即失效重锚，绝不串会话', async () => {
    const cancelled: GitTurnDiffCapture[] = []
    let seq = 0
    const registry = new SessionDiffBaselineRegistry(
      async () => fakeCapture(`c${seq++}`),
      async (capture) => { cancelled.push(capture) }
    )
    const first = registry.ensure({ key: 'claude\0/repo', revision: 0, cwd: '/repo' })
    const second = registry.ensure({ key: 'claude\0/repo', revision: 1, cwd: '/repo' })
    expect(second.capture).not.toBe(first.capture)
    await Promise.resolve()
    expect(cancelled).toHaveLength(1) // 旧基线被取消回收
    expect(registry.get('claude\0/repo', 0)).toBeUndefined() // 旧 revision 认不回来
  })

  it('切到不同 session id 时重锚，不把别的会话净 diff 算到当前会话', () => {
    let seq = 0
    const registry = new SessionDiffBaselineRegistry(async () => fakeCapture(`c${seq++}`), async () => undefined)
    const a = registry.ensure({ key: 'claude\0/repo', revision: 0, cwd: '/repo', sessionId: 'ses_a' })
    const b = registry.ensure({ key: 'claude\0/repo', revision: 0, cwd: '/repo', sessionId: 'ses_b' })
    expect(b.capture).not.toBe(a.capture)
    expect(registry.get('claude\0/repo', 0, 'ses_a')).toBeUndefined()
  })

  it('rebind（adoptSession）跟着新 revision 走但不重锚', () => {
    let seq = 0
    const registry = new SessionDiffBaselineRegistry(async () => fakeCapture(`c${seq++}`), async () => undefined)
    const entry = registry.ensure({ key: 'claude\0/repo', revision: 0, cwd: '/repo' })
    registry.rebind('claude\0/repo', 1, 'ses_adopted')
    const same = registry.get('claude\0/repo', 1, 'ses_adopted')
    expect(same?.capture).toBe(entry.capture)
  })

  it('disposeAll 回收全部基线', async () => {
    const cancelled: GitTurnDiffCapture[] = []
    const registry = new SessionDiffBaselineRegistry(async () => fakeCapture('c'), async (c) => { cancelled.push(c) })
    registry.ensure({ key: 'a', revision: 0, cwd: '/repo' })
    registry.ensure({ key: 'b', revision: 0, cwd: '/repo' })
    registry.disposeAll()
    await Promise.resolve()
    expect(cancelled).toHaveLength(2)
  })
})

describe('RunDiffPreviewer 发布策略', () => {
  const snap = (over: Partial<TurnDiffSnapshot> = {}): TurnDiffSnapshot => ({
    version: 1, status: 'captured', files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }],
    beforeAt: 'b', afterAt: 'a', captureMs: 1, cleanup: 'ok', ...over
  })
  const readyCapture: GitTurnDiffCapture = { beforeAt: 'b', captureMs: 0, status: 'ready', beforeTree: 't' }

  it('每个 (run, scope) 用固定 id，重复发布靠 upsert 原地替换', async () => {
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: 0,
      preview: async () => snap()
    })
    await previewer.notifyChange()
    await previewer.notifyChange()
    expect(events).toHaveLength(2)
    expect(new Set(events.map((e) => e.id)).size).toBe(1) // 同一个 id
    expect(events[0].id).toBe('dp-run-1')
    expect(events[0].stage).toBe('turn_diff_preview')
  })

  it('节流：间隔内的第二次 notify 不重复采集', async () => {
    let calls = 0
    let clock = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: () => {},
      now: () => clock,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      preview: async () => { calls++; return snap() }
    })
    await previewer.notifyChange()
    clock = DIFF_PREVIEW_MIN_INTERVAL_MS - 1
    await previewer.notifyChange()
    expect(calls).toBe(1)
    clock = DIFF_PREVIEW_MIN_INTERVAL_MS
    await previewer.notifyChange()
    expect(calls).toBe(2)
  })

  it('seal 之后不再发预览：终态覆盖预览、不倒退', async () => {
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: 0,
      preview: async () => snap()
    })
    previewer.seal('turn')
    await previewer.notifyChange()
    expect(events).toHaveLength(0)
  })

  it('计算过程中被 seal：算完的预览一律丢弃', async () => {
    const events: DiffPreviewEvent[] = []
    const gate = deferred<TurnDiffSnapshot>()
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: 0,
      preview: () => gate.promise
    })
    const pending = previewer.notifyChange()
    previewer.seal('turn') // 终态在预览算完之前发布
    gate.resolve(snap())
    await pending
    expect(events).toHaveLength(0)
  })

  it('preview 返回 null（终态已接管 capture）→ 不发布', async () => {
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1', turnCapture: Promise.resolve(readyCapture), sessionCapture: null,
      hints: () => ({}), emit: (e) => events.push(e), now: () => 0, minIntervalMs: 0,
      preview: async () => null
    })
    await previewer.notifyChange()
    expect(events).toHaveLength(0)
  })

  it('只发 captured：采集失败/降级快照沉默，不发假数据', async () => {
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1', turnCapture: Promise.resolve(readyCapture), sessionCapture: null,
      hints: () => ({}), emit: (e) => events.push(e), now: () => 0, minIntervalMs: 0,
      preview: async () => snap({ status: 'failed', reason: 'git_error', files: [] })
    })
    await previewer.notifyChange()
    expect(events).toHaveLength(0)
  })

  it('session 预览带上 baseline 来源标注', async () => {
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1', turnCapture: null, sessionCapture: Promise.resolve(readyCapture),
      sessionBaselineOrigin: 'resumed',
      hints: () => ({}), emit: (e) => events.push(e), now: () => 0, minIntervalMs: 0,
      preview: async () => snap()
    })
    await previewer.notifyChange()
    expect(events).toHaveLength(1)
    expect(events[0].scope).toBe('session')
    expect(events[0].stage).toBe('session_diff_preview')
    expect(events[0].snapshot.baseline).toBe('resumed')
  })

  // trailing refresh：在途 preview 读到的是它自己开始前的工作树，期间到达的写入它看不见。
  // 没有 trailing，最后一次写就再也不会出现在预览里（旧实现直接返回在途 promise 丢掉这次 change）。
  it('在途期间到达的写入不被吞：本次算完自动补一次 trailing refresh，且穿过节流窗口', async () => {
    const events: DiffPreviewEvent[] = []
    const gate = deferred<TurnDiffSnapshot>()
    let calls = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0, // 时钟不动：普通节流窗口全程有效，trailing 必须不被它拦掉
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      preview: () => {
        calls++
        return calls === 1
          ? gate.promise
          : Promise.resolve(snap({ files: [{ path: '/repo/late.ts', added: 3, deleted: 0 }] }))
      }
    })
    const first = previewer.notifyChange()
    await Promise.resolve()
    // 首个 preview 在途时又落盘一次：必须记 pending。
    const second = previewer.notifyChange()
    gate.resolve(snap())
    await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(events).toHaveLength(2)
    expect(events.at(-1)!.snapshot.files[0].path).toBe('/repo/late.ts') // 最后一次写的状态发出去了
    expect(new Set(events.map((e) => e.id)).size).toBe(1) // 仍是固定 id 原地替换
  })

  it('在途期间多次 notify 只合并成一次 trailing：不并发、不堆积', async () => {
    const gate = deferred<TurnDiffSnapshot>()
    let calls = 0
    let concurrent = 0
    let maxConcurrent = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: () => {},
      now: () => 0,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      preview: async () => {
        calls++
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        try {
          return calls === 1 ? await gate.promise : snap()
        } finally {
          concurrent--
        }
      }
    })
    const first = previewer.notifyChange()
    await Promise.resolve()
    const rest = [previewer.notifyChange(), previewer.notifyChange(), previewer.notifyChange()]
    gate.resolve(snap())
    await Promise.all([first, ...rest])
    expect(calls).toBe(2) // 首个 + 一次合并后的 trailing
    expect(maxConcurrent).toBe(1)
  })

  it('trailing 待办时被 sealAll：链立即收尾，idle 不死等且不迟到发布', async () => {
    const events: DiffPreviewEvent[] = []
    const gate = deferred<TurnDiffSnapshot>()
    let calls = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: 0,
      preview: () => { calls++; return calls === 1 ? gate.promise : Promise.resolve(snap()) }
    })
    const first = previewer.notifyChange()
    await Promise.resolve()
    void previewer.notifyChange() // trailing 排上
    previewer.sealAll() // 终态收口
    const idle = previewer.idle()
    gate.resolve(snap())
    await Promise.all([first, idle])
    expect(calls).toBe(1) // trailing 不再执行
    expect(events).toHaveLength(0) // 在途那次算完也丢弃
  })

  // 纯节流窗口的最后一次写：首轮预览已经算完，第二次 notify 落在窗口里且之后再没有第三次通知。
  // 旧实现在这里直接 return，既不采集也不留 pending → 最后一次写永远不发布。
  it('纯节流窗口内的最后一次写：窗口到期自动补发第二次预览（无需第三次 notify）', async () => {
    const clock = fakeClock()
    const events: DiffPreviewEvent[] = []
    let calls = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: clock.now,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      schedule: clock.schedule,
      preview: async () => {
        calls++
        return snap({ files: [{ path: calls === 1 ? '/repo/first.ts' : '/repo/last.ts', added: calls, deleted: 0 }] })
      }
    })

    await previewer.notifyChange() // t=0：首轮预览发布
    expect(calls).toBe(1)

    clock.set(1_000)
    await previewer.notifyChange() // 纯节流窗口内的最后一次写
    expect(calls).toBe(1) // 当场不采集（节流仍然有效）
    expect(clock.pending()).toBe(1) // 但排了一次到期补发

    clock.advance(DIFF_PREVIEW_MIN_INTERVAL_MS) // 窗口到期，没有第三次 notify
    await previewer.idle()

    expect(calls).toBe(2)
    expect(events).toHaveLength(2)
    expect(events.at(-1)!.snapshot.files[0].path).toBe('/repo/last.ts') // 最后一次写发出去了
    expect(new Set(events.map((e) => e.id)).size).toBe(1) // 仍是固定 id 原地替换
    expect(clock.pending()).toBe(0) // 到期即摘掉，不留悬挂 timer
  })

  it('节流窗口内多次 notify 只合并成一次延迟刷新：不并发、不叠加 timer', async () => {
    const clock = fakeClock()
    let calls = 0
    let concurrent = 0
    let maxConcurrent = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: () => {},
      now: clock.now,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      schedule: clock.schedule,
      preview: async () => {
        calls++
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        try {
          return snap()
        } finally {
          concurrent--
        }
      }
    })

    await previewer.notifyChange()
    for (const at of [1_000, 2_000, 3_000, 4_000]) {
      clock.set(at)
      await previewer.notifyChange()
      expect(clock.pending()).toBe(1) // 窗口内的每次 notify 都并进同一个延迟刷新
    }
    expect(calls).toBe(1)

    clock.advance(DIFF_PREVIEW_MIN_INTERVAL_MS)
    await previewer.idle()

    expect(calls).toBe(2) // 首轮 + 一次合并后的延迟刷新
    expect(maxConcurrent).toBe(1)
  })

  it('延迟刷新到期前被 sealAll：timer 取消、之后不发布，idle 不死等', async () => {
    const clock = fakeClock()
    const events: DiffPreviewEvent[] = []
    let calls = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: clock.now,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      schedule: clock.schedule,
      preview: async () => { calls++; return snap() }
    })

    await previewer.notifyChange()
    clock.set(1_000)
    await previewer.notifyChange()
    expect(clock.pending()).toBe(1)

    previewer.sealAll() // 终态收口
    expect(clock.pending()).toBe(0) // 悬挂的延迟刷新当场取消
    await previewer.idle() // 不死等 timer

    clock.advance(DIFF_PREVIEW_MIN_INTERVAL_MS * 4)
    await previewer.idle()
    expect(calls).toBe(1) // 封口后一次都没再采集
    expect(events).toHaveLength(1)
  })

  it('窗口到期后的 notify 直接开新链：悬挂的延迟刷新不再多跑一次', async () => {
    const clock = fakeClock()
    let calls = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: () => {},
      now: clock.now,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      schedule: clock.schedule,
      preview: async () => { calls++; return snap() }
    })

    await previewer.notifyChange()
    clock.set(1_000)
    await previewer.notifyChange() // 排下延迟刷新
    expect(clock.pending()).toBe(1)

    clock.set(DIFF_PREVIEW_MIN_INTERVAL_MS) // 窗口自然到期，但 timer 还没被跑到
    await previewer.notifyChange() // 这条 notify 自己就读了最新状态
    expect(calls).toBe(2)
    expect(clock.pending()).toBe(0) // 延迟刷新被新链取代

    clock.advance(DIFF_PREVIEW_MIN_INTERVAL_MS * 4)
    await previewer.idle()
    expect(calls).toBe(2) // 没有多余采集
  })
})

// 写盘时序：结构化 write/edit 的 tool start 只代表「准备写」，Provider 的真实顺序是
// start → 真正写盘 → tool_result。预览必须挂在 tool_result 上，否则永远读到写前状态。
describe('WriteCompletionTracker 写盘时序', () => {
  it('write/edit start 本身不算落盘；对应 tool_result 到达才触发', () => {
    const tracker = new WriteCompletionTracker()
    expect(tracker.observe({ stage: 'tool:Write', toolUseId: 'w1', fileOp: 'write', filePath: '/repo/a.ts' })).toBe(false)
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'w1' })).toBe(true)
    // 同一个 toolUseId 的结果只兑付一次。
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'w1' })).toBe(false)
  })

  it('失败结果同样触发：工具报错前可能已部分写盘', () => {
    const tracker = new WriteCompletionTracker()
    tracker.observe({ stage: 'tool:Edit', toolUseId: 'e1', fileOp: 'edit', filePath: '/repo/a.ts' })
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'e1' })).toBe(true)
  })

  it('普通 read 与无对应 write/edit start 的 tool_result 都不当写入触发', () => {
    const tracker = new WriteCompletionTracker()
    expect(tracker.observe({ stage: 'tool:Read', toolUseId: 'r1', fileOp: 'read', filePath: '/repo/a.ts' })).toBe(false)
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'r1' })).toBe(false)
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'bash-1' })).toBe(false)
    expect(tracker.observe({ stage: 'tool_result' })).toBe(false)
  })

  it('结果事件自带 write/edit 足迹（codex fileChange completed）也算落盘证据', () => {
    const tracker = new WriteCompletionTracker()
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'c1', fileOp: 'edit', filePath: '/repo/a.ts' })).toBe(true)
  })

  it('多个写入交错：各自的结果各触发一次', () => {
    const tracker = new WriteCompletionTracker()
    tracker.observe({ stage: 'tool:Write', toolUseId: 'w1', fileOp: 'write', filePath: '/repo/a.ts' })
    tracker.observe({ stage: 'tool:Edit', toolUseId: 'w2', fileOp: 'edit', filePath: '/repo/b.ts' })
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'w2' })).toBe(true)
    expect(tracker.observe({ stage: 'tool_result', toolUseId: 'w1' })).toBe(true)
  })
})

// 真实 git 仓库 + deferred run：证明运行中写入可预览、终态覆盖预览、untracked 纳入、
// 预存脏改动排除，以及恢复/重启后的基线重锚语义。全部在临时仓库里自清理。
describe('会话净 diff 端到端（真实 git 仓库）', () => {
  it('运行中写入可预览；untracked 纳入；预存脏改动被排除；终态覆盖预览且不倒退', async () => {
    const root = await initRepo()
    await writeFile(join(root, 'base.ts'), 'v1\n')
    await commit(root, 'baseline')
    // 会话开始前就存在的脏改动：必须被折进基线，净 diff 里绝不出现。
    await writeFile(join(root, 'base.ts'), 'v1-dirty\n')

    const registry = new SessionDiffBaselineRegistry()
    const key = 'opencode\0' + root
    const baseline = registry.ensure({ key, revision: 0, cwd: root })
    expect(baseline.origin).toBe('session_start')

    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: null,
      sessionCapture: baseline.capture,
      sessionBaselineOrigin: baseline.origin,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: 0
    })

    // 基线必须在本轮任何写入前就位（main 用 sessionBaselineReady 保证），否则会把本轮写入误折进基线。
    const baselineCapture = await baseline.capture
    // 运行中：模型写了一个新文件（untracked）。
    await writeFile(join(root, 'feature.ts'), 'a\nb\n')
    await previewer.notifyChange()

    const preview = events.at(-1)?.snapshot
    expect(preview?.status).toBe('captured')
    expect(fileNames(preview!)).toEqual(['feature.ts']) // untracked 纳入，预存脏改动 base.ts 排除
    expect(preview!.files[0].added).toBe(2)

    // 终态：封口预览，用同一基线算净 diff。终态一发布，后续预览一律被丢弃。
    previewer.seal('session')
    const settled = await snapshotSessionNetDiff(baselineCapture)
    expect(settled.status).toBe('captured')
    expect(fileNames(settled)).toEqual(['feature.ts'])

    // 封口后再来的写入 + notify：不得再发预览（不覆盖终态、不倒退）。
    await writeFile(join(root, 'late.ts'), 'x\n')
    const before = events.length
    await previewer.notifyChange()
    expect(events.length).toBe(before)

    registry.disposeAll()
  }, 35_000)

  it('每轮 turn diff：finish 消费 capture 后，迟到的 preview 返回 null 被丢弃', async () => {
    const root = await initRepo()
    await writeFile(join(root, 'base.ts'), 'v1\n')
    await commit(root, 'baseline')

    const turnCapture = await beginGitTurnDiff(root)
    await writeFile(join(root, 'x.ts'), 'a\n')
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: Promise.resolve(turnCapture),
      sessionCapture: null,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: 0
    })
    // 先发布一版运行中预览。
    await previewer.notifyChange()
    expect(events.at(-1)?.snapshot && fileNames(events.at(-1)!.snapshot)).toEqual(['x.ts'])

    // 终态消费掉 capture（删除隔离 tempDir）。
    previewer.seal('turn')
    const terminal = await finishGitTurnDiff(turnCapture)
    expect(terminal.status).toBe('captured')

    // capture 已被消费；即使 seal 之外也不该再产出预览。
    const before = events.length
    await previewer.notifyChange()
    expect(events.length).toBe(before)
  }, 35_000)

  // OpenCode 的真实顺序：write/edit start → 真正写盘 → tool_result。
  // 预览挂在 start 上就会读到写前状态（这里会是空 files），必须等 tool_result。
  it('write/edit start 时不预览；tool_result 后预览读到的是落盘后的状态', async () => {
    const root = await initRepo()
    await writeFile(join(root, 'base.ts'), 'v1\n')
    await commit(root, 'baseline')

    const registry = new SessionDiffBaselineRegistry()
    const key = 'opencode\0' + root
    const baseline = registry.ensure({ key, revision: 0, cwd: root })
    await baseline.capture

    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: null,
      sessionCapture: baseline.capture,
      sessionBaselineOrigin: baseline.origin,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: 0
    })
    // index.ts 的 emit 门控：只有 observe() 认定「已落盘」才 notify。
    const tracker = new WriteCompletionTracker()
    const observe = async (event: Parameters<WriteCompletionTracker['observe']>[0]): Promise<void> => {
      if (tracker.observe(event)) await previewer.notifyChange()
    }

    // 1) start：文件还没写盘。
    await observe({ stage: 'tool:Write', toolUseId: 'w1', fileOp: 'write', filePath: join(root, 'feature.ts') })
    expect(events).toEqual([]) // 一条预览都不该发（旧实现会在这里发出空 files 的假预览）

    // 2) 真正写盘。
    await writeFile(join(root, 'feature.ts'), 'a\nb\n')
    // 3) tool_result 到达。
    await observe({ stage: 'tool_result', toolUseId: 'w1' })

    expect(events).toHaveLength(1)
    expect(fileNames(events[0].snapshot)).toEqual(['feature.ts'])
    expect(events[0].snapshot.files[0].added).toBe(2)

    // 无对应 write/edit start 的 read 结果不触发预览。
    await observe({ stage: 'tool:Read', toolUseId: 'r1', fileOp: 'read', filePath: join(root, 'base.ts') })
    await observe({ stage: 'tool_result', toolUseId: 'r1' })
    expect(events).toHaveLength(1)

    previewer.sealAll()
    registry.disposeAll()
  }, 35_000)

  it('首个 preview 被挂起期间第二次写盘：trailing refresh 必须发出最新 snapshot', async () => {
    const root = await initRepo()
    await writeFile(join(root, 'base.ts'), 'v1\n')
    await commit(root, 'baseline')

    const registry = new SessionDiffBaselineRegistry()
    const key = 'opencode\0' + root
    const baseline = registry.ensure({ key, revision: 0, cwd: root })
    await baseline.capture

    const gate = deferred<void>()
    let calls = 0
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: null,
      sessionCapture: baseline.capture,
      sessionBaselineOrigin: baseline.origin,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: () => 0,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS, // 节流窗口全程有效，trailing 仍必须跑
      preview: async (capture, deadlineMs, options) => {
        calls++
        if (calls === 1) await gate.promise // 挂住首个 preview
        return previewGitTurnDiff(capture, deadlineMs, options)
      }
    })

    await writeFile(join(root, 'first.ts'), 'a\n')
    const first = previewer.notifyChange()
    await Promise.resolve()
    // 首个 preview 还挂着的时候第二次写盘并 notify。
    await writeFile(join(root, 'second.ts'), 'b\nc\n')
    const second = previewer.notifyChange()
    gate.resolve()
    await Promise.all([first, second])

    expect(calls).toBe(2)
    expect(fileNames(events.at(-1)!.snapshot)).toEqual(['first.ts', 'second.ts']) // 最后一次写没被吞
    previewer.sealAll()
    registry.disposeAll()
  }, 35_000)

  it('节流窗口内的第二次写盘：窗口到期的延迟刷新读到最新工作树（无第三次 notify）', async () => {
    const root = await initRepo()
    await writeFile(join(root, 'base.ts'), 'v1\n')
    await commit(root, 'baseline')

    const registry = new SessionDiffBaselineRegistry()
    const key = 'opencode\0' + root
    const baseline = registry.ensure({ key, revision: 0, cwd: root })
    await baseline.capture

    const clock = fakeClock()
    const events: DiffPreviewEvent[] = []
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: null,
      sessionCapture: baseline.capture,
      sessionBaselineOrigin: baseline.origin,
      hints: () => ({}),
      emit: (e) => events.push(e),
      now: clock.now,
      minIntervalMs: DIFF_PREVIEW_MIN_INTERVAL_MS,
      schedule: clock.schedule
    })

    await writeFile(join(root, 'first.ts'), 'a\n')
    await previewer.notifyChange()
    expect(fileNames(events.at(-1)!.snapshot)).toEqual(['first.ts'])

    // 节流窗口内的最后一次写盘，之后再也没有 notify。
    clock.set(1_000)
    await writeFile(join(root, 'second.ts'), 'b\nc\n')
    await previewer.notifyChange()
    expect(events).toHaveLength(1) // 当场被节流

    clock.advance(DIFF_PREVIEW_MIN_INTERVAL_MS)
    await previewer.idle()

    expect(events).toHaveLength(2)
    expect(fileNames(events.at(-1)!.snapshot)).toEqual(['first.ts', 'second.ts']) // 到期读的是最新 Git 状态
    previewer.sealAll()
    registry.disposeAll()
  }, 35_000)

  it('恢复/重启后重锚：净 diff 只覆盖「自重锚以来」，不含重锚前已有的改动', async () => {
    const root = await initRepo()
    await writeFile(join(root, 'base.ts'), 'v1\n')
    await commit(root, 'baseline')
    // 模拟「上一进程会话」已经改过的文件——重启后它已在工作树里。
    await writeFile(join(root, 'earlier.ts'), 'earlier\n')

    // 新进程：registry 里没有基线，带 resume id 进来 → 重锚，earlier.ts 折进新基线。
    const registry = new SessionDiffBaselineRegistry()
    const key = 'opencode\0' + root
    const entry = registry.ensure({ key, revision: 0, cwd: root, sessionId: 'ses_resumed' })
    expect(entry.origin).toBe('resumed')
    const baselineCapture = await entry.capture

    // 重锚之后才写的文件。
    await writeFile(join(root, 'after-resume.ts'), 'new\n')
    const settled = await snapshotSessionNetDiff(baselineCapture)
    expect(fileNames(settled)).toEqual(['after-resume.ts']) // earlier.ts 不在净 diff 里

    await cancelGitTurnDiff(baselineCapture)
    registry.disposeAll()
  }, 35_000)
})

// 终态 enrichment 的 IPC 门控回归：index.ts 在 finalizeTurnDiff / finalizeSessionDiff 落
// turn_diff / session_diff 之前就把 runState.done 翻成 true，那一刻 isFocused 已是 false。
// 用 isFocused 门控发布 → 终态归档里有 captured diff，但当前 renderer 一条都收不到，
// Diff / 纵览会一直空到下一次 reload。这里用真实 RunRegistry + RunDiffPreviewer + 两侧
// trace 合并/派生代码复现 main→renderer 的完整发布路径。
describe('终态 diff enrichment 的 renderer 发布门控', () => {
  const snap = (added: number, path = '/repo/a.ts'): TurnDiffSnapshot => ({
    version: 1, status: 'captured', files: [{ path, added, deleted: 0 }],
    beforeAt: 'b', afterAt: 'a', captureMs: 1, cleanup: 'ok'
  })
  const readyCapture: GitTurnDiffCapture = { beforeAt: 'b', captureMs: 0, status: 'ready', beforeTree: 't' }

  function wire(runId: string) {
    const runs = new RunRegistry<{ runId: string; done: boolean }, { runId: string }>()
    const state = { runId, done: false }
    const items: TraceEvent[] = []
    const published: TraceEvent[] = []
    let seq = 0
    // index.ts 的运行中预览发布：固定 id upsert + isFocused 门控（预览只在运行中发）。
    const previewer = new RunDiffPreviewer({
      runId,
      turnCapture: Promise.resolve(readyCapture),
      sessionCapture: Promise.resolve(readyCapture),
      hints: () => ({}),
      now: () => 0,
      minIntervalMs: 0,
      preview: async () => snap(1),
      emit: ({ stage, id, snapshot }) => {
        const event: TraceEvent = { id, ts: 'p', runId, kind: 'harness', stage, turnDiff: snapshot }
        upsertTraceById(items, event)
        if (runs.isFocused(runId)) published.push(event)
      }
    })
    // index.ts 的终态发布：append 归档 + isViewed 门控（done 之后仍是当前显示的 run 就要推 UI）。
    const publishTerminal = (stage: string, snapshot: TurnDiffSnapshot): void => {
      const event: TraceEvent = { id: `t-${seq++}`, ts: 't', runId, kind: 'harness', stage, turnDiff: snapshot }
      appendCoalescedTrace(items, event)
      if (runs.isViewed(runId)) published.push(event)
    }
    return { runs, state, items, published, previewer, publishTerminal }
  }

  it('done 之后仍在看这个 run：终态 turn_diff / session_diff 推给 renderer 并覆盖预览', async () => {
    const w = wire('run-1')
    w.runs.register(w.state, { runId: 'run-1' })

    await w.previewer.notifyChange() // 运行中：预览先到 UI
    expect(w.published.map((event) => event.stage)).toEqual(['turn_diff_preview', 'session_diff_preview'])

    w.state.done = true // Provider 终态先翻 done，随后才落终态 diff
    w.previewer.sealAll()
    w.publishTerminal(TURN_DIFF_STAGE, snap(7))
    w.publishTerminal(SESSION_DIFF_STAGE, snap(9))

    expect(w.published.map((event) => event.stage)).toEqual([
      'turn_diff_preview', 'session_diff_preview', TURN_DIFF_STAGE, SESSION_DIFF_STAGE
    ])
    // 推给 renderer 的是终态数字，不是预览数字；预览仍是固定 id 的那一条，没有堆积。
    expect(w.published.at(-2)?.turnDiff?.files[0].added).toBe(7)
    expect(w.published.at(-1)?.turnDiff?.files[0].added).toBe(9)
    expect(w.items.map((event) => event.stage)).toEqual([
      'turn_diff_preview', 'session_diff_preview', TURN_DIFF_STAGE, SESSION_DIFF_STAGE
    ])
  })

  it('后台 run：终态只归档，不把 trace 错推给当前 UI', () => {
    const w = wire('run-bg')
    w.runs.register(w.state, { runId: 'run-bg' })
    w.runs.register({ runId: 'run-fg', done: false }, { runId: 'run-fg' }) // 焦点被新 run 顶走

    w.state.done = true
    w.publishTerminal(TURN_DIFF_STAGE, snap(7))
    w.publishTerminal(SESSION_DIFF_STAGE, snap(9))

    expect(w.published).toEqual([])
    expect(w.items.map((event) => event.stage)).toEqual([TURN_DIFF_STAGE, SESSION_DIFF_STAGE])
  })

  it('已切走会话（focusRun(null)）：终态只归档，不推给现在显示的历史会话', () => {
    const w = wire('run-1')
    w.runs.register(w.state, { runId: 'run-1' })

    w.state.done = true
    w.runs.focus(null)
    w.publishTerminal(TURN_DIFF_STAGE, snap(7))

    expect(w.published).toEqual([])
    expect(w.items.map((event) => event.stage)).toEqual([TURN_DIFF_STAGE])
    expect(w.items[0].turnDiff?.files[0].added).toBe(7) // 归档不倒退
  })
})

// 终态收口时序：index.ts 的 finalizeTurnDiff / finalizeSessionDiff / cancelTurnDiff 都必须
// 「第一次进入就 sealAll，再等全局 idle」。idle() 等的是全部 scope 的在途预览链，
// 只 seal turn 的话 session 链还会继续续 trailing：收口白等，而且迟到的预览会跨过终态边界。
describe('终态收口封口时序（finalize）', () => {
  const snap = (added: number): TurnDiffSnapshot => ({
    version: 1, status: 'captured', files: [{ path: '/repo/a.ts', added, deleted: 0 }],
    beforeAt: 'b', afterAt: 'a', captureMs: 1, cleanup: 'ok'
  })
  const readyCapture: GitTurnDiffCapture = { beforeAt: 'b', captureMs: 0, status: 'ready', beforeTree: 't' }

  function wireGated() {
    const stages: string[] = []
    const gate = deferred<void>()
    let calls = 0
    const previewer = new RunDiffPreviewer({
      runId: 'run-1',
      turnCapture: null,
      sessionCapture: Promise.resolve(readyCapture),
      hints: () => ({}),
      now: () => 0,
      minIntervalMs: 0,
      preview: async () => {
        calls++
        if (calls === 1) await gate.promise // 首个 session preview 被挂住，模拟大仓库慢采集
        return snap(1)
      },
      emit: ({ stage }) => stages.push(stage)
    })
    return {
      stages,
      gate,
      previewer,
      publishTerminal: (stage: string) => stages.push(stage),
      previewCalls: () => calls,
      // 等首个 preview 真的开始跑（而不是还排在 capture 的微任务后面），
      // 否则「在途时收口」测不到在途那一段。
      started: async () => { while (calls === 0) await Promise.resolve() }
    }
  }

  it('session preview 在途 + trailing 待办时进入终态：sealAll 后 idle 不死等，也没有预览逃逸', async () => {
    const w = wireGated()
    const inFlight = w.previewer.notifyChange()
    await w.started()
    void w.previewer.notifyChange() // 在途期间又落盘一次 → trailing 待办

    w.previewer.sealAll() // 终态第一次收口
    const idle = w.previewer.idle()
    w.gate.resolve()
    await Promise.all([inFlight, idle]) // 不死等：封口后链不再续 trailing
    w.publishTerminal(TURN_DIFF_STAGE)
    w.publishTerminal(SESSION_DIFF_STAGE)

    expect(w.previewCalls()).toBe(1) // trailing 没有跨过终态边界
    expect(w.stages).toEqual([TURN_DIFF_STAGE, SESSION_DIFF_STAGE]) // 终态之外一条预览都没有
  })

  it('根因对照：只 seal turn 时 session 链继续跑并发预览，终态边界形同虚设', async () => {
    const w = wireGated()
    const inFlight = w.previewer.notifyChange()
    await w.started()
    void w.previewer.notifyChange()

    w.previewer.seal('turn') // 旧时序
    const idle = w.previewer.idle()
    w.gate.resolve()
    await Promise.all([inFlight, idle])
    w.publishTerminal(SESSION_DIFF_STAGE)

    expect(w.previewCalls()).toBe(2) // 收口期间还在采集
    expect(w.stages.filter((stage) => stage === 'session_diff_preview')).toHaveLength(2)
    expect(w.stages.at(-1)).toBe(SESSION_DIFF_STAGE)
  })

  it('取消路径：封口后迟到的写入不再发预览，终态快照不被覆盖', async () => {
    const w = wireGated()
    const inFlight = w.previewer.notifyChange()
    await w.started()

    w.previewer.sealAll() // cancelTurnDiff 的封口
    const idle = w.previewer.idle()
    w.gate.resolve()
    await Promise.all([inFlight, idle])
    await w.previewer.notifyChange() // 取消之后迟到的写入

    expect(w.previewCalls()).toBe(1) // 在途那次算完也被丢弃
    expect(w.stages).toEqual([])
    expect(w.previewer.isSealed('turn')).toBe(true)
    expect(w.previewer.isSealed('session')).toBe(true)
  })
})
