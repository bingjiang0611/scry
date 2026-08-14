// 会话/单轮 Diff 的权威链路只有一条：Git snapshot capture。
// 本文件是这条链路的生命周期与发布策略层，不引入第二套 diff 状态：
//   - SessionDiffBaselineRegistry：会话净 diff 基线的存活、复用、重锚与失效，保证不串会话也不静默丢失。
//   - RunDiffPreviewer：运行中用同一批 capture 做非消费式重算，落临时预览事件；终态一发布即封口。
import {
  SESSION_DIFF_PREVIEW_STAGE,
  TURN_DIFF_PREVIEW_STAGE,
  type FileOp,
  type TurnDiffBaselineOrigin,
  type TurnDiffSnapshot
} from '../shared/trace.js'
import {
  beginGitTurnDiff,
  cancelGitTurnDiff,
  previewGitTurnDiff,
  type GitTurnDiffCapture,
  type GitTurnDiffFinishOptions
} from './git.js'

export interface SessionDiffBaseline {
  /** 创建时的 contextRevision；切换 / adopt 后不符即失效。 */
  revision: number
  /** 锚定的原生 session id；'' = 首轮还没拿到 id，等 bind 补齐。 */
  sessionId: string
  origin: TurnDiffBaselineOrigin
  capture: Promise<GitTurnDiffCapture>
}

export interface EnsureSessionBaselineInput {
  key: string
  revision: number
  cwd: string
  /** 本轮 resume 的原生 session id；缺省表示这是真正的新会话首轮。 */
  sessionId?: string
}

/**
 * 每个 (provider, cwd) 上下文一份会话净 diff 基线。
 *
 * 关键语义：`ensure` 永远返回一个可用基线。命中同 revision + 同 session 的既有基线时复用
 * 「会话第一轮开始前」的原始快照；否则（新会话 / 恢复选择会话 / 应用重启后进程内无基线 /
 * revision 已变）当场重锚并标 `origin: 'resumed'`，让上层照实说明净 diff 只覆盖「自重锚以来」。
 * 旧实现只在 `!resume` 时建基线，于是 loadSession 之后所有轮次都拿不到基线并静默不落 session_diff。
 */
export class SessionDiffBaselineRegistry {
  private readonly entries = new Map<string, SessionDiffBaseline>()

  constructor(
    private readonly begin: (cwd: string) => Promise<GitTurnDiffCapture> = beginGitTurnDiff,
    private readonly cancel: (capture: GitTurnDiffCapture) => Promise<void> = cancelGitTurnDiff
  ) {}

  ensure(input: EnsureSessionBaselineInput): SessionDiffBaseline {
    const existing = this.entries.get(input.key)
    if (existing && this.usable(existing, input.revision, input.sessionId)) {
      if (input.sessionId && !existing.sessionId) existing.sessionId = input.sessionId
      return existing
    }
    if (existing) this.discard(input.key)
    const entry: SessionDiffBaseline = {
      revision: input.revision,
      sessionId: input.sessionId ?? '',
      // 带着 resume id 进来却没有可复用基线，说明会话首轮前的基线不在本进程里，只能重锚。
      origin: input.sessionId ? 'resumed' : 'session_start',
      capture: this.begin(input.cwd)
    }
    this.entries.set(input.key, entry)
    return entry
  }

  get(key: string, revision: number, sessionId?: string): SessionDiffBaseline | undefined {
    const entry = this.entries.get(key)
    return entry && this.usable(entry, revision, sessionId) ? entry : undefined
  }

  /** 拿到原生 session id 后把基线锚死在它上面，之后别的会话再也认不走这份基线。 */
  bind(key: string, revision: number, sessionId: string): void {
    const entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || !sessionId) return
    if (!entry.sessionId) entry.sessionId = sessionId
  }

  /** adoptSession：contextRevision 被顶掉但基线仍描述同一份工作树，跟着改 revision，不重锚。 */
  rebind(key: string, revision: number, sessionId?: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.revision = revision
    if (sessionId) entry.sessionId = sessionId
  }

  discard(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    void entry.capture.then(this.cancel).catch(() => undefined)
  }

  disposeAll(): void {
    for (const key of [...this.entries.keys()]) this.discard(key)
  }

  private usable(entry: SessionDiffBaseline, revision: number, sessionId?: string): boolean {
    if (entry.revision !== revision) return false
    // 任一侧还不知道 session id 时只能靠 revision 判定；两边都知道就必须相等。
    if (!sessionId || !entry.sessionId) return true
    return entry.sessionId === sessionId
  }
}

export type DiffPreviewScope = 'turn' | 'session'

/** WriteCompletionTracker 只看 TraceEvent 的这几个字段，测试可以直接喂最小事件。 */
export interface WriteObservation {
  stage: string
  toolUseId?: string
  fileOp?: FileOp
  filePath?: string
}

/**
 * 「文件真的落盘了吗」的判定器，供运行中 Diff 预览定时序。
 *
 * 结构化 write/edit 的 tool start 只说明模型准备写：Provider 的实际顺序是
 * start → 真正写盘 → tool_result。在 start 上刷预览会读到写盘前的工作树，
 * 于是预览要么少一次改动，要么整体落后一拍。所以这里用 toolUseId 把 start 挂起，
 * 只在对应 tool_result 到达时才认为「这次写入已经结束」。
 *
 * 失败结果同样算触发：工具报错前完全可能已经写了一部分，那些字节必须进预览。
 * 反过来，普通 read 或与任何 write/edit start 无关的 tool_result 一律不算写入。
 */
export class WriteCompletionTracker {
  private readonly pendingWrites = new Set<string>()

  /** true = 这条事件证明有结构化写入已经结束，可以刷新预览。 */
  observe(event: WriteObservation): boolean {
    const write = event.fileOp === 'write' || event.fileOp === 'edit'
    if (event.stage !== 'tool_result') {
      if (write && event.filePath && event.toolUseId) this.pendingWrites.add(event.toolUseId)
      return false
    }
    if (event.toolUseId && this.pendingWrites.delete(event.toolUseId)) return true
    // Codex 的 fileChange 只在 completed 时到达一条：结果事件自带 write/edit 足迹，本身就是落盘证据。
    return write && Boolean(event.filePath)
  }
}

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
 *  2. 同一 scope 严格串行且节流；在途期间到达的新改动记成 trailing，本次算完立刻补一次最新快照
 *     （trailing 不再受节流窗口拦截，否则「最后一次写」会被永久吞掉），但永不并发、不堆积队列。
 *  3. 上一次预览已经算完、新改动落在纯节流窗口里时，把这次改动排成一次「延迟 trailing」：
 *     窗口到期自动补发一次最新快照。少了它，只要之后没有第三次 notify，最后一次写就永久不发布。
 *     窗口内多次 notify 只合并成一次，且与在途链共用同一条串行调度。
 *  4. `seal(scope)` 之后（终态即将/已经发布）永不再发预览，在途预览算完也丢弃、延迟 trailing 一并取消——
 *     终态覆盖预览，绝不倒退。
 */
export class RunDiffPreviewer {
  private readonly lastAt = new Map<DiffPreviewScope, number>()
  /** 每个 scope 至多一条串行链：链内可能连着跑多次（trailing refresh）。 */
  private readonly cycles = new Map<DiffPreviewScope, Promise<void>>()
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
    return Promise.all([this.request('turn'), this.request('session')]).then(() => undefined)
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
    if (this.sealedScopes.has(scope)) return Promise.resolve()
    const cycle = this.cycles.get(scope)
    if (cycle) {
      // 在途那次读到的是它自己开始前的工作树，这次改动它看不见 → 记 trailing，算完补一次。
      // 链内 trailing 立刻就会读到最新状态，之前排的延迟 trailing 因此多余。
      this.cancelDelay(scope)
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
      if (this.sealedScopes.has(scope)) {
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
        if (this.sealedScopes.has(scope)) break
        await this.run(scope, capture)
          .catch((error) => this.options.onError?.(scope, error))
          .finally(() => this.lastAt.set(scope, this.now()))
        // trailing 走同一条链：拿最新状态、不受节流拦截，也永不并发。
        if (!this.trailing.delete(scope)) break
      }
      // 同步收尾（不能放进 .finally）：链一结束就从 cycles 摘掉，
      // 否则后到的 notify 会把 trailing 记进一条已经跑完的链里，又把最后一次写吞掉。
      this.cycles.delete(scope)
    })()
  }

  private async run(scope: DiffPreviewScope, capture: Promise<GitTurnDiffCapture>): Promise<void> {
    const resolved = await capture
    if (resolved.status !== 'ready' || this.sealedScopes.has(scope)) return
    // 与终态同口径：turn 用本轮结构化写入做交叉证据，session 净 diff 不带（同 snapshotSessionNetDiff）。
    const snapshot = await this.preview(resolved, undefined, scope === 'turn' ? this.options.hints() : {})
    // null = 终态已接管这份 capture；sealed = 终态在本次计算期间发布过。两种情况都丢弃。
    if (!snapshot || this.sealedScopes.has(scope)) return
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
