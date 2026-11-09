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

/** 内容高度不足以滚动时（或接近阈值）才允许主动补页，避免刚打开会话就刷新历史。 */
export function isViewportShort(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight <= clientHeight + HISTORY_AUTOLOAD_THRESHOLD_PX
}
