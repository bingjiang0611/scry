// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { type ReactNode } from 'react'








import type { TraceEvent } from '@shared/trace'


import { isIncompleteRunTermination, runTerminationHint, runTerminationLabel, type RunTerminationReason } from '@shared/runtime'



import { aggregateCalls, fmtTok, logicalCallEventsForTurn, resultOf } from '../format'
import type { FileRow } from '../format'
import { ANTIGRAVITY_COPY } from '../constants/antigravity-copy'
import { Notice } from './primitives/Notice'




export function TurnFooter({ items, files }: { items: TraceEvent[]; files: FileRow[] }) {
  const result = resultOf({ items })
  const calls = logicalCallEventsForTurn(items)
  const tools = aggregateCalls(calls).totalCalls
  // “files” 表示去重后的文件数，而不是同一路径被反复 Read/Edit 的调用次数。
  // 已修改文件统一归入 W，避免同一路径同时出现在 R 与 W 中。
  const reads = files.filter((file) => file.read > 0 && file.write === 0 && file.edit === 0).length
  const writes = files.filter((file) => file.write > 0 || file.edit > 0).length
  const errs = items.filter((e) => e.stage === 'tool_result' && e.isError).length
  const interventions = items.flatMap((event) => event.intervention ? [event.intervention] : [])
    .filter((intervention) => intervention.resolution !== 'provider_cancelled')
  const questions = interventions.reduce((total, intervention) => total + intervention.request.questions.length, 0)
  if (!result && tools === 0 && interventions.length === 0) return null
  const stat = (lbl: string, val: ReactNode, cls = ''): ReactNode => (
    <span className={`stat ${cls}`}>
      <span className="lbl">{lbl}</span> <b>{val}</b>
    </span>
  )
  const hasUsage = result?.tokensIn != null || result?.tokensOut != null || !!result?.cacheReadTokens || !!result?.cacheCreationTokens
  const hasTiming = result?.durationMs != null || result?.durationApiMs != null
  const meta = result?.runtimeMetadata as Record<string, unknown> | undefined
  const usageCoverage = meta?.usageCoverage === 'partial' || meta?.usageCoverage === 'unavailable'
    ? meta.usageCoverage
    : undefined
  const usageCoverageReason = typeof meta?.usageCoverageReason === 'string' ? meta.usageCoverageReason : undefined
  const modelUnobserved = meta?.modelStatus === 'unobserved'
  const modelOmissionReason = typeof meta?.modelOmissionReason === 'string' ? meta.modelOmissionReason : undefined
  return (
    <div className="turn-footer">
      {result?.tokensIn != null && stat('in', fmtTok(result.tokensIn))}
      {result?.tokensOut != null && stat('out', fmtTok(result.tokensOut))}
      {result?.cacheReadTokens ? stat('cache·r', fmtTok(result.cacheReadTokens)) : null}
      {result?.cacheCreationTokens ? stat('cache·w', fmtTok(result.cacheCreationTokens)) : null}
      {usageCoverage && (
        <span className="stat" title={usageCoverageReason}>
          <span className="lbl">{usageCoverage === 'partial' ? ANTIGRAVITY_COPY.usagePartial : ANTIGRAVITY_COPY.usageUnavailable}</span>
        </span>
      )}
      {modelUnobserved && (
        <span className="stat" title={modelOmissionReason}>
          <span className="lbl">{ANTIGRAVITY_COPY.modelUnobserved}</span>
        </span>
      )}
      {(hasUsage || usageCoverage || modelUnobserved) && hasTiming && <span className="sep" />}
      {result?.durationMs != null && stat('dur', `${(result.durationMs / 1000).toFixed(1)}s`)}
      {result?.durationApiMs != null && stat('api', `${(result.durationApiMs / 1000).toFixed(1)}s`)}
      <span className="sep" />
      {stat('tools', tools)}
      {reads + writes > 0 && stat('files', `${reads} R · ${writes} W`)}
      {interventions.length > 0 && stat('human', `${interventions.length} · ${questions}Q`)}
      {errs > 0 && (
        <>
          <span className="sep" />
          {stat('err', errs, 'err')}
        </>
      )}
    </div>
  )
}

export function TerminationNotice({ reason }: { reason: RunTerminationReason }) {
  if (!isIncompleteRunTermination(reason)) return null
  return (
    <Notice tone="warn" className="termination-notice" role="status">
      <b>{runTerminationLabel(reason)}</b>
      <span>{runTerminationHint(reason)}</span>
    </Notice>
  )
}

export function ToolTerminationNotice({ evidence }: { evidence: NonNullable<TraceEvent['toolTermination']> }) {
  return (
    <Notice tone="warn" className="termination-notice" role="status">
      <b>工具已结束本次执行 · {evidence.tool}</b>
      <span>{evidence.message || '工具未提供结束说明'}</span>
      <span>执行结束不代表目标已验证完成；请先查看工具结果，不要盲目重试。</span>
    </Notice>
  )
}
