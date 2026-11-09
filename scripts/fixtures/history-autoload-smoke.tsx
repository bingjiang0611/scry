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
  useHistoryAutoload({ scrollRef: scrollerRef, turnsLength: turns.length, hasOlder, loading, onLoadOlder: startLoad })
  return (
    <section
      className="fixture"
      id={id}
      data-count={turns.length}
      data-loads={loads}
      data-has-older={String(hasOlder)}
    >
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
        </div>
      </div>
    </section>
  )
}

createRoot(document.querySelector('#root')!).render(
  <main style={{ display: 'flex', gap: 24, padding: 24 }}>
    <Paged id="fixture-reading" />
  </main>
)
