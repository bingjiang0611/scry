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

export function TurnTimingDetails({ timing }: { timing: TurnTimingBreakdown }) {
  const totalMs = timing.providerTiming?.totalMs
  const apiMs = timing.providerTiming?.apiMs
  const incompatible = totalMs != null && apiMs != null && apiMs > totalMs
  // 只展示结果计时投影的算术差，不混入响应阶段估算，也不声称这是非模型墙钟。
  // resultOf 可能已聚合多个 result，适配器也可能从原生时间戳计算时长，不能一概标 SDK 原值。
  const remainderMs = totalMs != null && apiMs != null && !incompatible ? totalMs - apiMs : undefined
  const observedModelMs = timing.apiSource === 'observed'
    ? timing.apiObservation === 'response' ? timing.occupiedApiMs ?? timing.apiMs : timing.apiMs
    : undefined
  const modelMs = apiMs ?? observedModelMs
  const modelSource = apiMs != null
    ? '结果上报 / 聚合'
    : observedModelMs != null
      ? timing.apiObservation === 'response' ? '~响应区间观测' : '~估算'
      : '未采集可靠计时'

  return (
    <div
      className="turn-call-timing"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="turn-timing-title">
        <span>耗时明细</span>
        <span className="turn-timing-caption">独立计时口径</span>
      </div>
      <div className="turn-timing-summary">
        {metric(
          'Provider 结果时长',
          durationText(totalMs),
          totalMs == null ? '未采集' : '结果计时',
          '结果中的 durationMs；可能由适配器观测或多个 result 聚合，不保证覆盖 Scry 从发送到收尾完成的整轮墙钟。'
        )}
        {metric(
          apiMs != null ? 'Provider API 耗时' : '模型耗时观测 / 估算',
          modelMs == null ? '—' : `${apiMs == null ? '~' : ''}${durationText(modelMs)}`,
          modelSource,
          apiMs != null
            ? '结果中的 durationApiMs，可能聚合多个 result；请求累计、并发及计时边界由 Provider 定义，不保证是模型占用墙钟。'
            : '来自响应事件区间或阶段余量估算，不与 Provider 结果时长直接相减。'
        )}
        {metric(
          'Provider 计时余量',
          durationText(remainderMs),
          incompatible ? '不可相减' : remainderMs == null ? '缺少结果计时' : '结果时长 − API',
          '仅为结果计时投影中两个数值的算术差，不代表整轮非模型耗时，也不是所有 Hook 的耗时预算。'
        )}
      </div>
      <div className="turn-timing-note">
        {incompatible && 'API 耗时超过结果时长，可能存在累计或计时口径差异；保留结果值，不截断或生成负余量。'}
        Provider 内部计时不保证覆盖前置、收尾 Hook。Hook 明细按各周期的运行区间合并去重，与这里的计时范围不同，不能直接相加对账。
        缺少统一的起止边界，暂不划分整轮模型 / 非模型墙钟；“~”表示观测或估算，“—”表示缺少可靠数据。
      </div>
    </div>
  )
}
