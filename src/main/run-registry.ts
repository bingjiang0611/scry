export interface RunRegistryState {
  runId: string
  done: boolean
  providerSettled?: boolean
}

export interface RunRegistryControl {
  runId: string
}

export class RunRegistry<
  State extends RunRegistryState,
  Control extends RunRegistryControl
> {
  private readonly entries = new Map<string, { state: State; control: Control }>()
  private focusedRunId: string | null = null

  register(state: State, control: Control): void {
    if (state.runId !== control.runId) throw new Error(`runId mismatch: ${state.runId} != ${control.runId}`)
    this.entries.set(state.runId, { state, control })
    this.focusedRunId = state.runId
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

  unsettledStates(): State[] {
    return [...this.entries.values()].map(({ state }) => state).filter((state) => state.providerSettled !== true)
  }

  unsettledControls(): Control[] {
    return [...this.entries.values()].map(({ control, state }) => ({ control, state }))
      .filter(({ state }) => state.providerSettled !== true)
      .map(({ control }) => control)
  }

  focusedState(): State | null {
    if (!this.focusedRunId) return null
    const state = this.entries.get(this.focusedRunId)?.state
    return state && !state.done ? state : null
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

  remove(runId: string): void {
    this.entries.delete(runId)
    if (this.focusedRunId === runId) this.focusedRunId = null
  }
}
