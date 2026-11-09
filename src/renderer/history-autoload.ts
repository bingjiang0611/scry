/**
 * 时间线自动续读的判定。
 *
 * 预取距离而不是“看到底才取”：用户滚到离顶部还有 320px 时就开始取上一页，
 * 等真正到边界时内容通常已经就位。是否真的能取仍由历史窗口与在途请求决定。
 */
export const HISTORY_AUTOLOAD_THRESHOLD_PX = 320

export interface HistoryAutoloadState {
  scrollTop: number
  hasOlder: boolean
  loading: boolean
  /** 内容不足一屏时没有滚动事件，需要主动补一页。 */
  viewportShort: boolean
}

export function shouldLoadOlder({ hasOlder, loading, scrollTop, viewportShort }: HistoryAutoloadState): boolean {
  // 没有更早轮次，或已有一页在途：不重复请求。
  if (!hasOlder || loading) return false
  return viewportShort || scrollTop <= HISTORY_AUTOLOAD_THRESHOLD_PX
}

/** 主动补页的状态：在途请求对应的轮次数量，以及上一次补页失败（没有新增轮次）时的轮次数量。 */
export interface FillRetryState {
  pendingTurns: number | null
  blockedTurns: number | null
}

export const initialFillRetryState: FillRetryState = { pendingTurns: null, blockedTurns: null }

/**
 * 结算一次主动补页：请求结束时轮次没有增加，就认为这次补页失败。
 *
 * 短视口下没有滚动事件可以等，只能靠轮次变化触发补页；如果失败后不阻断，`loading` 回到
 * false 会立刻再发一次，持续失败就变成不受控的重试。阻断只针对同一批轮次：用户手动加载
 * 成功、或会话换了内容之后，轮次数量变化会重新允许自动补页。
 */
export function settleFillRetry(state: FillRetryState, turnsLength: number, loading: boolean): FillRetryState {
  if (state.pendingTurns == null || loading) return state
  return turnsLength === state.pendingTurns
    ? { pendingTurns: null, blockedTurns: state.pendingTurns }
    : { pendingTurns: null, blockedTurns: null }
}

export function canFill(state: FillRetryState, turnsLength: number): boolean {
  return state.pendingTurns == null && state.blockedTurns !== turnsLength
}

/** 内容高度不足以滚动时（或接近阈值）才允许主动补页，避免刚打开会话就刷新历史。 */
export function isViewportShort(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight <= clientHeight + HISTORY_AUTOLOAD_THRESHOLD_PX
}
