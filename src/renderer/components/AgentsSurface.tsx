import { EmptyState } from './primitives/EmptyState'
import { OVERVIEW_SESSION_COPY } from '../constants/copy'
import { useMemo, type CSSProperties } from 'react'
import type { Turn } from '../format'
import { deriveAgentRows, type AgentRow, type AgentRowStatus } from '../agent-panel'
import { Icon } from './primitives/Icon'
import { useDelegationState } from '../hooks/useDelegationState'
import {
  DelegatedUsageBreakdown,
  DelegationConfirmationCard,
  DelegationSwitchesSection,
  DelegationTaskCard,
  StopAllSubtasksButton
} from './DelegationPanel'

const STATUS_LABEL: Record<AgentRowStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  unknown: '状态未知'
}

const STATUS_EVIDENCE: Record<AgentRow['statusSource'], string> = {
  active_turn: '来自当前未结束的真实 turn',
  tool_result: '来自 Agent tool_result',
  tool_error: '来自失败的 Agent tool_result',
  tool_stopped: '来自 Provider 上报的 stopped/cancelled/interrupted 终态',
  missing_terminal: 'Provider 未上报子 Agent 终态；不根据父轮结束状态推断'
}

function clockTime(ts: string | undefined): string | undefined {
  if (!ts || !Number.isFinite(Date.parse(ts))) return undefined
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function shortId(id: string): string {
  return id.length > 18 ? `…${id.slice(-12)}` : id
}

export function AgentsSurface({
  turns,
  busy,
  cwd,
  sessionKey,
  isLocalHost = true
}: {
  turns: Turn[]
  busy: boolean
  cwd?: string | null
  sessionKey?: string | null
  isLocalHost?: boolean
}) {
  const rows = useMemo(() => deriveAgentRows(turns, { busy }), [busy, turns])
  const delegation = useDelegationState(cwd, sessionKey)
  const activeDelegatedCount = delegation.state.tasks.filter(
    (t) => !['completed', 'failed', 'cancelled', 'interrupted', 'unavailable', 'declined'].includes(t.status)
  ).length
  const counts = useMemo(() => ({
    running: rows.filter((row) => row.status === 'running').length,
    completed: rows.filter((row) => row.status === 'completed').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    stopped: rows.filter((row) => row.status === 'stopped').length,
    unknown: rows.filter((row) => row.status === 'unknown').length
  }), [rows])
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])

  return (
    <section className="agents-surface" aria-label="子 Agent">
      <header className="agents-surface-header">
        <div className="agents-surface-title">
          <Icon name="agents" />
          <strong>子 Agent</strong>
          <span>{rows.length}</span>
        </div>
        {rows.length > 0 && (
          <div className="agents-surface-summary" aria-label="子 Agent 状态汇总">
            <span className="running">运行 {counts.running}</span>
            <span>完成 {counts.completed}</span>
            {counts.failed > 0 && <span className="failed">失败 {counts.failed}</span>}
            {counts.stopped > 0 && <span className="stopped">停止 {counts.stopped}</span>}
            {counts.unknown > 0 && <span className="unknown">未知 {counts.unknown}</span>}
          </div>
        )}
      </header>

      {(cwd || sessionKey) && (
        <div className="delegation-surface-section">
          <DelegationSwitchesSection
            isLocalHost={isLocalHost}
            projectDelegationEnabled={delegation.state.projectDelegationEnabled}
            sessionFullAccessEnabled={delegation.state.sessionFullAccessEnabled}
            onToggleProjectDelegation={(next) => { void delegation.toggleProject(next) }}
            onToggleSessionFullAccess={(next) => { void delegation.toggleSessionFullAccess(next) }}
          />
          {activeDelegatedCount > 0 && (
            <StopAllSubtasksButton
              activeSubtaskCount={activeDelegatedCount}
              onStopAll={() => { void delegation.stopAllSubtasks() }}
            />
          )}
          {delegation.state.tasks.map((task) => {
            if (task.status === 'awaiting_confirmation' && task.confirmationQuestionId) {
              return (
                <DelegationConfirmationCard
                  key={`confirm-${task.taskId}`}
                  kind="delegate"
                  task={task}
                  onRespond={(taskId, questionId, approved) => { void delegation.confirmTask(taskId, questionId, approved) }}
                />
              )
            }
            if (task.cancelConfirmationQuestionId) {
              return (
                <DelegationConfirmationCard
                  key={`cancel-${task.taskId}`}
                  kind="cancel"
                  task={task}
                  onRespond={(taskId, questionId, approved) => { void delegation.confirmCancelTask(taskId, questionId, approved) }}
                />
              )
            }
            return <DelegationTaskCard key={task.taskId} task={task} />
          })}
          {delegation.state.tasks.length > 0 && (
            <DelegatedUsageBreakdown usage={delegation.state.usageBreakdown} />
          )}
        </div>
      )}

      {rows.length === 0 && delegation.state.tasks.length === 0 ? (
        <EmptyState size="card" picture="agents" title={OVERVIEW_SESSION_COPY.noSubagents} />
      ) : (
        <div className="agents-list" role="list">
          {rows.map((row) => {
            const parent = row.parentId ? byId.get(row.parentId) : undefined
            const started = clockTime(row.startedAt)
            return (
              <article
                className="agent-row"
                data-status={row.status}
                data-depth={row.depth}
                key={row.id}
                role="listitem"
                style={{ '--agent-depth': row.depth } as CSSProperties}
              >
                <div className="agent-row-head">
                  <span className={`agent-status-dot ${row.status}`} aria-hidden="true" />
                  <div className="agent-identity">
                    <strong>{row.name}</strong>
                    <code title={row.id}>{shortId(row.id)}</code>
                  </div>
                  <span
                    className={`agent-status ${row.status}`}
                    title={STATUS_EVIDENCE[row.statusSource]}
                    aria-label={`${STATUS_LABEL[row.status]}；${STATUS_EVIDENCE[row.statusSource]}`}
                  >
                    {STATUS_LABEL[row.status]}
                  </span>
                </div>

                {(parent || row.model || row.providerId) && (
                  <div className="agent-row-context">
                    {parent && <span>上级 {parent.name}</span>}
                    {row.providerId && <span>{row.providerId}</span>}
                    {row.model && <span>{row.model}</span>}
                  </div>
                )}

                <div className="agent-row-metrics">
                  <span title="由归属于该子 Agent 的真实 tool/tool_result 去重计数">
                    <Icon name="tool" /> {row.toolCount} 个工具调用
                  </span>
                  {started && (
                    <time dateTime={row.startedAt} title={row.startedAt}>
                      <Icon name="clock" /> {started}
                    </time>
                  )}
                </div>

                {row.recentActivity.length > 0 && (
                  <ol className="agent-recent" aria-label={`${row.name} 最近活动`}>
                    {row.recentActivity.slice(0, 3).map((activity) => {
                      const at = clockTime(activity.at)
                      return (
                        <li key={activity.id}>
                          <span>{activity.label}</span>
                          {at && <time dateTime={activity.at} title={activity.at}>{at}</time>}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </article>
            )
          })}
        </div>
      )}

    </section>
  )
}
