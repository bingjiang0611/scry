import type {
  DelegatedTaskView,
  DelegatedUsageBreakdownView
} from '../../shared/delegation'
import { DELEGATION_COPY } from '../constants/delegation-copy'
import { Button } from './primitives/Button'
import { Notice } from './primitives/Notice'
import './DelegationPanel.css'

export function DelegatedChildReadOnlyNotice() {
  return (
    <Notice tone="info" className="delegation-readonly-notice">
      {DELEGATION_COPY.childReadOnlyNotice}
    </Notice>
  )
}

export function DelegationTaskCard(props: {
  task: DelegatedTaskView
  onOpenChild?: (childSessionKey: string) => void
}) {
  const { task, onOpenChild } = props
  const statusText = DELEGATION_COPY.statusLabel[task.status]
  const sourceText = DELEGATION_COPY.permissionSource[task.permissionModeSource]
  const summary = task.summary

  return (
    <div className="delegation-card" data-task-id={task.taskId} data-task-status={task.status}>
      <div className="delegation-card-header">
        <span className="delegation-card-title">{task.title || task.taskId}</span>
        <span className="badge">{statusText}</span>
      </div>
      <div className="delegation-card-meta">
        <span>{task.provider}</span>
        <span>·</span>
        <span>{task.permissionMode}（{sourceText}）</span>
      </div>
      <div className="delegation-card-summary">
        {summary && summary.status !== 'unavailable' && summary.value ? (
          <>
            <span>{summary.value}</span>
            <span className="badge">{DELEGATION_COPY.qualityLabel[summary.quality]}</span>
          </>
        ) : (
          <span className="delegation-muted">
            {DELEGATION_COPY.summaryUnavailable}
            {summary?.omissionReason ? `（${summary.omissionReason}）` : ''}
          </span>
        )}
      </div>
      {task.childSessionKey && onOpenChild ? (
        <div className="delegation-card-actions">
          <Button size="sm" variant="secondary" onClick={() => onOpenChild(task.childSessionKey!)}>
            {DELEGATION_COPY.openChildSession}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function DelegationConfirmationCard(props: {
  task: DelegatedTaskView
  kind: 'delegate' | 'cancel'
  onRespond: (taskId: string, questionId: string, approved: boolean) => void
}) {
  const { task, kind, onRespond } = props
  const questionId = kind === 'delegate' ? task.confirmationQuestionId : task.cancelConfirmationQuestionId
  if (!questionId) return null

  return (
    <div className="delegation-card delegation-confirm-card" data-confirm-kind={kind}>
      <div className="delegation-card-header">
        <span className="delegation-card-title">
          {kind === 'delegate' ? DELEGATION_COPY.confirmDelegateTitle : DELEGATION_COPY.confirmCancelTitle}
          {task.title ? `：${task.title}` : ''}
        </span>
        <span className="badge">{DELEGATION_COPY.statusLabel[task.status]}</span>
      </div>
      <div className="delegation-card-meta">
        <span>{task.provider}</span>
        <span>·</span>
        <span>{task.permissionMode}（{DELEGATION_COPY.permissionSource[task.permissionModeSource]}）</span>
      </div>
      <Notice tone="warn">{DELEGATION_COPY.injectionRiskNotice}</Notice>
      <div className="delegation-card-actions">
        <Button size="sm" variant="primary" onClick={() => onRespond(task.taskId, questionId, true)}>
          {kind === 'delegate' ? DELEGATION_COPY.approveDelegate : DELEGATION_COPY.approveCancel}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onRespond(task.taskId, questionId, false)}>
          {kind === 'delegate' ? DELEGATION_COPY.declineDelegate : DELEGATION_COPY.declineCancel}
        </Button>
      </div>
    </div>
  )
}

export function StopAllSubtasksButton(props: {
  activeSubtaskCount: number
  onStopAll: () => void
}) {
  if (props.activeSubtaskCount <= 0) return null
  return (
    <Button size="sm" variant="danger" onClick={props.onStopAll}>
      {DELEGATION_COPY.stopAllSubtasks(props.activeSubtaskCount)}
    </Button>
  )
}

export function DelegationSwitchesSection(props: {
  isLocalHost: boolean
  projectDelegationEnabled: boolean
  sessionFullAccessEnabled: boolean
  onToggleProjectDelegation: (nextEnabled: boolean) => void
  onToggleSessionFullAccess: (nextEnabled: boolean) => void
}) {
  return (
    <div className="delegation-switches">
      {!props.isLocalHost ? (
        <Notice tone="info">{DELEGATION_COPY.switches.remoteReadOnlyNotice}</Notice>
      ) : null}
      <div className="delegation-switch-row">
        <div className="delegation-switch-info">
          <div className="delegation-card-title">{DELEGATION_COPY.switches.projectTitle}</div>
          <div className="delegation-muted">{DELEGATION_COPY.switches.projectDescription}</div>
        </div>
        <Button
          size="sm"
          variant={props.projectDelegationEnabled ? 'primary' : 'secondary'}
          disabled={!props.isLocalHost}
          onClick={() => props.onToggleProjectDelegation(!props.projectDelegationEnabled)}
        >
          {props.projectDelegationEnabled ? DELEGATION_COPY.switches.disableAction : DELEGATION_COPY.switches.enableAction}
        </Button>
      </div>
      <div className="delegation-switch-row">
        <div className="delegation-switch-info">
          <div className="delegation-card-title">{DELEGATION_COPY.switches.fullAccessTitle}</div>
          <div className="delegation-muted">{DELEGATION_COPY.switches.fullAccessDescription}</div>
        </div>
        <Button
          size="sm"
          variant={props.sessionFullAccessEnabled ? 'primary' : 'secondary'}
          disabled={!props.isLocalHost}
          onClick={() => props.onToggleSessionFullAccess(!props.sessionFullAccessEnabled)}
        >
          {props.sessionFullAccessEnabled ? DELEGATION_COPY.switches.disableAction : DELEGATION_COPY.switches.enableAction}
        </Button>
      </div>
    </div>
  )
}

function formatQualityColumns(
  buckets: Partial<Record<'exact' | 'estimated' | 'inferred', number>>,
  formatter: (n: number) => string
): string | null {
  const parts: string[] = []
  for (const q of ['exact', 'estimated', 'inferred'] as const) {
    const val = buckets[q]
    if (typeof val === 'number') parts.push(`${DELEGATION_COPY.qualityLabel[q]} ${formatter(val)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function DelegatedUsageBreakdown(props: { usage: DelegatedUsageBreakdownView }) {
  const { usage } = props
  const tokenLine = formatQualityColumns(usage.tokens, (n) => n.toLocaleString('en-US'))
  const usdLine = formatQualityColumns(usage.usd, (n) => `$${n.toFixed(2)}`)
  const creditsLine = formatQualityColumns(usage.credits, (n) => String(n))

  return (
    <div className="delegation-usage">
      <div className="delegation-card-title">{DELEGATION_COPY.usage.heading}</div>
      {tokenLine ? <div className="delegation-card-meta">{DELEGATION_COPY.usage.tokens}：{tokenLine}</div> : null}
      {usdLine ? <div className="delegation-card-meta">{DELEGATION_COPY.usage.usd}：{usdLine}</div> : null}
      {creditsLine ? <div className="delegation-card-meta">{DELEGATION_COPY.usage.credits}：{creditsLine}</div> : null}
      {!tokenLine && !usdLine && !creditsLine ? (
        <div className="delegation-muted">{DELEGATION_COPY.usage.empty}</div>
      ) : null}
      {usage.unavailableCount > 0 ? (
        <div className="delegation-muted">{DELEGATION_COPY.usage.unavailableChildren(usage.unavailableCount)}</div>
      ) : null}
    </div>
  )
}
