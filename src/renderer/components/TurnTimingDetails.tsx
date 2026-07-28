import type { MouseEvent, ReactNode } from 'react'
import type { TimedTurnCall, TurnTimingBreakdown } from '../turn-timing'

function durationText(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function waitSeconds(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const seconds = ms / 1000
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
}

function timingSource(call: TimedTurnCall): string {
  if (call.durationSource === 'provider') return '原生'
  if (call.durationSource === 'observed') return '观测'
  return '未计时'
}

function phaseToolSource(timed: number, total: number): string {
  if (timed === 0) return '未计时'
  return timed < total ? `~观测 · ${timed}/${total}` : '~观测'
}

function metric(label: string, value: string, source?: string, title?: string): ReactNode {
  return (
    <div className="turn-timing-metric" title={title}>
      <span>{label}</span>
      <b>{value}</b>
      {source && <em>{source}</em>}
    </div>
  )
}

function callRow(call: TimedTurnCall, onOpenCall?: (call: TimedTurnCall) => void): ReactNode {
  const value = call.durationMs == null ? '—' : `${call.durationSource === 'observed' ? '~' : ''}${durationText(call.durationMs)}`
  const accessibleDuration =
    call.durationMs == null
      ? '未计时'
      : `${call.durationSource === 'observed' ? '观测耗时约' : '原生耗时'} ${durationText(call.durationMs)}`
  const content = (
    <>
      <span className="turn-timing-call-kind">{call.category}</span>
      <span className="turn-timing-call-name">{call.label === call.category ? '' : call.label}</span>
      <span className="turn-timing-call-duration">{value}</span>
      <span className={`turn-timing-source ${call.durationSource}`}>{timingSource(call)}</span>
    </>
  )
  if (!onOpenCall) return <div className="turn-timing-call">{content}</div>

  const action = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    onOpenCall(call)
  }
  return (
    <button
      type="button"
      className="turn-timing-call clickable"
      title={`跳到 ${call.label} 调用，${accessibleDuration}`}
      aria-label={`跳到 ${call.label} 调用，${accessibleDuration}`}
      onClick={action}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {content}
      <span className="turn-timing-call-jump" aria-hidden="true">›</span>
    </button>
  )
}

export function TurnTimingDetails({
  timing,
  onOpenCall
}: {
  timing: TurnTimingBreakdown
  onOpenCall?: (call: TimedTurnCall) => void
}) {
  const hasTimedCalls = timing.timedCalls > 0
  const coverage = timing.totalCalls > 0 ? `${timing.timedCalls}/${timing.totalCalls}` : '—'
  const modelPhases = timing.phases.filter((phase) => phase.kind !== 'tail')
  const isResidualEstimate = timing.apiSource === 'observed' && timing.apiObservation === 'residual'
  const apiMetricLabel =
    timing.apiSource === 'provider'
      ? '模型 API 合计'
      : isResidualEstimate
        ? '未归因耗时'
        : timing.apiSource === 'observed'
          ? '模型 API 观测'
          : '模型 API'
  const apiSource =
    timing.apiSource === 'provider'
      ? 'SDK'
      : timing.apiSource === 'observed'
        ? timing.apiObservation === 'residual'
          ? `~估算 · 已计时 ${coverage}`
          : timing.timedApiPhases < timing.totalApiPhases
            ? `~观测 · ${timing.timedApiPhases}/${timing.totalApiPhases}`
            : '~观测'
        : '未采集'
  const aggregateCaption = hasTimedCalls
    ? `累计 ${durationText(timing.cumulativeCallMs)} · ${
        (timing.overlapCallMs ?? 0) > 0
          ? `重叠 ${durationText(timing.overlapCallMs)}`
          : '无重叠'
      }`
    : '暂无可计时调用'
  return (
    <div
      className="turn-call-timing"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="turn-timing-title">
        <span>耗时明细</span>
        <span className="turn-timing-caption" title="Provider / SDK 原值与基于事件时间戳推算的观测值分开标记">原值 / ~观测</span>
      </div>
      <div className="turn-timing-summary">
        {metric('整轮墙钟', durationText(timing.wallMs), timing.wallMs == null ? '未上报' : '运行时')}
        {metric(
          apiMetricLabel,
          `${timing.apiSource === 'observed' && timing.apiMs != null ? '~' : ''}${durationText(timing.apiMs)}`,
          apiSource,
          timing.apiSource === 'provider'
            ? 'Provider / SDK 上报的整轮模型 API 活跃时间合计。'
            : timing.apiObservation === 'residual'
              ? 'Provider 未上报 API 耗时且缺少逐次响应边界；当前值为整轮墙钟减去已计时调用占用区间的余量，可能包含模型、调度、Hook、IPC 与未计时活动。'
              : 'Provider 未上报 API 耗时；当前值按工具结束到下一次模型响应之间的事件时间戳观测区间累计。'
        )}
        {metric(
          '调用耗时',
          hasTimedCalls ? durationText(timing.occupiedCallMs) : '—',
          hasTimedCalls ? '去重墙钟' : '未计时',
          '至少一个已计时调用正在运行的墙钟时间；并行和子 Agent 嵌套区间只计算一次。'
        )}
        {metric('可计时调用', coverage, timing.totalCalls > 0 && timing.timedCalls < timing.totalCalls ? '部分' : undefined)}
      </div>

      {timing.aggregates.length > 0 && (
        <div className="turn-timing-block">
          <div className="turn-timing-block-title">
            <span>按类型累计</span>
            <span
              className="turn-timing-caption"
              title="按类型累计会重复计算并行和子 Agent 嵌套区间；主指标“调用耗时”已去重"
            >
              {aggregateCaption}
            </span>
          </div>
          <div className="turn-timing-aggregate-list">
            {timing.aggregates.map((aggregate) => (
              <div className="turn-timing-aggregate" key={aggregate.category}>
                <span className="turn-timing-aggregate-name">{aggregate.category}</span>
                <span>{aggregate.count}×</span>
                <b>{aggregate.timedCount > 0 ? durationText(aggregate.totalMs) : '—'}</b>
                <span title="平均 / 最慢">
                  {aggregate.timedCount > 0
                    ? `均 ${durationText(aggregate.averageMs)} · 最慢 ${durationText(aggregate.maxMs)}`
                    : `${aggregate.count} 次未计时`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {modelPhases.length > 0 && (
        <div className="turn-timing-block">
          <div className="turn-timing-block-title">
            <span>耗时归因时间线</span>
          </div>
          <div className="turn-timing-timeline">
            {modelPhases.map((phase) => {
              const apiValue = waitSeconds(phase.observedMs)
              const phaseName = phase.kind === 'final'
                ? '最终模型响应'
                : phase.kind === 'unsegmented'
                  ? '模型响应'
                  : `第 ${phase.sequence} 次模型响应`
              const accessibleLabel = phase.observedMs == null
                ? `${phaseName}等待时间未采集`
                : phase.kind === 'unsegmented'
                  ? `整轮未归因耗时约 ${apiValue}`
                  : `${phaseName}前 API 观测耗时约 ${apiValue}`
              const toolValue = phase.toolMs == null ? '—' : `${durationText(phase.toolMs)}`
              const toolCount = phase.callsAfterResponse.length
              return (
                <div className="turn-timing-phase" key={phase.id}>
                  <div className="turn-timing-api" role="group" title={accessibleLabel} aria-label={accessibleLabel}>
                    <span>{phase.kind === 'unsegmented' ? '未归因耗时' : '模型 API'}</span>
                    <b aria-hidden="true">{phase.observedMs == null ? '—' : `~${apiValue}`}</b>
                  </div>
                  {toolCount > 0 && (
                    <div
                      className="turn-timing-tool-batch"
                      role="group"
                      title={`${toolCount} 次工具调用；${phase.timedTools} 次可计时`}
                      aria-label={`${toolCount} 次工具调用，耗时${phase.toolMs == null ? '未计时' : `约 ${toolValue}`}`}
                    >
                      <span>工具调用</span>
                      <em>{toolCount} 次</em>
                      <b>{phase.toolMs == null ? '—' : `~${toolValue}`}</b>
                      <small>{phaseToolSource(phase.timedTools, toolCount)}</small>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {timing.unassignedCalls.length > 0 && (
        <div className="turn-timing-block">
          <div className="turn-timing-block-title">
            <span>未绑定模型响应</span>
            <span className="turn-timing-caption">{timing.unassignedCalls.length} 次</span>
          </div>
          <div className="turn-timing-batch">
            {timing.unassignedCalls.map((call) => (
              <div key={`unassigned:${call.event.id}:${call.order}`}>{callRow(call, onOpenCall)}</div>
            ))}
          </div>
          <div className="turn-timing-note">缺少明确 messageId，保留耗时但不猜测它属于哪次模型响应。</div>
        </div>
      )}

      {timing.nestedCalls.length > 0 && (
        <div className="turn-timing-block">
          <div className="turn-timing-block-title">
            <span>子 Agent 内部调用</span>
            <span className="turn-timing-caption">{timing.nestedCalls.length} 次</span>
          </div>
          <div className="turn-timing-batch">
            {timing.nestedCalls.map((call) => (
              <div key={`nested:${call.event.id}:${call.order}`}>{callRow(call, onOpenCall)}</div>
            ))}
          </div>
          <div className="turn-timing-note">计入按类型累计；主指标“调用耗时”会合并父子 Agent 的重叠区间。</div>
        </div>
      )}
    </div>
  )
}
