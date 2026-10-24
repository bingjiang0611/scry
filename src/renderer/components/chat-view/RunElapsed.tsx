import { useEffect, useState } from 'react'
import { formatElapsedMs } from './composer-utils'

export function RunElapsed({ startedAt }: { startedAt: number }) {
  const [, setNowTick] = useState(0)
  useEffect(() => {
    let timer: number | null = null
    const syncTimer = (): void => {
      if (timer != null) window.clearInterval(timer)
      timer = null
      if (document.visibilityState !== 'visible') return
      setNowTick((n) => n + 1)
      timer = window.setInterval(() => setNowTick((n) => n + 1), 1000)
    }
    syncTimer()
    document.addEventListener('visibilitychange', syncTimer)
    return () => {
      document.removeEventListener('visibilitychange', syncTimer)
      if (timer != null) window.clearInterval(timer)
    }
  }, [startedAt])
  return <span className="run-status-elapsed" title="已用时长按当前 run 首个事件时间戳（TraceEvent.ts）计算">{formatElapsedMs(Date.now() - startedAt)}</span>
}
