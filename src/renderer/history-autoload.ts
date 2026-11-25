export const HISTORY_AUTOLOAD_THRESHOLD_PX = 320

export interface HistoryAutoloadState {
  scrollTop: number
  hasOlder: boolean
  loading: boolean
  viewportShort: boolean
}

export function shouldLoadOlder({ hasOlder, loading, scrollTop, viewportShort }: HistoryAutoloadState): boolean {
  if (!hasOlder || loading) return false
  return viewportShort || scrollTop <= HISTORY_AUTOLOAD_THRESHOLD_PX
}

export interface FillRetryState {
  pendingTurns: number | null
  blockedTurns: number | null
}

export const initialFillRetryState: FillRetryState = { pendingTurns: null, blockedTurns: null }

export function settleFillRetry(state: FillRetryState, turnsLength: number, loading: boolean): FillRetryState {
  if (state.pendingTurns == null || loading) return state
  return turnsLength === state.pendingTurns
    ? { pendingTurns: null, blockedTurns: state.pendingTurns }
    : { pendingTurns: null, blockedTurns: null }
}

export function canFill(state: FillRetryState, turnsLength: number): boolean {
  return state.pendingTurns == null && state.blockedTurns !== turnsLength
}

export function isViewportShort(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight <= clientHeight + HISTORY_AUTOLOAD_THRESHOLD_PX
}
