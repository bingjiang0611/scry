export interface RunRegistryState {
  runId: string
  done: boolean
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

  focusedState(): State | null {
    if (!this.focusedRunId) return null
    const state = this.entries.get(this.focusedRunId)?.state
    return state && !state.done ? state : null
  }

  isFocused(runId: string): boolean {
    const state = this.entries.get(runId)?.state
    return this.focusedRunId === runId && Boolean(state && !state.done)
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
