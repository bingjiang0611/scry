import { useEffect, useMemo, useRef, useState } from 'react'
import type { Turn } from '../format'
import { deriveWorkflowRuns, type WorkflowRun } from '../workflow-runs'
import {
  WORKFLOW_COPY,
  WORKFLOW_RUN_STATUS_LABEL,
  WORKFLOW_STATUS_EVIDENCE
} from '../constants/workflow-copy'
import { Icon } from './primitives/Icon'
import { WorkflowFlow } from './WorkflowFlow'
import './workflow-surface.css'

/** Script lines rendered; the stored text is already capped by main. */
const MAX_SCRIPT_LINES = 800

function clockTime(ts: string | undefined): string | undefined {
  if (!ts || !Number.isFinite(Date.parse(ts))) return undefined
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function ScriptPane({ run }: { run: WorkflowRun }) {
  const script = run.script
  const lines = useMemo(() => script?.text.split('\n').slice(0, MAX_SCRIPT_LINES) ?? [], [script])
  const activeLines = useMemo(() => {
    const active = new Set<number>()
    if (!script) return active
    for (const phase of run.phases) {
      const line = script.phaseLines[phase.title]
      if (line !== undefined && phase.status === 'running') active.add(line)
    }
    return active
  }, [run.phases, script])
  const facts: Array<[string, string | undefined]> = [
    [WORKFLOW_COPY.facts.task, run.taskId],
    [WORKFLOW_COPY.facts.run, run.providerRunId],
    [WORKFLOW_COPY.facts.script, run.launch?.scriptPath],
    [WORKFLOW_COPY.facts.transcripts, run.launch?.transcriptDir]
  ]
  return (
    <aside className="workflow-script" aria-label={WORKFLOW_COPY.scriptTitle}>
      <header>
        <strong>{WORKFLOW_COPY.scriptTitle}</strong>
        {script && <span title={WORKFLOW_COPY.scriptSource[script.source]}>{script.source === 'tool_input' ? '原文' : 'task_started'}</span>}
      </header>
      {script ? (
        <>
          <ol className="workflow-script-lines">
            {lines.map((line, index) => (
              <li
                key={index}
                data-active={activeLines.has(index + 1) || undefined}
                title={activeLines.has(index + 1) ? WORKFLOW_COPY.activePhaseLine : undefined}
              >
                <code>{line || ' '}</code>
              </li>
            ))}
          </ol>
          {script.truncated && <p className="workflow-note">{WORKFLOW_COPY.scriptTruncated}</p>}
        </>
      ) : (
        <p className="workflow-unavailable" role="note">{WORKFLOW_COPY.scriptUnavailable(run.scriptRef)}</p>
      )}
      <dl className="workflow-facts">
        {facts.map(([label, value]) => value ? (
          <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>
        ) : null)}
      </dl>
    </aside>
  )
}

function RunLog({ run }: { run: WorkflowRun }) {
  const listRef = useRef<HTMLOListElement>(null)
  // Follow new entries only while the reader is already at the end of the log.
  const pinnedRef = useRef(true)
  const newest = run.log.at(-1)?.id
  useEffect(() => {
    const list = listRef.current
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight
  }, [newest])
  return (
    <section className="workflow-log" aria-label={WORKFLOW_COPY.logTitle}>
      <header>
        <strong>{WORKFLOW_COPY.logTitle}</strong>
        {run.logDropped > 0 && <span>{WORKFLOW_COPY.logDropped(run.logDropped)}</span>}
      </header>
      {run.log.length === 0 ? <p className="workflow-note">{WORKFLOW_COPY.logEmpty}</p> : (
        <ol
          ref={listRef}
          onScroll={(event) => {
            const list = event.currentTarget
            pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
          }}
        >
          {run.log.map((entry) => (
            <li key={entry.id} data-tone={entry.tone}>
              <time dateTime={entry.at}>{clockTime(entry.at) ?? '--:--:--'}</time>
              <span className="actor">{entry.actor}</span>
              <span className="message">{entry.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function Notices({ run }: { run: WorkflowRun }) {
  const notices = [
    run.partial ? WORKFLOW_COPY.partial : undefined,
    run.rowsOmitted > 0 ? WORKFLOW_COPY.rowsOmitted(run.rowsOmitted) : undefined,
    run.rowsUnrecognized > 0 ? WORKFLOW_COPY.rowsUnrecognized(run.rowsUnrecognized) : undefined,
    run.usageLimitResetsAt !== undefined && run.status === 'running'
      ? WORKFLOW_COPY.usageLimitWait(new Date(run.usageLimitResetsAt).toLocaleTimeString('zh-CN', { hour12: false }))
      : undefined
  ].filter((notice): notice is string => Boolean(notice))
  if (notices.length === 0) return null
  return <ul className="workflow-notices" role="status">{notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>
}

export function WorkflowSurface({ turns, busy }: { turns: Turn[]; busy: boolean }) {
  const runs = useMemo(() => deriveWorkflowRuns(turns, { busy }), [busy, turns])
  const [pickedId, setPickedId] = useState<string | null>(null)
  // Follow the newest run unless the user picked one that still exists.
  const run = runs.find((candidate) => candidate.id === pickedId) ?? runs.at(-1)
  useEffect(() => {
    if (pickedId && !runs.some((candidate) => candidate.id === pickedId)) setPickedId(null)
  }, [pickedId, runs])

  if (!run) {
    return (
      <section className="workflow-surface" aria-label={WORKFLOW_COPY.surfaceLabel}>
        <div className="workflow-empty">
          <Icon name="workflow" />
          <strong>{WORKFLOW_COPY.emptyTitle}</strong>
          <p>{WORKFLOW_COPY.emptyBody}</p>
        </div>
      </section>
    )
  }

  const settled = run.phases.reduce((total, phase) => total + phase.settled, 0)
  return (
    <section className="workflow-surface" aria-label={WORKFLOW_COPY.surfaceLabel}>
      <header className="workflow-header">
        <Icon name="workflow" />
        <strong title={run.description}>{run.name ?? run.scriptRef ?? WORKFLOW_COPY.title}</strong>
        <span
          className="workflow-chip"
          data-status={run.status}
          title={WORKFLOW_STATUS_EVIDENCE[run.statusSource]}
          aria-label={`${WORKFLOW_RUN_STATUS_LABEL[run.status]}；${WORKFLOW_STATUS_EVIDENCE[run.statusSource]}`}
        >
          {WORKFLOW_RUN_STATUS_LABEL[run.status]}
        </span>
        {run.progress === 'observed' && (
          <span className="workflow-header-count" title={WORKFLOW_COPY.runtimeAgents(run.agentCount)}>agents {settled}/{run.agentCount}</span>
        )}
        {runs.length > 1 && (
          <select
            className="workflow-run-picker"
            aria-label={WORKFLOW_COPY.runPickerLabel}
            value={run.id}
            onChange={(event) => setPickedId(event.target.value)}
          >
            {runs.map((candidate, index) => (
              <option key={candidate.id} value={candidate.id}>{WORKFLOW_COPY.runOption(candidate, index + 1)}</option>
            ))}
          </select>
        )}
      </header>
      <div className="workflow-body">
        <Notices run={run} />
        <div className="workflow-grid">
          <ScriptPane run={run} />
          <WorkflowFlow key={run.id} run={run} />
        </div>
        <RunLog run={run} />
        <p className="workflow-evidence-note">{WORKFLOW_COPY.evidenceNote}</p>
      </div>
    </section>
  )
}
