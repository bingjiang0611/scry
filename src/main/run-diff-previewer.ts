import { SESSION_DIFF_PREVIEW_STAGE, TURN_DIFF_PREVIEW_STAGE, type TurnDiffSnapshot, type TurnDiffBaselineOrigin } from '../shared/trace.js'
import { previewGitTurnDiff, type GitTurnDiffCapture, type GitTurnDiffFinishOptions } from './git.js'
import type { DiffPreviewScope } from './session-diff.js'

// 预览要花一次 git status + write-tree + patch。长轮次里节流到这个间隔，
// 既保证「运行中打开 Diff 有东西看」，也不至于把大仓库刷爆。
export const DIFF_PREVIEW_MIN_INTERVAL_MS = 8_000

export interface DiffPreviewEvent {
  scope: DiffPreviewScope
  stage: string
  /** 每个 (run, scope) 固定一个 id：重复发布按 id 原地替换，不会越积越多。 */
  id: string
  snapshot: TurnDiffSnapshot
}

export interface RunDiffPreviewerOptions {
  runId: string
  /** 本轮 capture（beginGitTurnDiff 的结果，终态由 finishGitTurnDiff 消费）。 */
  turnCapture: Promise<GitTurnDiffCapture> | null
  /** 贯穿会话的净 diff 基线 capture。 */
  sessionCapture: Promise<GitTurnDiffCapture> | null
  sessionBaselineOrigin?: TurnDiffBaselineOrigin
  /** 本轮结构化写入路径，作为 targeted 采集的交叉证据；与终态保持一致的口径。 */
  hints: () => GitTurnDiffFinishOptions
  emit: (event: DiffPreviewEvent) => void
  now?: () => number
  minIntervalMs?: number
  preview?: (
    capture: GitTurnDiffCapture,
    deadlineMs?: number,
    options?: GitTurnDiffFinishOptions
  ) => Promise<TurnDiffSnapshot | null>
  /** 注入定时器（返回取消函数）；测试用可控时钟，生产用 setTimeout。 */
  schedule?: (run: () => void, delayMs: number) => () => void
  onError?: (scope: DiffPreviewScope, error: unknown) => void
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  // 悬挂的预览定时器不该拖住进程退出。
  timer.unref?.()
  return () => clearTimeout(timer)
}

/**
 * 运行中 Diff 预览的发布策略。三条硬规则：
 *  1. 只发 `status === 'captured'` 的 Git 真实快照，采集失败就沉默——不发假降级、不拿工具足迹凑数。
 *  2. 同一 scope 严格串行且节流；在途期间到达的新改动记成 trailing，本次算完等待节流窗口后
 *     补一次最新快照，避免持续写入让 Git 采集保持高占空比，同时永不并发、不堆积队列。
 *  3. 上一次预览已经算完、新改动落在纯节流窗口里时，把这次改动排成一次「延迟 trailing」：
 *     窗口到期自动补发一次最新快照。少了它，只要之后没有第三次 notify，最后一次写就永久不发布。
 *     窗口内多次 notify 只合并成一次，且与在途链共用同一条串行调度。
 *  4. `seal(scope)` 之后（终态即将/已经发布）永不再发预览，在途预览算完也丢弃、延迟 trailing 一并取消——
 *     终态覆盖预览，绝不倒退。
 */
export class RunDiffPreviewer {
  private demanded = true
  private demandEpoch = 0
  private hasObservedChange = false
  private readonly lastAt = new Map<DiffPreviewScope, number>()
  /** 每个 scope 至多一条串行链：链内可能连着跑多次（trailing refresh）。 */
  private readonly cycles = new Map<DiffPreviewScope, Promise<void>>()
  private readonly reads = new Map<NonNullable<GitTurnDiffCapture['sharedStorage']>, {
    key: string
    scope: DiffPreviewScope
    promise: Promise<TurnDiffSnapshot | null>
  }>()
  private readonly trailing = new Set<DiffPreviewScope>()
  /** 每个 scope 至多一个待到期的延迟 trailing；settled 让 idle() 能等到它收敛。 */
  private readonly delays = new Map<DiffPreviewScope, { cancel: () => void; settled: Promise<void>; settle: () => void }>()
  private readonly sealedScopes = new Set<DiffPreviewScope>()
  private readonly now: () => number
  private readonly minIntervalMs: number
  private readonly preview: NonNullable<RunDiffPreviewerOptions['preview']>
  private readonly schedule: NonNullable<RunDiffPreviewerOptions['schedule']>

  constructor(private readonly options: RunDiffPreviewerOptions) {
    this.now = options.now ?? Date.now
    this.minIntervalMs = options.minIntervalMs ?? DIFF_PREVIEW_MIN_INTERVAL_MS
    this.preview = options.preview ?? previewGitTurnDiff
    this.schedule = options.schedule ?? defaultSchedule
  }

  previewStage(scope: DiffPreviewScope): string {
    return scope === 'turn' ? TURN_DIFF_PREVIEW_STAGE : SESSION_DIFF_PREVIEW_STAGE
  }

  previewId(scope: DiffPreviewScope): string {
    return `${scope === 'turn' ? 'dp' : 'sp'}-${this.options.runId}`
  }

  /**
   * 观测到本轮结构化写入已落盘时调用。返回的 promise 覆盖整条串行链（含 trailing refresh），
   * 便于测试确定性等待「最后一次写也发出去了」。
   */
  notifyChange(): Promise<void> {
    this.hasObservedChange = true
    return Promise.all([this.request('turn'), this.request('session')]).then(() => undefined)
  }

  /** Pause only live previews. Final capture owns its separate, unchanged lifecycle. */
  setDemanded(demanded: boolean): Promise<void> {
    if (this.demanded === demanded) return Promise.resolve()
    this.demanded = demanded
    this.demandEpoch++
    this.trailing.clear()
    this.lastAt.clear()
    this.cancelDelay('turn')
    this.cancelDelay('session')
    // A returning viewer must not wait for the old eight-second throttle. An old
    // in-flight read retains its ownership, but cannot publish into the new epoch.
    return demanded && this.hasObservedChange ? this.notifyChange() : Promise.resolve()
  }

  /** 终态发布前封口该 scope。 */
  seal(scope: DiffPreviewScope): void {
    this.sealedScopes.add(scope)
    // 悬挂的延迟 trailing 必须当场取消：封口后不发布，idle() 也不该等它到期。
    this.cancelDelay(scope)
  }

  sealAll(): void {
    this.seal('turn')
    this.seal('session')
  }

  isSealed(scope: DiffPreviewScope): boolean {
    return this.sealedScopes.has(scope)
  }

  /**
   * 等待在途预览链收敛（终态收口与测试用）。等的是整条链而不是单次预览，
   * 否则 trailing refresh 会绕到终态之后去动已被消费的 capture。
   * 待到期的延迟 trailing 也算在途：不等它，收口后它照样会补发一次预览。
   * 调用方必须先 sealAll()：封口后 request() 直接返回、延迟 trailing 已被取消，这个循环才有终点。
   */
  async idle(): Promise<void> {
    while (this.cycles.size > 0 || this.delays.size > 0) {
      await Promise.all([
        ...this.cycles.values(),
        ...[...this.delays.values()].map((delay) => delay.settled)
      ])
    }
  }

  private request(scope: DiffPreviewScope): Promise<void> {
    if (!this.demanded || this.sealedScopes.has(scope)) return Promise.resolve()
    const cycle = this.cycles.get(scope)
    if (cycle) {
      // 在途采集或节流等待期间的新改动合并进同一个 trailing 标记；不要取消等待，
      // 否则持续写入会反复绕过 minIntervalMs。
      this.trailing.add(scope)
      return cycle
    }
    const last = this.lastAt.get(scope)
    if (last != null) {
      const elapsed = this.now() - last
      // 纯节流窗口：上一次已经算完，这次改动没人接手。直接返回等于永久吞掉「最后一次写」
      // （之后可能再也没有 notify），所以排一次到期自动补发的延迟 trailing。
      if (elapsed < this.minIntervalMs) {
        this.scheduleDelayedTrailing(scope, this.minIntervalMs - elapsed)
        return Promise.resolve()
      }
    }
    return this.startCycle(scope) ?? Promise.resolve()
  }

  /** 立即开一条新链；capture 缺失返回 null。调用前已确认该 scope 没有在途链。 */
  private startCycle(scope: DiffPreviewScope): Promise<void> | null {
    const capture = scope === 'turn' ? this.options.turnCapture : this.options.sessionCapture
    if (!capture) return null
    // 这条新链读到的就是最新状态，先前排的延迟 trailing 没必要再跑。
    this.cancelDelay(scope)
    const started = this.cycle(scope, capture)
    this.cycles.set(scope, started)
    return started
  }

  /** 节流窗口内的改动合并成一次延迟刷新：已有待到期的就直接复用，不叠加。 */
  private scheduleDelayedTrailing(scope: DiffPreviewScope, delayMs: number): void {
    if (this.delays.has(scope)) return
    const capture = scope === 'turn' ? this.options.turnCapture : this.options.sessionCapture
    if (!capture) return
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const cancel = this.schedule(() => {
      this.delays.delete(scope)
      if (!this.demanded || this.sealedScopes.has(scope)) {
        settle()
        return
      }
      // 到期时串入该 scope 同一条调度链：有在途链就记 trailing，没有就自己开一条。
      const inFlight = this.cycles.get(scope)
      if (inFlight) {
        this.trailing.add(scope)
        void inFlight.then(settle, settle)
        return
      }
      const started = this.startCycle(scope)
      if (!started) {
        settle()
        return
      }
      void started.then(settle, settle)
    }, Math.max(0, delayMs))
    this.delays.set(scope, { cancel, settled, settle })
  }

  private waitForInterval(scope: DiffPreviewScope, delayMs: number): Promise<void> {
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const cancel = this.schedule(() => {
      this.delays.delete(scope)
      settle()
    }, Math.max(0, delayMs))
    this.delays.set(scope, { cancel, settled, settle })
    return settled
  }

  private cancelDelay(scope: DiffPreviewScope): void {
    const delay = this.delays.get(scope)
    if (!delay) return
    this.delays.delete(scope)
    delay.cancel()
    delay.settle()
  }

  private cycle(scope: DiffPreviewScope, capture: Promise<GitTurnDiffCapture>): Promise<void> {
    return (async () => {
      this.trailing.delete(scope)
      for (;;) {
        if (!this.demanded || this.sealedScopes.has(scope)) break
        const epoch = this.demandEpoch
        await this.run(scope, capture, epoch)
          .catch((error) => this.options.onError?.(scope, error))
          .finally(() => { if (epoch === this.demandEpoch) this.lastAt.set(scope, this.now()) })
        if (!this.trailing.delete(scope)) break
        const last = this.lastAt.get(scope)
        const remaining = last == null ? 0 : this.minIntervalMs - (this.now() - last)
        if (remaining > 0) await this.waitForInterval(scope, remaining)
        // Notifications accumulated during the wait are represented by the one capture about to run.
        this.trailing.delete(scope)
      }
      // 同步收尾（不能放进 .finally）：链一结束就从 cycles 摘掉，
      // 否则后到的 notify 会把 trailing 记进一条已经跑完的链里，又把最后一次写吞掉。
      this.cycles.delete(scope)
    })()
  }

  private async readSnapshot(scope: DiffPreviewScope, capture: GitTurnDiffCapture, options: GitTurnDiffFinishOptions): Promise<TurnDiffSnapshot | null> {
    const storage = capture.sharedStorage
    if (!storage || capture.status !== 'ready' || !capture.tempDir) return this.preview(capture, undefined, options)
    // First-turn captures clone one immutable baseline. Share only an ongoing read;
    // later writes must read again. Structured paths are discovery hints, not a file filter.
    const key = JSON.stringify([
      capture.repoRoot, capture.scope, capture.beforeTree, capture.requestedRoot,
      [...(capture.pathspec ?? [capture.scope])].sort(), [...(capture.excludedPaths ?? [])].sort(),
      [...(options.patchExcludeBasenames ?? [])].sort(), options.forceFull === true,
      options.completePatches === true, options.workspaceSnapshot === true
    ])
    let read = this.reads.get(storage)
    if (!read || read.key !== key) {
      read = { key, scope, promise: this.preview(capture, undefined, options) }
      this.reads.set(storage, read)
    }
    try {
      const snapshot = await read.promise
      if (!snapshot || capture.sharedStorage !== storage || capture.finishPromise) return null
      // No scratch/index ownership is shared. Each publisher gets its own plain DTO.
      const result = structuredClone(snapshot)
      result.beforeAt = capture.beforeAt
      if (scope === 'session' && read.scope === 'turn' && result.collection) result.collection.sharedAfter = 'turn'
      return result
    } finally {
      if (this.reads.get(storage) === read) this.reads.delete(storage)
    }
  }

  private async run(scope: DiffPreviewScope, capture: Promise<GitTurnDiffCapture>, epoch: number): Promise<void> {
    const resolved = await capture
    if (resolved.status !== 'ready' || !this.demanded || epoch !== this.demandEpoch || this.sealedScopes.has(scope)) return
    // 保留两种 scope 的采集策略；同一首轮基线可以复用在途读取，不缓存已完成的预览。
    const snapshot = await this.readSnapshot(scope, resolved, scope === 'turn' ? this.options.hints() : {})
    // null = 终态已接管这份 capture；sealed = 终态在本次计算期间发布过。两种情况都丢弃。
    if (!snapshot || !this.demanded || epoch !== this.demandEpoch || this.sealedScopes.has(scope)) return
    if (snapshot.status !== 'captured') return
    this.options.emit({
      scope,
      stage: this.previewStage(scope),
      id: this.previewId(scope),
      snapshot:
        scope === 'session' && this.options.sessionBaselineOrigin
          ? { ...snapshot, baseline: this.options.sessionBaselineOrigin }
          : snapshot
    })
  }
}
