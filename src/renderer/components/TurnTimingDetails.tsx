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
          '模型 API 合计',
          durationText(timing.apiMs),
          timing.apiMs == null ? '未上报' : 'SDK',
          '整轮所有模型 API 活跃时间合计；不是某一次模型调用，也不是纯推理耗时。'
        )}
        {metric(
          '调用累计',
          hasTimedCalls ? durationText(timing.cumulativeCallMs) : '—',
          hasTimedCalls ? '原值 / ~观测' : '未计时',
          '各调用 tool_use→tool_result 墙钟耗时之和；并行和子 Agent 可能重叠，不能当作整轮占比。'
        )}
        {metric('可计时调用', coverage, timing.totalCalls > 0 && timing.timedCalls < timing.totalCalls ? '部分' : undefined)}
      </div>

      {timing.aggregates.length > 0 && (
        <div className="turn-timing-block">
          <div className="turn-timing-block-title">
            <span>按类型累计</span>
            <span className="turn-timing-caption">累计值可能重叠</span>
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
            <span>模型等待时间线</span>
          </div>
          <div className="turn-timing-timeline">
            {modelPhases.map((phase) => {
              const value = waitSeconds(phase.observedMs)
              const phaseName = phase.kind === 'final'
                ? '最终模型响应'
                : phase.kind === 'unsegmented'
                  ? '模型响应'
                  : `第 ${phase.sequence} 次模型响应`
              const accessibleLabel = phase.observedMs == null
                ? `${phaseName}等待时间未采集`
                : `${phaseName}前观测间隔 ${value}`
              return (
                <div className="turn-timing-phase" key={phase.id}>
                  <div className="turn-timing-api" role="group" title={accessibleLabel} aria-label={accessibleLabel}>
                    <b aria-hidden="true">{value}</b>
                  </div>
                  {phase.callsAfterResponse.length > 0 && (
                    <div className="turn-timing-batch">
                      {phase.callsAfterResponse.map((call) => (
                        <div key={`${phase.id}:${call.event.id}:${call.order}`}>{callRow(call, onOpenCall)}</div>
                      ))}
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
          <div className="turn-timing-note">计入调用累计；不与主会话模型响应串联，避免把父子 Agent 并行时间误当成主模型等待。</div>
        </div>
      )}
    </div>
  )
}
