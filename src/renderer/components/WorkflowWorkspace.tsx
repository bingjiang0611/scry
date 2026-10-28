import { useEffect, useId, useRef, useState } from 'react'
import { WORKFLOW_MAX_ATTEMPTS, type WorkflowPlanPreview, type WorkflowProgress } from '@shared/workflow'
import type { DetectedAgent } from '../env'
import { WORKFLOW_COPY as workflowCopy } from '../constants/copy'
import { WORKFLOW_INSPECTION_COPY as inspection } from '../constants/workflow-inspection-copy'
import { WORKFLOW_WORKSPACE_COPY as copy } from '../constants/workflow-workspace-copy'
import { ModalFrame } from './Modals'
import { WorkflowRunSurface } from './WorkflowRunSurface'
import { WorkflowWorkspacePlan } from './WorkflowWorkspacePlan'
import { WorkflowTemplateWorkbench, type WorkflowTemplateWorkbenchHandle } from './WorkflowTemplateWorkbench'
import './workflow-workspace.css'
import './workflow-inspection.css'

export type WorkflowWorkspaceTab = keyof typeof copy.tabs
type Source = { key: string } & ({ state: 'loading' } | { state: 'ready'; preview: WorkflowPlanPreview } | { state: 'error'; message: string })
const tabs = Object.keys(copy.tabs) as WorkflowWorkspaceTab[]
const canStop = (progress: WorkflowProgress) => ['queued', 'running', 'unknown'].includes(progress.state)

export function WorkflowWorkspace({ cwd, scopeChanged, agents, progresses, initialId, initialTab = 'run', loading, hasMore, error, unresolvedPlanning, onMore, onRead, onStop, onNew, onReview, onRevise, onExtract, onPrepared, onClose }: {
  cwd: string; scopeChanged: boolean; agents: DetectedAgent[]; progresses: WorkflowProgress[]
  initialId?: string; initialTab?: WorkflowWorkspaceTab
  loading: boolean; hasMore: boolean; error: string | null; unresolvedPlanning: number
  onMore: () => void; onRead: (id: string) => Promise<void>; onStop: (progress: WorkflowProgress) => Promise<void>
  onNew?: () => void; onReview: (preview: WorkflowPlanPreview) => void; onRevise: (id: string) => void
  onExtract: (preview: WorkflowPlanPreview) => void; onPrepared: (preview: WorkflowPlanPreview) => void; onClose: () => void
}) {
  const titleId = useId()
  const [view, setView] = useState(initialTab)
  const [selectedId, setSelectedId] = useState(initialId)
  const [sequence, setSequence] = useState(0)
  const [templatesMounted, setTemplatesMounted] = useState(initialTab === 'templates')
  const [templateBusy, setTemplateBusy] = useState(false)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const stoppingRef = useRef(new Set<string>())
  const templates = useRef<WorkflowTemplateWorkbenchHandle>(null)
  const tabRefs = useRef<Partial<Record<WorkflowWorkspaceTab, HTMLButtonElement | null>>>({})
  const records = progresses.slice().reverse()
  const active = records.find(progress => progress.workflowId === selectedId) ?? records[0]
  const sourceKey = JSON.stringify([active?.workflowId, active?.programRevision, sequence])
  const [source, setSource] = useState<Source>({ key: sourceKey, state: 'loading' })
  useEffect(() => {
    if (!active) return
    let current = true
    void window.scry.workflow.preview(active.workflowId).then(preview => {
      if (!current) return
      if (preview.programRevision !== active.programRevision) throw new Error(inspection.sourceChanged)
      setSource({ key: sourceKey, state: 'ready', preview })
    }).catch(error => { if (current) setSource({ key: sourceKey, state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [sourceKey, active?.workflowId, active?.programRevision])
  const current = source.key === sourceKey ? source : { state: 'loading' as const }
  const guard = (next: () => void) => {
    if (templates.current) {
      if (templates.current.requestLeave(next) === 'pending') setView('templates')
    } else next()
  }
  // Keep a dirty editor in its opening scope when the App changes project.
  useEffect(() => { if (scopeChanged) guard(onClose) }, [scopeChanged])
  const navigate = (next: WorkflowWorkspaceTab) => {
    if (next === view || (scopeChanged && next !== 'templates')) return
    guard(() => { if (next === 'templates') setTemplatesMounted(true); setView(next); tabRefs.current[next]?.focus() })
  }
  const select = (id: string) => guard(() => { setSelectedId(id); setView('run') })
  const refresh = async () => {
    if (!active || scopeChanged) return
    await onRead(active.workflowId)
    setSequence(value => value + 1)
  }
  const stop = async (progress: WorkflowProgress) => {
    if (stoppingRef.current.has(progress.workflowId)) return
    stoppingRef.current.add(progress.workflowId)
    setStopping(new Set(stoppingRef.current))
    try { await onStop(progress) }
    finally { stoppingRef.current.delete(progress.workflowId); setStopping(new Set(stoppingRef.current)) }
  }
  const stopButton = (progress: WorkflowProgress) => <button type="button" data-workflow-workspace-stop={progress.workflowId}
    aria-label={copy.stopWorkflow(progress.goal)} disabled={templateBusy || scopeChanged || stopping.has(progress.workflowId)} onClick={() => void stop(progress)}>
    {stopping.has(progress.workflowId) ? copy.requestingStop : progress.stopRequestedAt !== undefined || progress.state === 'unknown' ? workflowCopy.stopAgain : workflowCopy.stop}
  </button>
  return <ModalFrame labelledBy={titleId} className="workflow-workspace" onClose={() => guard(onClose)}>
    <header className="workflow-workspace-header">
      <div className="workflow-workspace-title"><h2 id={titleId}>{copy.title}</h2>{active && <span className="workflow-workspace-state" data-state={active.state}>{active.stopRequestedAt !== undefined && ['queued', 'running'].includes(active.state) ? workflowCopy.stopPending : workflowCopy.status[active.state]}</span>}</div>
      <nav className="workflow-workspace-tabs" role="tablist" aria-label={copy.title}>{tabs.map(tab => <button key={tab} type="button" role="tab"
        ref={element => { tabRefs.current[tab] = element }} id={`${titleId}-${tab}-tab`} aria-controls={`${titleId}-${tab}-panel`}
        aria-selected={view === tab} tabIndex={view === tab ? 0 : -1} disabled={templateBusy || (scopeChanged && tab !== 'templates')} data-workflow-workspace-tab={tab} onClick={() => navigate(tab)}
        onKeyDown={event => {
          const index = tabs.indexOf(tab)
          const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : undefined
          if (target) { event.preventDefault(); navigate(target) }
        }}>{copy.tabs[tab]}</button>)}</nav>
      <div className="workflow-workspace-header-actions">
        {onNew && <button type="button" disabled={templateBusy || scopeChanged} onClick={() => guard(onNew)}>{copy.newWorkflow}</button>}
        <button type="button" data-workflow-workspace-close disabled={templateBusy} onClick={() => guard(onClose)}>{copy.close}</button>
      </div>
    </header>
    <div className="workflow-workspace-context"><label>{copy.choose}<select aria-label={copy.choose} value={active?.workflowId ?? ''} disabled={loading || templateBusy || scopeChanged} onChange={event => select(event.target.value)}>
      {!records.length && <option value="">{copy.noWorkflows}</option>}{records.map(progress => <option key={progress.workflowId} value={progress.workflowId}>{progress.goal}</option>)}
    </select></label><code title={cwd}>{cwd}</code>{hasMore && <button type="button" disabled={loading || templateBusy || scopeChanged} onClick={() => guard(onMore)}>{copy.more}</button>}</div>
    {scopeChanged && <p className="workflow-workspace-alert" role="status">{copy.projectChanged}</p>}
    {!scopeChanged && error && <p className="workflow-workspace-alert" role="alert">{error}</p>}
    {!scopeChanged && unresolvedPlanning > 0 && <p className="workflow-workspace-alert" role="alert">{workflowCopy.unresolvedPlanning(unresolvedPlanning)}</p>}
    <div className="workflow-workspace-body">
      {view !== 'templates' && <section id={`${titleId}-${view}-panel`} role="tabpanel" aria-labelledby={`${titleId}-${view}-tab`}>
        {view === 'manage' ? <section className="workflow-workspace-manage">
          <h3>{copy.tabs.manage}</h3><p>{copy.noAutomaticReplay}</p>
          <div className="workflow-workspace-table-scroll"><table><thead><tr><th>{copy.goal}</th><th>{copy.state}</th><th>{copy.actualCalls}</th><th>{workflowCopy.updatedAt}</th><th>{copy.actions}</th></tr></thead>
            <tbody>{records.map(progress => <tr key={progress.workflowId} data-workflow-workspace-row={progress.workflowId}>
              <td>{progress.goal}</td><td data-state={progress.state}>{workflowCopy.status[progress.state]}</td><td>{copy.calls(progress.dispatchAttempts, WORKFLOW_MAX_ATTEMPTS)}</td>
              <td><time dateTime={new Date(progress.updatedAt).toISOString()}>{new Date(progress.updatedAt).toLocaleString()}</time></td>
              <td><button type="button" onClick={() => select(progress.workflowId)}>{copy.inspect}</button>{canStop(progress) && stopButton(progress)}</td>
            </tr>)}</tbody></table></div>
          {!records.length && <p role="status">{loading ? copy.loading : copy.noWorkflows}</p>}
        </section> : !active ? <div className="workflow-workspace-empty"><p role="status">{loading ? copy.loading : view === 'plan' ? copy.emptyPlan : copy.noWorkflows}</p></div>
          : current.state === 'loading' ? <p role="status">{copy.loading}</p> : current.state === 'error' ? <div><p role="alert">{current.message}</p><button type="button" onClick={() => void refresh()}>{copy.refresh}</button></div>
          : view === 'plan' ? <WorkflowWorkspacePlan preview={current.preview} progress={active} onReview={() => guard(() => onReview(current.preview))} onExtract={() => guard(() => onExtract(current.preview))} onRevise={() => guard(() => onRevise(active.workflowId))} />
          : <><div className="workflow-workspace-runtime"><p>{active.goal}</p><div className="workflow-workspace-runtime-controls"><button type="button" disabled title={copy.pauseUnavailable}>{copy.pause}</button><button type="button" disabled title={copy.restartUnavailable}>{copy.restart}</button>{canStop(active) && stopButton(active)}</div></div>
            <dl className="workflow-workspace-counters"><div><dt>{copy.actualCalls}</dt><dd>{copy.calls(active.dispatchAttempts, WORKFLOW_MAX_ATTEMPTS)}</dd></div><div><dt>{copy.slots}</dt><dd>{copy.slotCount(active.slots.inUse, active.slots.limit, active.slots.queued)}</dd></div><div><dt>{workflowCopy.updatedAt}</dt><dd><time dateTime={new Date(active.updatedAt).toISOString()}>{copy.recordedAt(active.updatedAt)}</time></dd></div></dl>
            <WorkflowRunSurface key={`${active.workflowId}:${current.preview.programRevision}`} progress={active} preview={current.preview} onReloadSource={() => void refresh()} />
          </>}
      </section>}
      {templatesMounted && <div id={`${titleId}-templates-panel`} role="tabpanel" aria-labelledby={`${titleId}-templates-tab`} className="workflow-workspace-template-panel" hidden={view !== 'templates'}>
        <WorkflowTemplateWorkbench ref={templates} embedded cwd={cwd} agents={agents} onBusyChange={setTemplateBusy} onPrepared={onPrepared} onClose={onClose} />
      </div>}
    </div>
    <footer className="workflow-workspace-footer"><span>{copy.noAutomaticReplay}</span><span>{copy.cost}</span></footer>
  </ModalFrame>
}
