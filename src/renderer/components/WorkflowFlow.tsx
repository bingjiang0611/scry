import { useMemo, useState } from 'react'
import { fmtTok } from '../format-text'
import {
  WORKFLOW_AGENT_STATUS_LABEL,
  WORKFLOW_COPY,
  WORKFLOW_RUN_STATUS_LABEL,
  WORKFLOW_STATUS_EVIDENCE
} from '../constants/workflow-copy'
import type { WorkflowAgentView, WorkflowPhaseView, WorkflowRun } from '../workflow-runs'

/** Chips rendered per phase; a 1,000-agent run must not become 1,000 buttons. */
const MAX_AGENT_CHIPS = 48
const CHIP_PRIORITY: Record<WorkflowAgentView['status'], number> = {
  running: 0, failed: 1, blocked: 1, unsettled: 2, queued: 3, skipped: 4, done: 5, cached: 5
}

export function formatWorkflowDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = Math.round(ms / 1_000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function agentKey(agent: WorkflowAgentView): string {
  return `agent:${agent.row.index}`
}

function visibleAgents(phase: WorkflowPhaseView): { shown: WorkflowAgentView[]; hidden: number } {
  if (phase.agents.length <= MAX_AGENT_CHIPS) return { shown: phase.agents, hidden: 0 }
  // Keep live and failed agents visible; only settled successes are summarized.
  const ranked = [...phase.agents].sort((left, right) =>
    CHIP_PRIORITY[left.status] - CHIP_PRIORITY[right.status] || left.row.index - right.row.index)
  return { shown: ranked.slice(0, MAX_AGENT_CHIPS), hidden: ranked.length - MAX_AGENT_CHIPS }
}

function PhaseCard({ phase, selected, onSelect }: {
  phase: WorkflowPhaseView
  selected: string | null
  onSelect: (key: string | null) => void
}) {
  const { shown, hidden } = useMemo(() => visibleAgents(phase), [phase])
  const total = phase.agents.length
  const percent = total > 0 ? Math.round((phase.settled / total) * 100) : 0
  return (
    <article className="workflow-phase" data-status={phase.status} role="listitem" aria-label={`阶段 ${phase.title}`}>
      <header className="workflow-phase-head">
        <strong title={phase.declared ? undefined : WORKFLOW_COPY.phaseUndeclared}>{phase.title}</strong>
        {/* A synthesized `phase N` title must not pass for a real one. */}
        {!phase.declared && <span className="workflow-phase-undeclared">{WORKFLOW_COPY.phaseUndeclared}</span>}
        {phase.models.map((model) => <code key={model}>{model}</code>)}
      </header>
      {total === 0 ? (
        <p className="workflow-phase-empty">{WORKFLOW_COPY.phaseEmpty}</p>
      ) : (
        <>
          <div
            className="workflow-phase-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={phase.settled}
            aria-label={`${phase.title} ${WORKFLOW_COPY.phaseAgents(phase.settled, total)}`}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="workflow-phase-count">
            <span>{WORKFLOW_COPY.phaseAgents(phase.settled, total)}</span>
            {phase.failed > 0 && <span className="failed">{phase.failed} 失败</span>}
          </div>
          <div className="workflow-agent-chips">
            {shown.map((agent) => {
              const key = agentKey(agent)
              const name = agent.row.label ?? `#${agent.row.index}`
              return (
                <button
                  type="button"
                  className="workflow-agent-chip"
                  data-status={agent.status}
                  aria-pressed={selected === key}
                  aria-label={`${name}：${WORKFLOW_AGENT_STATUS_LABEL[agent.status]}`}
                  title={`${name} · ${WORKFLOW_AGENT_STATUS_LABEL[agent.status]}`}
                  key={key}
                  onClick={() => onSelect(selected === key ? null : key)}
                >
                  <i aria-hidden="true" />
                  <span>{name}</span>
                </button>
              )
            })}
          </div>
          {hidden > 0 && <p className="workflow-phase-more">{WORKFLOW_COPY.phaseMore(hidden)}</p>}
        </>
      )}
    </article>
  )
}

function AgentDetail({ agent, onClose }: { agent: WorkflowAgentView; onClose: () => void }) {
  const { row } = agent
  const model = row.model
  const facts = [
    row.phaseTitle,
    model,
    row.agentType,
    row.isolation,
    row.tokens !== undefined ? `${fmtTok(row.tokens)} ${WORKFLOW_COPY.usageTokens}` : undefined,
    row.toolCalls !== undefined ? `${row.toolCalls} ${WORKFLOW_COPY.usageTools}` : undefined,
    formatWorkflowDuration(row.durationMs)
  ].filter((fact): fact is string => Boolean(fact))
  return (
    <section className="workflow-agent-detail" data-status={agent.status} aria-label={WORKFLOW_COPY.detailTitle}>
      <header>
        <strong>{row.label ?? `agent #${row.index}`}</strong>
        <span className="workflow-chip" data-status={agent.status}>{WORKFLOW_AGENT_STATUS_LABEL[agent.status]}</span>
        <button type="button" onClick={onClose} aria-label={WORKFLOW_COPY.detailClose}>×</button>
      </header>
      <p className="workflow-agent-facts">{facts.map((fact) => <span key={fact}>{fact}</span>)}</p>
      {row.attempt !== undefined && row.attempt > 1 && <p className="note">{WORKFLOW_COPY.detailAttempt(row.attempt, row.lastAttemptReason)}</p>}
      {row.fallbackModel && <p className="note">{WORKFLOW_COPY.detailFallbackModel(row.fallbackModel)}</p>}
      {row.endedWithRun && <p className="note">{WORKFLOW_COPY.detailEndedWithRun}</p>}
      <dl>
        {row.lastToolName && <><dt>{WORKFLOW_COPY.detailLastTool}</dt><dd>{row.lastToolName}{row.lastToolSummary ? ` · ${row.lastToolSummary}` : ''}</dd></>}
        {row.promptPreview && <><dt>{WORKFLOW_COPY.detailPrompt}</dt><dd><pre>{row.promptPreview}</pre></dd></>}
        {row.resultPreview && <><dt>{WORKFLOW_COPY.detailResult}</dt><dd><pre>{row.resultPreview}</pre></dd></>}
        {row.error && <><dt>{WORKFLOW_COPY.detailError}</dt><dd className="error"><pre>{row.error}</pre></dd></>}
      </dl>
    </section>
  )
}

/** Main session -> runtime -> phases -> hand-back, drawn only from observed evidence. */
export function WorkflowFlow({ run }: { run: WorkflowRun }) {
  const [selected, setSelected] = useState<string | null>(null)
  const selectedAgent = useMemo(() => {
    if (!selected) return undefined
    for (const phase of run.phases) {
      const found = phase.agents.find((agent) => agentKey(agent) === selected)
      if (found) return found
    }
    return undefined
  }, [run.phases, selected])
  const ended = run.status === 'completed' || run.status === 'failed' || run.status === 'stopped'
  // The call can arrive after its rows; the run id stays task-based in that case, so the run
  // itself records whether the call was seen instead of inferring it from the id.
  const callObserved = run.toolCallObserved
  const usage = [
    run.usage?.totalTokens !== undefined ? `${fmtTok(run.usage.totalTokens)} ${WORKFLOW_COPY.usageTokens}` : undefined,
    run.usage?.toolUses !== undefined ? `${run.usage.toolUses} ${WORKFLOW_COPY.usageTools}` : undefined,
    formatWorkflowDuration(run.usage?.durationMs)
  ].filter((part): part is string => Boolean(part))

  return (
    <div className="workflow-flow">
      <div className="workflow-node main" data-observed={callObserved}>
        <strong>{WORKFLOW_COPY.mainSession}</strong>
        <span>
          {!callObserved ? WORKFLOW_COPY.mainSessionUnobserved
            : run.script?.source === 'tool_input' ? WORKFLOW_COPY.mainSessionAction : WORKFLOW_COPY.mainSessionCall}
        </span>
      </div>
      <div className="workflow-link" aria-hidden="true" />
      <div className="workflow-node runtime" data-status={run.status}>
        <strong>{WORKFLOW_COPY.runtime}</strong>
        <span>{run.progress === 'observed' ? WORKFLOW_COPY.runtimeAgents(run.agentCount) : WORKFLOW_RUN_STATUS_LABEL[run.status]}</span>
        {usage.length > 0 && <span className="usage" title={WORKFLOW_COPY.usageNote}>{usage.join(' · ')}</span>}
      </div>
      <div className="workflow-link" aria-hidden="true" />
      {run.progress === 'observed' ? (
        <div className="workflow-phases" role="list" aria-label="workflow 阶段">
          {run.phases.map((phase) => <PhaseCard key={phase.key} phase={phase} selected={selected} onSelect={setSelected} />)}
        </div>
      ) : (
        <p className="workflow-unavailable" role="note">
          {run.progress === 'unavailable' ? WORKFLOW_COPY.progressUnavailable : WORKFLOW_COPY.progressPending}
        </p>
      )}
      {selectedAgent && <AgentDetail agent={selectedAgent} onClose={() => setSelected(null)} />}
      <div className="workflow-link" aria-hidden="true" />
      <div className="workflow-node handback" data-status={run.status}>
        <strong>{WORKFLOW_COPY.handback}</strong>
        <span title={WORKFLOW_STATUS_EVIDENCE[run.statusSource]}>
          {ended
            ? `${WORKFLOW_RUN_STATUS_LABEL[run.status]}${run.summary ? ` · ${run.summary}` : ''}`
            : run.status === 'unknown' ? WORKFLOW_COPY.handbackUnknown : WORKFLOW_COPY.handbackWaiting}
        </span>
        {run.error && <span className="error">{run.error}</span>}
      </div>
    </div>
  )
}
