import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { isViewportShort, shouldLoadOlder, canFill, initialFillRetryState, settleFillRetry, type FillRetryState } from '../history-autoload'

// 静态渲染（测试/SSR）没有布局阶段；此时退回 useEffect，避免 React 的 useLayoutEffect 警告。
const useLayoutEffectCompat = typeof window === 'undefined' ? useEffect : useLayoutEffect

interface HistoryAutoloadInput {
  scrollRef: RefObject<HTMLElement>
  /** 已挂载轮次数量（含正在流式输出的那一轮）；变化说明视图内容变了，需要重新对齐阅读位置。 */
  turnsLength: number
  hasOlder: boolean
  loading: boolean
  onLoadOlder?: () => void
}

/** 取页前的定位锚：第一个可见轮次，以及它在内容坐标系里的位置。 */
interface Anchor {
  node: Element
  contentTop: number
}

// 内容坐标系：滚动不影响该值，插入/移除上方内容才会改变它。
function contentTopOf(el: HTMLElement, node: Element): number {
  return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
}

function firstVisibleTurn(el: HTMLElement): Element | null {
  const edge = el.getBoundingClientRect().top
  for (const node of el.querySelectorAll('[data-run-id]')) {
    if (node.getBoundingClientRect().bottom > edge + 1) return node
  }
  return null
}

/**
 * 时间线滚到接近顶部时自动取上一页，并把可见轮次放回原位。
 *
 * 触发只发生在两种明确条件下：用户滚动到预取距离内，或内容不足一屏（没有滚动事件可等）。
 * 位置补偿按锚点轮次在内容坐标系里的位移做：`.chat` 关闭了浏览器滚动锚定
 * （见 styles-chat-entry.css），prepend 会把正文整体下移，必须由这里抵消，
 * 否则视口会跳到更早的轮次。用锚点而不是总高度，是因为取页在途时末尾可能同时
 * 追加新的实时轮次——那会改变总高度，却不该改变阅读位置。
 */
export function useHistoryAutoload({ scrollRef, turnsLength, hasOlder, loading, onLoadOlder }: HistoryAutoloadInput): void {
  const latest = useRef({ hasOlder, loading, onLoadOlder })
  latest.current = { hasOlder, loading, onLoadOlder }
  const anchor = useRef<Anchor | null>(null)
  const fillRetry = useRef<FillRetryState>(initialFillRetryState)

  const request = (reason: 'scroll' | 'fill'): boolean => {
    const el = scrollRef.current
    const state = latest.current
    if (!el || !state.onLoadOlder) return false
    const viewportShort = isViewportShort(el.scrollHeight, el.clientHeight)
    // 只有用户滚动到位、或内容不足一屏时才取页；否则交给滚动监听。
    if (reason === 'fill' && !viewportShort) return false
    if (!shouldLoadOlder({
      scrollTop: el.scrollTop,
      hasOlder: state.hasOlder,
      loading: state.loading,
      viewportShort
    })) return false
    const node = firstVisibleTurn(el)
    anchor.current = node ? { node, contentTop: contentTopOf(el, node) } : null
    state.onLoadOlder()
    return true
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      request('scroll')
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // request 每次渲染重建，但只读 ref 里的最新状态；监听器只跟随滚动容器绑定一次。
  }, [scrollRef])

  // 内容不足一屏时没有滚动事件：每拼上一页后检查是否还需要继续补。
  // 失败（请求结束却没有新轮次）只阻断自动重试，手动加载与滚动路径不受影响。
  useEffect(() => {
    fillRetry.current = settleFillRetry(fillRetry.current, turnsLength, loading)
    if (!canFill(fillRetry.current, turnsLength)) return
    if (request('fill')) fillRetry.current = { ...fillRetry.current, pendingTurns: turnsLength }
  }, [turnsLength, hasOlder, loading])

  // 上方插入内容后把阅读位置放回原位；只是末尾追加时位移为 0，不做任何调整。
  useLayoutEffectCompat(() => {
    const el = scrollRef.current
    const captured = anchor.current
    if (!el || !captured) return
    // 轮次被整体替换（切换会话）时锚点已不在文档里，位置由会话恢复逻辑负责。
    if (!captured.node.isConnected) {
      anchor.current = null
      return
    }
    const inserted = contentTopOf(el, captured.node) - captured.contentTop
    if (inserted <= 1) return
    anchor.current = null
    el.scrollTop += inserted
  }, [turnsLength, scrollRef])
}
