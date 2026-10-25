// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { useMemo } from 'react'








import { Icon } from './primitives/Icon'
import type { HookConfiguredCommand } from '@shared/trace'






import { hookCancellationDetail, hookCommandLabel } from '../format'
import type { HookSummary } from '../format'




import { aggregateTurnHookPhases, formatHookPhaseDuration, hookPhaseTiming, type TurnHookPhase } from './ChatTurnHookData'
import { cancellationStatus, hookCommandFromTrace, unsuccessfulHookStatus } from './ChatTurnShared'
export function HooksSummary({
  summary,
  title = '本轮 Hook',
  defaultExpanded = false,
  liveArrivalKeys = new Set<string>(),
  phases: providedPhases
}: {
  summary: HookSummary
  title?: string
  defaultExpanded?: boolean
  liveArrivalKeys?: ReadonlySet<string>
  phases?: readonly TurnHookPhase[]
}) {
  const phases = useMemo(() => providedPhases ?? aggregateTurnHookPhases(summary), [providedPhases, summary])
  const detailValue = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  const scopeLabel = (source: HookConfiguredCommand['source']): string =>
    source === 'user' ? '用户' : source === 'project' ? '项目' : source === 'local' ? '本地' : '插件'

  return (
    <details className="turn-hooks-summary" open={defaultExpanded}>
      <summary>
        <Icon name="tool" /> {title}
        <span className="hook-total">{phases.length} 个周期 · {summary.logicalRuns} 个处理器实例</span>
      </summary>
      <div className="turn-hooks-body">
        {phases.map((phase, phaseIndex) => {
          const phaseTone = phase.errors > 0 ? 'bad' : phase.cancelled > 0 || phase.pending > 0 ? 'warn' : 'ok'
          const timing = hookPhaseTiming(phase)
          const timingLabel = timing ? `耗时 ~${formatHookPhaseDuration(timing.durationMs)}` : '耗时 —'
          const timingTitle = timing
            ? `周期占用墙钟约 ${formatHookPhaseDuration(timing.durationMs)}；按 ${timing.timedInstances}/${timing.totalInstances} 个处理器实例的运行区间合并去重，并行实例不重复计时。`
            : '未获得可配对的 Hook 开始与结束时间，无法可靠计算周期耗时。'
          return (
            <details className={`turn-hook-phase${liveArrivalKeys.has(`hook:${phase.event}`) ? ' stream-arrival' : ''}`} key={phase.event} open={defaultExpanded}>
              <summary className="turn-hook-phase-row">
                <span className="hook-phase-order">{String(phaseIndex + 1).padStart(2, '0')}</span>
                <span className={`sdot ${phaseTone}`} />
                <span className="hook-phase-event">{phase.event}</span>
                <span className="hook-phase-stats">
                  <span className="hook-phase-duration" title={timingTitle}>{timingLabel}</span>
                  <span
                    className="hook-phase-count"
                    title="触发次数优先按唯一工具调用 ID 统计；无法关联工具时，仅在各处理器实例数一致时推导。右侧数字是处理器实例数。"
                  >
                    {phase.triggerRuns != null && <>{phase.triggerRuns} 次触发 · </>}
                    {phase.logicalRuns} 个处理器实例
                  </span>
                </span>
                <Icon name="chevronRight" className="hook-row-chev" />
              </summary>
              <div className="turn-hook-phase-body">
                {phase.scripts.map((script) => {
            const cancellation = hookCancellationDetail(script.lastCancelled)
            const unsuccessfulErrors = Math.max(
              script.errors,
              script.unsuccessful.filter((event) => event.hookOutcome !== 'cancelled').length
            )
            const hasErrors = unsuccessfulErrors > 0
            const tone = hasErrors ? 'bad' : script.cancelled > 0 ? 'warn' : script.responses > 0 ? 'ok' : 'warn'
            const cancellationLabel = cancellation?.kind === 'timeout'
              ? '超时'
              : cancellation?.kind === 'suspected-timeout' ? '疑似超时' : '已取消'
            const status = hasErrors
              ? `失败 ${unsuccessfulErrors}`
              : script.cancelled > 0
                ? script.cancelled < script.responses ? `取消 ${script.cancelled}` : `${cancellationLabel} ${script.cancelled}`
                : script.responses > 0 ? `成功 ${script.responses}` : `运行中 ${script.pending}`
            const statusDetail = cancellation
              ? `${script.cancelled < script.responses ? '部分取消；最近一次：' : ''}${cancellationStatus(cancellation)}`
              : status
            const latest = script.lastError ?? script.lastCancelled ?? script.last
            const configuredCommands = script.configuredCommands
            const triggerSubjects = [...new Set(script.triggerRows.map((row) => {
              const triggerPrefix = `${phase.event}:`
              return row.trigger.startsWith(triggerPrefix) ? row.trigger.slice(triggerPrefix.length) : row.trigger
            }))]
            const triggerLabel = triggerSubjects.length === 1
              ? triggerSubjects[0] === phase.event ? '周期' : triggerSubjects[0]
              : `${triggerSubjects[0]} +${triggerSubjects.length - 1}`
            const triggerSummary = script.triggerRows
              .filter((row) => row.toolCalls > 0)
              .map((row) => {
                const triggerPrefix = `${phase.event}:`
                const subject = row.trigger.startsWith(triggerPrefix) ? row.trigger.slice(triggerPrefix.length) : row.trigger
                return `${row.toolCalls} 次 ${subject}`
              })
              .join(' · ')
            const input = latest?.input as Record<string, unknown> | undefined
            const evidenceCandidates = [
              ['stdout', detailValue(input?.stdout)],
              ['stderr', detailValue(input?.stderr)],
              ['content', detailValue(input?.content)],
              ['output', detailValue(latest?.output)],
              ['text', detailValue(latest?.text)]
            ].filter((entry): entry is [string, string] => !!entry[1])
            const seenEvidence = new Set<string>()
            const evidence = evidenceCandidates.filter(([, value]) => {
              if (seenEvidence.has(value)) return false
              seenEvidence.add(value)
              return true
            })
            const successfulResponses = Math.max(0, script.responses - script.unsuccessful.length)
            const executionResult = [
              successfulResponses > 0 ? `${successfulResponses} 成功` : '',
              script.cancelled > 0 ? `${script.cancelled} 取消` : '',
              unsuccessfulErrors > 0 ? `${unsuccessfulErrors} 失败` : '',
              script.pending > 0 ? `${script.pending} 未结束` : ''
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <details className={`turn-hook-item${liveArrivalKeys.has(`hook:${phase.event}:${script.key}`) ? ' stream-arrival' : ''}`} key={script.key} open={defaultExpanded}>
                <summary className="turn-hook-row" title={`${phase.event} · ${triggerSubjects.join('、')}`}>
                  <span className={`sdot ${tone}`} />
                  <span className="hook-script-name">{script.label}</span>
                  <span className="hook-event-name">{triggerLabel}</span>
                  <span className={`hook-run-status ${tone}`}>{status}</span>
                  <span className="hook-run-count">{script.displayedRuns}×</span>
                  <Icon name="chevronRight" className="hook-row-chev" />
                </summary>
                <div className="turn-hook-detail">
                  <dl className="hook-detail-grid">
                    {triggerSummary && (
                      <>
                        <dt>工具调用</dt>
                        <dd>{triggerSummary}</dd>
                      </>
                    )}
                    <dt>执行结果</dt>
                    <dd>{executionResult || '暂无结果'}</dd>
                    <dt>最近结果</dt>
                    <dd>
                      {statusDetail}
                      {script.cancelled === 0 && script.exitCode != null ? ` · exit ${script.exitCode}` : ''}
                    </dd>
                    {script.cancelled > 0 && (
                      <>
                        <dt>影响</dt>
                        <dd>Hook 进程未正常完成；不代表对应工具调用也被取消。</dd>
                      </>
                    )}
                  </dl>
                  {script.unsuccessful.length > 0 && (
                    <div className="hook-issues-block">
                      <div className="hook-detail-label">未成功的 Hook · {script.unsuccessful.length}</div>
                      <div className="hook-issues-list">
                        {script.unsuccessful.map((issue) => {
                          const issueCommand = hookCommandFromTrace(issue)
                          const issueLabel = hookCommandLabel(issueCommand) ?? '命令未上报'
                          const issueTone = issue.hookOutcome === 'cancelled' ? 'warn' : 'bad'
                          const candidateCount = issue.hookConfiguredCommands?.length ?? configuredCommands.length
                          return (
                            <div className={`hook-issue ${issueTone}`} key={issue.hookId ?? issue.id}>
                              <div className="hook-issue-head">
                                <span className={`hook-run-status ${issueTone}`}>{unsuccessfulHookStatus(issue)}</span>
                                <strong>{issueLabel}</strong>
                              </div>
                              {issueCommand ? (
                                <code>{issueLabel}</code>
                              ) : (
                                <p>
                                  运行时未上报命令，无法可靠映射到{candidateCount > 0 ? `下方 ${candidateCount} 条当前配置` : '具体脚本'}。
                                </p>
                              )}
                              <div className="hook-issue-meta">hookId {issue.hookId ?? '未上报'}</div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {configuredCommands.length > 0 && (
                    <div className="hook-configured-block">
                      <div className="hook-detail-label">
                        {script.exactConfiguredMapping ? `每次并行触发的 Hook · ${configuredCommands.length} 个` : `当前配置匹配 · ${configuredCommands.length} 条`}
                      </div>
                      {!script.exactConfiguredMapping && (
                        <p className="hook-configured-note">
                          运行时未上报 Hook 与工具调用的逐实例映射；当前配置无法完整解释实际数量。配置可能在会话结束后变化，以下为当前配置反查。
                        </p>
                      )}
                      <div className="hook-configured-list">
                        {configuredCommands.map((candidate, index) => (
                          <div className="hook-configured-command" key={`${candidate.source}:${candidate.pluginId ?? ''}:${candidate.matcher ?? ''}:${candidate.command}:${index}`}>
                            <span className={`hook-config-scope ${candidate.source}`}>
                              {scopeLabel(candidate.source)}{candidate.pluginId ? ` · ${candidate.pluginId.split('@')[0]}` : ''}
                            </span>
                            <code>{hookCommandLabel(candidate.command) ?? 'command'}</code>
                            {(candidate.matcher || candidate.timeoutSeconds != null) && (
                              <span className="hook-config-matcher">
                                {candidate.matcher ? `matcher ${candidate.matcher}` : ''}
                                {candidate.matcher && candidate.timeoutSeconds != null ? ' · ' : ''}
                                {candidate.timeoutSeconds != null ? `timeout ${candidate.timeoutSeconds}s` : ''}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {evidence.length > 0 && (
                    <div className="hook-evidence-list">
                      {evidence.map(([label, value]) => (
                        <div className="hook-evidence" key={label}>
                          <div className="hook-detail-label">{label}</div>
                          <pre>{value}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            )
                })}
              </div>
            </details>
          )
        })}
      </div>
    </details>
  )
}

// 蓝本 .turn-footer：in / out / cache·r / cache·w / dur / api / tools / files / err，分组用 .sep 隔。
