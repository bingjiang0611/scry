import { useEffect, useRef, useState } from 'react'
import type { WorkflowTemplateDraftSummary, WorkflowTemplateRef, WorkflowTemplateScope, WorkflowTemplateSummary } from '@shared/workflow-template'
import type { WorkflowCheckRequest } from '@shared/workflow-check'
import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'
import { WorkflowCheckFixDraftForm } from './WorkflowCheckFixDraftForm'
import { WorkflowBatchMigrationDraftForm } from './WorkflowBatchMigrationDraftForm'

type ScopeKind = WorkflowTemplateScope['kind']
const starter = () => JSON.stringify({ schemaVersion: 1, name: copy.newName, description: '', parameters: { input: { schema: { type: 'string' } } }, roles: [{ role: 'worker' }], body: { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'call', blockId: 'work', role: 'worker', prompt: copy.starter, inputRefs: [{ nodeId: 'input' }] },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'work' } }
] } }, null, 2)
export function WorkflowTemplateCatalog({ cwd, busy, kind, onKind, showDrafts, onShowDrafts, onOpen, onOpenDraft, onNew, onCheckFix, onBatchMigration }: {
  cwd: string
  busy: boolean
  kind: ScopeKind
  onKind: (kind: ScopeKind) => void
  showDrafts: boolean
  onShowDrafts: (value: boolean) => void
  onOpen: (ref: WorkflowTemplateRef) => void
  onOpenDraft: (id: string) => void
  onNew: (source: string) => void
  onCheckFix: (check: WorkflowCheckRequest) => void
  onBatchMigration: (source: string) => void
}) {
  const [catalog, setCatalog] = useState<WorkflowTemplateSummary[]>([]), [cursor, setCursor] = useState<string>()
  const [draftCatalog, setDraftCatalog] = useState<WorkflowTemplateDraftSummary[]>([])
  const [loading, setLoading] = useState(true), epoch = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const load = (next?: string) => {
    const id = ++epoch.current, api = window.scry.workflow.templates
    const scope: WorkflowTemplateScope = kind === 'project' ? { kind, workspace: cwd } : { kind }
    setLoading(true); setError(null)
    const request = showDrafts ? api.drafts(scope, next).then(page => ({ templates: [] as WorkflowTemplateSummary[], drafts: page.drafts, nextCursor: page.nextCursor }))
      : api.catalog(scope, next).then(page => ({ templates: page.templates, drafts: [] as WorkflowTemplateDraftSummary[], nextCursor: page.nextCursor }))
    void request.then(page => { if (id === epoch.current) { setCatalog(page.templates); setDraftCatalog(page.drafts); setCursor(page.nextCursor) } })
      .catch(error => { if (id === epoch.current) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (id === epoch.current) setLoading(false) })
  }
  useEffect(() => { load(); return () => { epoch.current++ } }, [kind, cwd, showDrafts])
  const clear = () => { setLoading(true); setCatalog([]); setDraftCatalog([]); setCursor(undefined) }
  return <section className="workflow-template-catalog">
    <div className="workflow-actions"><label>{copy.scope}<select value={kind} disabled={busy} onChange={event => { clear(); onKind(event.target.value as ScopeKind) }}>
      {(['builtin', 'personal', 'project'] as const).map(kind => <option key={kind} value={kind}>{copy.scopes[kind]}</option>)}</select></label>
      <button type="button" disabled={loading} onClick={() => load()}>{copy.refresh}</button>
      <button type="button" disabled={busy || loading} aria-pressed={showDrafts} onClick={() => { clear(); onShowDrafts(!showDrafts) }}>{showDrafts ? copy.browse : copy.drafts}</button>
      <button type="button" disabled={busy} onClick={() => onNew(starter())}>{copy.new}</button>
    </div>
    <WorkflowCheckFixDraftForm busy={busy} onCreate={onCheckFix} />
    <WorkflowBatchMigrationDraftForm busy={busy} onCreate={onBatchMigration} />
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">{copy.busy}</p>}{!loading && catalog.length === 0 && draftCatalog.length === 0 && <p>{cursor ? copy.pageEmpty : copy.empty}</p>}
    <ul>{catalog.map(item => <li key={item.ref.templateId}><button type="button" disabled={busy} onClick={() => onOpen(item.ref)}>
      <strong>{item.state === 'valid' ? item.name : item.ref.templateId}</strong><span>{copy.sourceIdentity(copy.scopes[item.ref.scope.kind], item.ref.templateId)}</span>
      <span>{item.state === 'valid' ? item.description : item.error}</span></button></li>)}</ul>
    {showDrafts && <ul>{draftCatalog.map(item => <li key={item.draftId}><button type="button" disabled={busy} data-template-draft-id={item.draftId} data-template-validation={item.validation.state} onClick={() => onOpenDraft(item.draftId)}><strong>{item.name ?? item.templateId}</strong><span>{copy.sourceIdentity(copy.scopes[item.scope.kind], item.draftId)}</span><span>{item.validation.state === 'valid' ? copy.sourceValid : item.validation.error}</span></button></li>)}</ul>}
    {cursor && <button type="button" disabled={loading || busy} onClick={() => load(cursor)}>{copy.more}</button>}
  </section>
}
