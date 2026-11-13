import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { useHistoryAutoload } from '../../src/renderer/hooks/useHistoryAutoload'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

const TOTAL = 200
const PAGE = 40
const ROW_BASE = 68

/** 每一轮高度不同：锚点补偿必须按真实几何计算，不能假设等行高。 */
const rowHeight = (index: number): number => ROW_BASE + (index % 3) * 18

// 与生产一致：`.chat` 关闭浏览器滚动锚定，位置补偿由 hook 负责。
function Paged({ id }: { id: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(TOTAL - PAGE)
  const [loading, setLoading] = useState(false)
  const [loads, setLoads] = useState(0)
  // 正在流式输出的实时轮次：取页在途时它可能出现在末尾。
  const [live, setLive] = useState(0)
  const hasOlder = offset > 0
  const turns = Array.from({ length: TOTAL - offset }, (_, index) => offset + index)
  const startLoad = (): void => {
    if (loading || !hasOlder) return
    setLoading(true)
    // 真实 App 里也要等 main 回包；这里用固定延迟模拟在途窗口。
    window.setTimeout(() => {
      setOffset((current) => Math.max(0, current - PAGE))
      setLoading(false)
      setLoads((count) => count + 1)
    }, 60)
  }
  useHistoryAutoload({ scrollRef: scrollerRef, turnsLength: turns.length + live, hasOlder, loading, onLoadOlder: startLoad })
  return (
    <section
      className="fixture"
      id={id}
      data-count={turns.length}
      data-loads={loads}
      data-has-older={String(hasOlder)}
      data-live={live}
    >
      <button type="button" className="append-live" onClick={() => setLive((count) => count + 1)}>append live turn</button>
      <div
        className="chat-transcript scroller"
        ref={scrollerRef}
        style={{ height: 420, overflowY: 'auto', overflowAnchor: 'none', border: '1px solid #333', width: 520 }}
      >
        <div className="chat-transcript-content">
          {turns.map((index) => (
            <article key={index} className="transcript-turn" data-run-id={`turn-${index}`} style={{ height: rowHeight(index) }}>
              第 {index + 1} 轮
            </article>
          ))}
          {Array.from({ length: live }, (_, index) => (
            <article key={`live-${index}`} className="transcript-turn" data-run-id={`live-${index}`} style={{ height: ROW_BASE }}>
              实时第 {index + 1} 轮
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * 取页一直失败、内容又不足一屏：没有滚动事件可等，自动补页不能每结算一次就再试一次。
 * 真实失败路径由 main 的取页错误产生，这里只复现“请求结束但轮次没增加”的形态。
 */
function Failing({ id }: { id: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const startLoad = (): void => {
    if (loading) return
    setLoading(true)
    window.setTimeout(() => {
      setAttempts((count) => count + 1)
      setLoading(false)
    }, 20)
  }
  useHistoryAutoload({ scrollRef: scrollerRef, turnsLength: 3, hasOlder: true, loading, onLoadOlder: startLoad })
  return (
    <section className="fixture" id={id} data-attempts={attempts}>
      <div
        className="chat-transcript scroller"
        ref={scrollerRef}
        style={{ height: 240, overflowY: 'auto', overflowAnchor: 'none', border: '1px solid #333', width: 520 }}
      >
        <div className="chat-transcript-content">
          {[0, 1, 2].map((index) => (
            <article key={index} className="transcript-turn" data-run-id={`failing-${index}`} style={{ height: ROW_BASE }}>
              第 {index + 1} 轮
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

createRoot(document.querySelector('#root')!).render(
  <main style={{ display: 'flex', gap: 24, padding: 24 }}>
    <Paged id="fixture-reading" />
    <Failing id="fixture-failing" />
  </main>
)
