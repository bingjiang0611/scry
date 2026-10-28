// 总览的 HOOKS 面板：会话级 Hook 汇总与逐次执行明细。
import type { ReactNode } from 'react'
import type { TraceEvent } from '@shared/trace'
import { hookCommandLabel } from '../format'
import type { HookSummary } from '../format'
import { formatTurnDuration } from './overview-turn-calls'
import { Icon } from './primitives/Icon'
import {
  groupHookInstances,
  hookBadgeText,
  hookCancellationTitle,
  hookConfigScopeLabel,
  hookDetailText,
  hookFailureText,
  hookTone,
  logicalHookRows,
  uniqueConfiguredCommands
} from './overview-hooks'

export function OverviewHooksSection({ hookSummary, onSelect }: {
  hookSummary: HookSummary
  onSelect: (ev: TraceEvent) => void
}): ReactNode {
  return (
        <div className="panel-section hooks-section">
          <h4 className="hooks-heading">
            <span>HOOKS</span>
            <span
              className="hook-summary-stats"
              aria-label={`本会话 Hook：事件 ${hookSummary.groups.length} 类，${hookSummary.logicalRuns} 次执行，${hookSummary.rawEvents} 条生命周期事件`}
            >
              <span>事件 {hookSummary.groups.length} 类</span>
              <span>{hookSummary.logicalRuns} 次执行</span>
              <span>{hookSummary.rawEvents} 条事件</span>
            </span>
          </h4>
          {hookSummary.groups.length === 0 ? (
            <div className="dim pad2">本会话无 Hook 事件</div>
          ) : (
            hookSummary.groups.map((h) => {
              const tone = hookTone(h)
              const triggerLabel = h.trigger === h.event
                ? null
                : h.trigger.startsWith(`${h.event}:`)
                  ? h.trigger.slice(h.event.length + 1)
                  : h.trigger
              return (
                <div className="hook-group" key={h.key}>
                  <button
                    type="button"
                    className="callrow hook-trigger"
                    onClick={() => h.last && onSelect(h.last)}
                    title="点查看最近一次 hook 事件"
                  >
                    <span className={`sdot ${tone}`} />
                    <span className="hook-trigger-main">
                      <span className="fname" title={`${h.event} · ${h.trigger}`}>
                        {h.event}
                      </span>
                      {triggerLabel && <span className="dim hook-name">{triggerLabel}</span>}
                    </span>
                    <span className="dim hook-count">
                      {h.triggerRuns != null && <>{h.triggerRuns} 次触发 · </>}
                      {h.logicalRuns} 次执行 · {h.rawEvents} 条事件
                    </span>
                  </button>
                  {h.scripts.map((s) => {
                    const scriptTone = hookTone(s)
                    const target = s.lastError ?? s.lastCancelled ?? s.last
                    const failure = hookFailureText(s)
                    const cancellationTitle = hookCancellationTitle(s)
                    const configuredCommands = uniqueConfiguredCommands(s.instances)
                    const logicalHandlers = logicalHookRows(configuredCommands, s.command)
                    const displayedInstances = groupHookInstances(s.instances)
                    const badgeText = hookBadgeText(s)
                    const detailText = hookDetailText(s)
                    const secondaryDetail = detailText && !badgeText.startsWith(detailText) ? detailText : null
                    return (
                      <details className="hook-script overview-hook-script" key={s.key}>
                        <summary
                          className="callrow hook-row indent"
                          title={cancellationTitle ?? '点查看 Hook 执行详情'}
                        >
                          <span className="fname hook-command">{s.label}</span>
                          {secondaryDetail && <span className="dim hook-detail">{secondaryDetail}</span>}
                          <span className={`hook-status ${scriptTone}`}>{badgeText}</span>
                          <Icon name="chevronRight" className="hook-row-chev" />
                        </summary>
                        <div className="turn-hook-detail overview-hook-detail">
                          <div className="hook-actual-block">
                            <div className="hook-detail-label">
                              处理器实例 · {s.instances.length} 个
                              {displayedInstances.length < s.instances.length && ` · 合并为 ${displayedInstances.length} 组`}
                            </div>
                            <div className="hook-instance-list">
                              {displayedInstances.map((instance) => {
                                const averageDuration = formatTurnDuration(instance.averageDurationMs)
                                const timingTitle =
                                  instance.timedCount === instance.count
                                    ? `平均耗时：${averageDuration}`
                                    : `平均耗时：${averageDuration}（${instance.count} 个实例中 ${instance.timedCount} 个上报耗时）`
                                return (
                                  <button
                                    type="button"
                                    className="hook-instance"
                                    key={instance.key}
                                    onClick={() => onSelect(instance.last)}
                                    title="查看该组最近一次 Hook 的原始事件"
                                  >
                                    <span className="hook-instance-index">{instance.count}×</span>
                                    <span className="hook-instance-main">
                                      <strong>{instance.label}</strong>
                                      <span className="hook-instance-source">{instance.sources.join(' / ')}</span>
                                    </span>
                                    {averageDuration && (
                                      <span className="hook-instance-duration" title={timingTitle}>
                                        均 {averageDuration}
                                      </span>
                                    )}
                                    <span className={`hook-run-status ${instance.tone}`}>{instance.status}</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          {logicalHandlers.length > 0 && (
                            <div className="hook-logical-block">
                              <div className="hook-detail-label">逻辑 Hook · {logicalHandlers.length} 个</div>
                              <div className="hook-logical-list">
                                {logicalHandlers.map((handler) => (
                                  <div className="hook-logical-row" key={handler.name}>
                                    <code>{handler.name}</code>
                                    <span>
                                      {handler.deliveries.length} 条投递 · {handler.deliveries.join(' / ')}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {configuredCommands.length > 0 && (
                            <details className="hook-config-deliveries">
                              <summary>
                                当前配置 · {configuredCommands.length} 条投递路径
                                <Icon name="chevronRight" />
                              </summary>
                              <p className="hook-configured-note">
                                这是当前配置反查，不代表本轮每条路径都实际执行。
                              </p>
                              <div className="hook-configured-list">
                                {configuredCommands.map((candidate, index) => (
                                  <div
                                    className="hook-configured-command"
                                    key={`${candidate.source}:${candidate.pluginId ?? ''}:${candidate.matcher ?? ''}:${candidate.command}:${index}`}
                                  >
                                    <span className={`hook-config-scope ${candidate.source}`}>
                                      {hookConfigScopeLabel(candidate.source)}
                                      {candidate.pluginId ? ` · ${candidate.pluginId.split('@')[0]}` : ''}
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
                            </details>
                          )}

                          {logicalHandlers.length === 0 && configuredCommands.length === 0 && (
                            <div className="dim">Provider 未上报具体 command，当前配置也没有可匹配项。</div>
                          )}

                          {failure && (
                            <button
                              type="button"
                              className="hook-failure"
                              onClick={() => target && onSelect(target)}
                              title={failure}
                            >
                              <span>最近失败</span>
                              <code>{failure}</code>
                            </button>
                          )}
                        </div>
                      </details>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
  )
}
