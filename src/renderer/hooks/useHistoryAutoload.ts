import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { isViewportShort, shouldLoadOlder } from '../history-autoload'

// 静态渲染（测试/SSR）没有布局阶段；此时退回 useEffect，避免 React 的 useLayoutEffect 警告。
const useLayoutEffectCompat = typeof window === 'undefined' ? useEffect : useLayoutEffect

interface HistoryAutoloadInput {
  scrollRef: RefObject<HTMLElement>
  /** 已挂载轮次数量；变化说明上一页已经拼上，需要放回阅读位置。 */
  turnsLength: number
  hasOlder: boolean
  loading: boolean
  onLoadOlder?: () => void
}

/**
 * 时间线滚到接近顶部时自动取上一页，并把可见轮次放回原位。
 *
 * 触发只发生在两种明确条件下：用户滚动到预取距离内，或内容不足一屏（没有滚动事件可等）。
 * 位置补偿按插入高度做：`.chat` 关闭了浏览器滚动锚定（见 styles-chat-entry.css），
 * 所以必须由这里抵消 prepend 造成的内容位移，否则视口会跳到更早的轮次。
 * 加载期间用户继续滚动时，补偿仍加在当前 scrollTop 上，不把视图拉回旧位置。
 */
export function useHistoryAutoload({ scrollRef, turnsLength, hasOlder, loading, onLoadOlder }: HistoryAutoloadInput): void {
  const latest = useRef({ hasOlder, loading, onLoadOlder })
  latest.current = { hasOlder, loading, onLoadOlder }
  // 取页前的内容高度：拼上后用它算出上方插入了多少像素。
  const heightBefore = useRef<number | null>(null)

  const request = (reason: 'scroll' | 'fill'): void => {
    const el = scrollRef.current
    const state = latest.current
    if (!el || !state.onLoadOlder) return
    const viewportShort = isViewportShort(el.scrollHeight, el.clientHeight)
    // 只有用户滚动到位、或内容不足一屏时才取页；否则交给滚动监听。
    if (reason === 'fill' && !viewportShort) return
    if (!shouldLoadOlder({
      scrollTop: el.scrollTop,
      hasOlder: state.hasOlder,
      loading: state.loading,
      viewportShort
    })) return
    heightBefore.current = el.scrollHeight
    state.onLoadOlder()
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => request('scroll')
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // request 每次渲染重建，但只读 ref 里的最新状态；监听器只跟随滚动容器绑定一次。
  }, [scrollRef])

  // 内容不足一屏时没有滚动事件：每拼上一页后检查是否还需要继续补。
  useEffect(() => {
    request('fill')
  }, [turnsLength, hasOlder, loading])

  // 追加历史会把已读内容推到下方：补回同样的位移，当前轮次留在原位。
  useLayoutEffectCompat(() => {
    const el = scrollRef.current
    const before = heightBefore.current
    heightBefore.current = null
    if (!el || before === null) return
    const inserted = el.scrollHeight - before
    if (inserted > 0) el.scrollTop += inserted
  }, [turnsLength, scrollRef])
}
