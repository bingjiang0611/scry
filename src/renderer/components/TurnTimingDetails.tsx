import type { ReactNode } from 'react'
import type { TurnTimingBreakdown } from '../turn-timing'

function durationText(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function metric(label: string, value: string, title: string): ReactNode {
  return (
    <div className="turn-timing-metric" title={title}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

export function TurnTimingDetails({ timing }: { timing: TurnTimingBreakdown }) {
  const apiMs = timing.providerTiming?.apiMs
  const observedModelMs = timing.apiSource === 'observed'
    ? timing.apiObservation === 'response' ? timing.occupiedApiMs ?? timing.apiMs : timing.apiMs
    : undefined
  const modelMs = apiMs ?? observedModelMs
  const wall = timing.turnWall

  return (
    <div
      className="turn-call-timing"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="turn-timing-title"><span>耗时明细</span></div>
      <div className="turn-timing-summary">
        {metric(
          '整轮耗时',
          durationText(wall?.durationMs),
          wall?.source === 'estimated'
            ? '历史记录估算：已知活动的时间跨度，包含已记录的 Hook；缺少完整起止边界，不保证覆盖全部等待。'
            : 'Scry 接受本轮执行至 Provider 及本轮同步 Hook 收尾结束的观测墙钟；并行活动不重复累加，不含 detached 后台任务、异步上传或归档。缺少可靠计时时显示 —。'
        )}
        {metric(
          apiMs != null ? 'Provider API 耗时' : '模型耗时观测 / 估算',
          modelMs == null ? '—' : `${apiMs == null ? '~' : ''}${durationText(modelMs)}`,
          apiMs != null
            ? 'Provider 结果中的 API 计时，可能累计多个请求；不是整轮墙钟，不与其他指标直接相加或相减。'
            : '来自响应事件区间或阶段余量估算，不与整轮耗时直接相减。'
        )}
      </div>
    </div>
  )
}
