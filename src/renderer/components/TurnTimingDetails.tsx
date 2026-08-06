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

function metric(label: string, value: string, source: string, title: string): ReactNode {
  return (
    <div className="turn-timing-metric" title={title}>
      <span>{label}</span>
      <b>{value}</b>
      <em>{source}</em>
    </div>
  )
}

function modelWallMs(timing: TurnTimingBreakdown): number | undefined {
  const measured = timing.apiObservation === 'response' && timing.occupiedApiMs != null
    ? timing.occupiedApiMs
    : timing.apiMs
  if (measured == null) return undefined
  return timing.wallMs == null ? measured : Math.min(measured, timing.wallMs)
}

function modelSource(timing: TurnTimingBreakdown): string {
  if (timing.apiSource === 'provider') return 'SDK 原值'
  if (timing.apiSource === 'observed' && timing.apiObservation === 'residual') return '~估算'
  if (timing.apiSource === 'observed') return '~观测'
  return '未采集'
}

export function TurnTimingDetails({ timing }: { timing: TurnTimingBreakdown }) {
  const modelMs = modelWallMs(timing)
  const toolMs = timing.wallMs != null && modelMs != null
    ? Math.max(0, timing.wallMs - modelMs)
    : timing.occupiedCallMs
  const toolSource = timing.wallMs != null && modelMs != null
    ? '整轮剩余'
    : timing.occupiedCallMs != null
      ? '~工具事件观测'
      : timing.totalCalls === 0
        ? '本轮无工具调用'
        : '未计时'

  return (
    <div
      className="turn-call-timing"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="turn-timing-title">
        <span>耗时明细</span>
        <span className="turn-timing-caption">两类墙钟</span>
      </div>
      <div className="turn-timing-summary">
        {metric(
          '模型响应耗时',
          modelMs == null ? '—' : `${timing.apiSource === 'observed' ? '~' : ''}${durationText(modelMs)}`,
          modelSource(timing),
          '根 Agent 与子 Agent 的模型响应区间合并去重；同一时段只计算一次。'
        )}
        {metric(
          '工具调用耗时',
          toolMs == null ? (timing.totalCalls === 0 ? '0ms' : '—') : durationText(toolMs),
          toolSource,
          '整轮墙钟扣除模型响应后的剩余时间；模型与其他活动重叠时优先归入模型响应。'
        )}
      </div>
      <div className="turn-timing-note">
        口径：以整轮墙钟划分。模型响应区间优先归入模型；其余时间统一计入工具调用，包括 Tool、MCP、Skill、子 Agent 调度、Hook、IPC 与等待。两项可相加；“~”表示事件时间戳观测或估算，缺少可靠数据时显示“—”。
      </div>
    </div>
  )
}
