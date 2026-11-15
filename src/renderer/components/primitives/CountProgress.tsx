import { useEffect, useRef, useState } from 'react'

/**
 * Remaining time from the observed rate. Nothing is guessed before there is at
 * least one finished item and a second of data; until then the caller says it is
 * estimating rather than showing a made-up number.
 */
export function estimateRemainingMs(done: number, total: number, elapsedMs: number): number | null {
  if (done <= 0 || done >= total || elapsedMs < 1_000) return null
  return Math.round((elapsedMs / done) * (total - done))
}

export function remainingLabel(ms: number | null): string {
  if (ms === null) return '正在估算…'
  const seconds = Math.max(1, Math.round(ms / 1_000))
  return seconds < 60 ? `约 ${seconds} 秒` : `约 ${Math.round(seconds / 60)} 分钟`
}

/**
 * Determinate progress for counted work, drawn where the work was started so
 * nothing else on the page moves. The count is the real one reported by main.
 */
export function CountProgress({ label, done, total, failed = 0 }: { label: string; done: number; total: number; failed?: number }) {
  const started = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // One coarse tick refreshes the estimate between reports; stopped when done.
    if (done >= total) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [done, total])
  const remaining = estimateRemainingMs(done, total, Math.max(now, Date.now()) - started.current)
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="count-progress" role="status" aria-live="polite">
      <div className="count-progress-copy">
        <b>{label}</b>
        <span>{done} / {total}{failed > 0 ? ` · ${failed} 个未删除` : ''} · {remainingLabel(remaining)}</span>
      </div>
      <div className="count-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}>
        <span className="count-progress-fill" style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
    </div>
  )
}
