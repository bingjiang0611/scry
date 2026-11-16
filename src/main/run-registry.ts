export interface RunRegistryState {
  runId: string
  done: boolean
  providerSettled?: boolean
  /** Provider settled but local finalization is still open; see `unsettledStates`. */
  localFinalizing?: boolean
}

export interface RunRegistryControl {
  runId: string
}

// A run that left the registry stays readable for this long, at most this many of them.
const DEPARTED_MAX_RUNS = 8
const DEPARTED_MAX_AGE_MS = 60_000

export class RunRegistry<
  State extends RunRegistryState,
  Control extends RunRegistryControl
> {
  private readonly entries = new Map<string, { state: State; control: Control }>()
  private readonly changeListeners = new Set<() => void>()
  private focusedRunId: string | null = null
  private readonly departed = new Map<string, { state: State; at: number }>()

  /**
   * 运行集合变化的最小通知：run 注册/移除，以及调用方在状态或提问变化后显式调用
   * notifyChanged()。轮询方（例如远程宿主的长轮询）据此立刻重读，不必按固定 tick 反复扫描。
   */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  notifyChanged(): void {
    for (const listener of [...this.changeListeners]) {
      try { listener() } catch { /* 通知失败不能影响 run 本身 */ }
    }
  }

  // A run started elsewhere (a paired device) must not take over what the Mac
  // UI is showing; it is observable but only focused when the user opens it.
  register(state: State, control: Control, options: { focus?: boolean } = {}): void {
    if (state.runId !== control.runId) throw new Error(`runId mismatch: ${state.runId} != ${control.runId}`)
    this.entries.set(state.runId, { state, control })
    this.departed.delete(state.runId)
    if (options.focus !== false) this.focusedRunId = state.runId
    this.notifyChanged()
  }

  get(runId: string): { state: State; control: Control } | undefined {
    return this.entries.get(runId)
  }

  activeStates(): State[] {
    return [...this.entries.values()].map(({ state }) => state).filter((state) => !state.done)
  }

  activeControls(): Control[] {
    return [...this.entries.values()].map(({ control, state }) => ({ control, state }))
      .filter(({ state }) => !state.done)
      .map(({ control }) => control)
  }

  /**
   * Runs that still own something: an unsettled Provider transport, or a Provider that
   * settled while its local finalization is still open. Admission, recovery and deletion
   * use this list, so a finalizing run keeps blocking its context even though nothing is
   * left to interrupt.
   */
  unsettledStates(): State[] {
    return [...this.entries.values()].map(({ state }) => state)
      .filter((state) => state.providerSettled !== true || state.localFinalizing === true)
  }

  /**
   * Controls that may still need to cancel something at shutdown.
   *
   * A Provider that already settled has nothing left to interrupt: interrupting it would
   * stake a stop on a transport that ended. Local finalization alone is not a cancellation
   * target, so it stays in `unsettledStates` — which fences admission and deletion — but
   * not here.
   */
  unsettledControls(): Control[] {
    return [...this.entries.values()]
      .filter(({ state }) => state.providerSettled !== true)
      .map(({ control }) => control)
  }

  focusedState(): State | null {
    if (!this.focusedRunId) return null
    const state = this.entries.get(this.focusedRunId)?.state
    return state && !state.done ? state : null
  }

  /**
   * 被聚焦 run 的权威快照，忽略 done。终态 enrichment 到 registry 移除之间仍然有效，
   * 所以 UI 已经收口但 runtime promise 还没 settle 时也能拿到完整事件序列。
   * 与 focusedState 不同：那个刻意只返回「仍在运行」的 run 供 UI 恢复运行态。
   */
  focusedSnapshot(): State | null {
    if (!this.focusedRunId) return null
    return this.entries.get(this.focusedRunId)?.state ?? null
  }

  isFocused(runId: string): boolean {
    const state = this.entries.get(runId)?.state
    return this.focusedRunId === runId && Boolean(state && !state.done)
  }

  /**
   * renderer 当前是否还在看这个 run——终态之后也算。终态 enrichment（turn_diff /
   * session_diff）是在 done=true 之后才算完的，那一刻 isFocused 已经是 false，
   * 但 registry entry 要到 runtime promise settle 才移除，焦点身份仍然有效。
   * 仍然要求它是被聚焦的那个 run：后台 run 与已切走的会话一律为 false。
   */
  isViewed(runId: string): boolean {
    return this.focusedRunId === runId && this.entries.has(runId)
  }

  focus(runId: string | null): boolean {
    if (runId == null) {
      this.focusedRunId = null
      return true
    }
    const state = this.entries.get(runId)?.state
    if (!state || state.done) return false
    this.focusedRunId = runId
    return true
  }

  /**
   * The final state of a run that recently left the registry. Not part of the live set:
   * only a reader that was told the run ended after it left asks for it. The daemon's
   * ledger records a run settled once its local finalization has removed it here, so the
   * App's read that follows `run_settled` would otherwise find no run, and lose whatever
   * the run wrote after the App's previous read (its result, usage and turn diff).
   * Bounded by count and age; past either, the reader gets no run, as before.
   */
  departedState(runId: string, now = Date.now()): State | undefined {
    this.pruneDeparted(now)
    return this.departed.get(runId)?.state
  }

  private pruneDeparted(now: number): void {
    for (const [runId, entry] of this.departed) {
      if (this.departed.size <= DEPARTED_MAX_RUNS && now - entry.at < DEPARTED_MAX_AGE_MS) break
      this.departed.delete(runId)
    }
  }

  remove(runId: string, now = Date.now()): void {
    const entry = this.entries.get(runId)
    this.entries.delete(runId)
    if (entry) {
      this.departed.delete(runId)
      this.departed.set(runId, { state: entry.state, at: now })
      this.pruneDeparted(now)
    }
    if (this.focusedRunId === runId) this.focusedRunId = null
    this.notifyChanged()
  }
}
