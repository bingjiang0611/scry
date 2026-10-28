import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { WorkflowPlanPreview, WorkflowRole, WorkflowRoleBinding } from '@shared/workflow'
import { providerIdForAgentId } from '@shared/runtime'
import type { WorkflowTemplateEditContext, WorkflowTemplateDefinition, WorkflowTemplateDraft, WorkflowTemplateExtraction, WorkflowTemplateRef, WorkflowTemplateScope, WorkflowTemplateSnapshot, WorkflowTemplateSource } from '@shared/workflow-template'
import type { DetectedAgent } from '../env'
import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'
import { templateSourceDifference, templateStructure } from '../workflow-template-review'
import { WorkflowRolePicker } from './WorkflowRolePicker'
import { WorkflowTemplateEditCandidatePanel, type WorkflowTemplateEditCandidateTask } from './WorkflowTemplateEditCandidatePanel'
import { WorkflowTemplateHistoryPanel } from './WorkflowTemplateHistoryPanel'
import { WorkflowTemplateDeleteConfirmation } from './WorkflowTemplateDeleteConfirmation'
import { WorkflowTemplateEditInstruction } from './WorkflowTemplateEditInstruction'
import { WorkflowTemplateCatalog } from './WorkflowTemplateCatalog'
import { WorkflowTemplatePublicationReview } from './WorkflowTemplatePublicationReview'
import { WorkflowTemplateExtractForm, type TemplateExtractionChoices } from './WorkflowTemplateExtractForm'
import { workflowCheckFixTemplate } from '@shared/workflow-check-fix'
import { ModalFrame } from './Modals'
import './workflow.css'

type ScopeKind = WorkflowTemplateScope['kind']
type Editor = { snapshot: WorkflowTemplateSnapshot | null; current: WorkflowTemplateSnapshot | null; draft: WorkflowTemplateDraft | null; text: string; baseline: string | null }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function WorkflowTemplateWorkbench({ cwd, agents, orchestrator, sourcePreview, initialEdit, editTask, onPrepared, onClose }: {
  cwd: string; agents: DetectedAgent[]
  orchestrator?: WorkflowRoleBinding; initialEdit?: WorkflowTemplateEditContext
  editTask?: WorkflowTemplateEditCandidateTask
  sourcePreview?: WorkflowPlanPreview
  onPrepared: (preview: WorkflowPlanPreview) => void; onClose: () => void
}) {
  const titleId = useId(), api = window.scry.workflow.templates
  const [destination, setDestination] = useState<'personal' | 'project'>('personal')
  const [catalogKind, setCatalogKind] = useState<ScopeKind>('personal'), [showDrafts, setShowDrafts] = useState(false)
  const scope = (kind: ScopeKind): WorkflowTemplateScope => kind === 'project' ? { kind, workspace: cwd } : { kind }
  const [editor, setEditor] = useState<Editor | null>(() => initialEdit?.snapshot
    ? { snapshot: initialEdit.snapshot, current: initialEdit.snapshot, draft: null, text: initialEdit.snapshot.source, baseline: initialEdit.snapshot.source }
    : null), [stage, setStage] = useState<'edit' | 'review' | 'bind'>('edit')
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), busyRef = useRef(false), epoch = useRef(0)
  const [leaving, setLeaving] = useState(false), [deleting, setDeleting] = useState(false)
  const [history, setHistory] = useState<WorkflowTemplateRef[] | null>(null), [historyCursor, setHistoryCursor] = useState<string>()
  const [reviewed, setReviewed] = useState(false), [shareReviewed, setShareReviewed] = useState(false)
  const [extracting, setExtracting] = useState(Boolean(sourcePreview))
  const [parameterText, setParameterText] = useState('{}'), [goal, setGoal] = useState('')
  const [bindings, setBindings] = useState<WorkflowRoleBinding[]>([]), [ready, setReady] = useState<Partial<Record<WorkflowRole, boolean>>>({})
  const [structurePage, setStructurePage] = useState(0)
  const commands = useRef<Partial<Record<'publish' | 'delete' | 'instantiate', { fingerprint: string; id: string; settled: boolean }>>>({})
  const commandFor = (operation: 'publish' | 'delete' | 'instantiate', fingerprint: string) => {
    const prior = commands.current[operation]
    if (!prior || prior.fingerprint !== fingerprint || prior.settled) commands.current[operation] = { fingerprint, id: crypto.randomUUID(), settled: false }
    return commands.current[operation]!.id
  }
  const savedText = editor?.draft?.source ?? editor?.snapshot?.source
  const dirty = Boolean(editor && editor.text !== savedText)
  const definition = useMemo<WorkflowTemplateDefinition | null>(() => {
    if (!editor || dirty) return null
    if (editor.draft) return editor.draft.validation.state === 'valid' ? JSON.parse(editor.draft.source) as WorkflowTemplateDefinition : null
    return editor.snapshot?.state === 'valid' ? editor.snapshot.definition : null
  }, [editor, dirty])
  const structure = useMemo(() => definition ? templateStructure(definition.body) : [], [definition])
  const difference = useMemo(() => editor && editor.baseline !== null && stage === 'review' ? templateSourceDifference(editor.baseline, editor.text) : null, [editor, stage])
  const editable = Boolean(editor?.draft)
  useEffect(() => { setStructurePage(0) }, [editor?.draft?.candidateHash, editor?.snapshot?.ref.revisionHash])
  useEffect(() => () => { epoch.current++ }, [])
  const action = async <T,>(run: () => Promise<T>, apply: (result: T) => void) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    const id = epoch.current
    try { const result = await run(); if (id === epoch.current) apply(result) }
    catch (error) { if (id === epoch.current) setError(message(error)) }
    finally { busyRef.current = false; if (id === epoch.current) setBusy(false) }
  }
  const acceptDraft = (draft: WorkflowTemplateDraft, baseline = editor ? editor.baseline : '') => {
    setEditor(current => {
      const same = current?.draft?.draftId === draft.draftId || (current?.snapshot?.ref.templateId === draft.templateId && JSON.stringify(current.snapshot.ref.scope) === JSON.stringify(draft.scope))
      return { snapshot: same ? current!.snapshot : null, current: same ? current!.current : null, baseline: same ? baseline : '', draft, text: draft.source }
    })
    setStage('edit'); setReviewed(false); setShareReviewed(false); setNotice(null); setLeaving(false)
  }
  const open = (ref: WorkflowTemplateRef) => void action(async () => {
    const snapshot = await api.read(ref.scope, ref.templateId)
    if (!snapshot) throw new Error(copy.missing)
    return snapshot
  }, snapshot => { setEditor({ snapshot, current: snapshot, draft: null, text: snapshot.source, baseline: snapshot.source }); setHistory(null); setStage('edit'); setStructurePage(0); setNotice(null); setReviewed(false) })
  const openDraft = (id: string) => void action(async () => {
    const draft = await api.draft(id)
    const current = await api.read(draft.scope, draft.templateId)
    const base = draft.base ? await api.revision(draft.base) : null
    return { draft, base, current }
  }, ({ draft, base, current }) => {
    setEditor({ draft, snapshot: base, current, text: draft.source, baseline: draft.base ? base?.source ?? null : '' })
    setHistory(null); setStage('edit'); setNotice(draft.base && !base ? copy.missing : null); setReviewed(false); setShareReviewed(false)
  })
  const keep = (then?: () => void) => {
    if (!editor?.draft) return
    const { draft, text } = editor
    void action(() => api.saveDraft({ scope: draft.scope, source: text, draftId: draft.draftId, expectedDraftRevision: draft.draftRevision, ...(draft.base ? { base: draft.base } : {}) }), next => { acceptDraft(next); then?.() })
  }
  const close = () => { if (!busyRef.current) { if (dirty) setLeaving(true); else onClose() } }
  const beginBinding = () => {
    if (!definition || !editor || dirty) return
    const selectedAgent = agents.find(agent => !agent.unavailableReason && providerIdForAgentId(agent.id))
    const seed = orchestrator ?? (selectedAgent ? { role: 'orchestrator' as const, providerId: providerIdForAgentId(selectedAgent.id)!, ...(providerIdForAgentId(selectedAgent.id) === 'pi' ? { agentProfileId: selectedAgent.id } : {}), permissionMode: 'default' as const } : null)
    if (!seed) { setError(copy.noAgent); return }
    const { runtimeIdentity: _runtime, ...input } = seed
    const roles = [...new Set<WorkflowRole>(['orchestrator', ...definition.roles.map(role => role.role)])]
    setBindings(roles.map(role => ({ ...input, role }))); setReady({})
    setParameterText(JSON.stringify(Object.fromEntries(Object.entries(definition.parameters).filter(([, parameter]) => Object.hasOwn(parameter, 'default')).map(([name, parameter]) => [name, parameter.default])), null, 2))
    setGoal(definition.name); setStage('bind')
  }
  const prepare = () => {
    if (!editor || !definition || !bindings.length) return
    void action(async () => {
      const source: WorkflowTemplateSource = editor.draft ? { kind: 'draft', draftId: editor.draft.draftId, draftRevision: editor.draft.draftRevision, candidateHash: editor.draft.candidateHash }
        : { kind: 'saved', ref: editor.snapshot!.ref }
      const request = { source, cwd, userGoal: goal, parameters: JSON.parse(parameterText), orchestrator: bindings[0], roles: bindings.slice(1) }
      return window.scry.workflow.instantiateTemplate({ ...request, commandId: commandFor('instantiate', JSON.stringify(request)) })
    }, onPrepared)
  }
  const extract = ({ name, description, destination, parameters: choices }: TemplateExtractionChoices) => {
    if (!sourcePreview) return
    void action(() => {
      const parameters: WorkflowTemplateExtraction['parameters'] = Object.create(null)
      for (const [name, choice] of Object.entries(choices)) if (choice.enabled) parameters[name] = { schema: JSON.parse(choice.schema), default: choice.include ? 'include' : 'omit' }
      return window.scry.workflow.extractTemplate({ workflowId: sourcePreview.workflowId, programRevision: sourcePreview.programRevision, scope: scope(destination) as WorkflowTemplateExtraction['scope'], name, description, parameters })
    }, draft => { setExtracting(false); acceptDraft(draft, '') })
  }
  const publish = () => {
    const draft = editor?.draft
    if (!draft || dirty || draft.validation.state !== 'valid' || !reviewed || (draft.scope.kind === 'project' && !shareReviewed)) return
    void action(() => api.publish({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: commandFor('publish', draft.candidateHash) }), result => {
      if (result.state !== 'unknown') commands.current.publish!.settled = true
      if (result.state === 'published') setNotice(copy.published)
      else setNotice(result.state === 'conflict' ? copy.conflict : copy.unknown)
    })
  }
  const deleteCurrent = () => {
    const current = editor?.current
    if (!editor || !current) return
    void action(async () => {
      const result = await api.delete({ ref: current.ref, commandId: commandFor('delete', JSON.stringify(current.ref)) })
      const latest = await api.read(current.ref.scope, current.ref.templateId)
      return { result, latest }
    }, ({ result, latest }) => {
      if (result.state !== 'unknown') commands.current.delete!.settled = true
      setDeleting(false)
      if (result.state === 'deleted') {
        setEditor(value => value ? { ...value, current: latest } : value)
        setNotice(latest ? copy.deleteRecorded : copy.deleted)
      } else setNotice(result.state === 'conflict' ? copy.conflict : copy.unknown)
    })
  }
  const readHistory = (next?: string) => {
    const ref = editor?.snapshot?.ref
    if (!ref) return
    void action(() => api.history(ref.scope, ref.templateId, next), page => { setHistory(page.revisions); setHistoryCursor(page.nextCursor) })
  }
  return <ModalFrame labelledBy={titleId} className="workflow-workbench" onClose={close}>
    <header className="workflow-workbench-header"><h2 id={titleId}>{copy.title}</h2><button type="button" disabled={busy} onClick={close}>{copy.close}</button></header>
    {initialEdit && <WorkflowTemplateEditInstruction edit={initialEdit} hasEditor={Boolean(editor)} />}
    <p>{copy.workspace}: <code>{cwd}</code></p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {leaving && <section className="workflow-workbench-confirm" aria-label={copy.leave}><h3>{copy.leave}</h3>
      <button type="button" disabled={busy} onClick={() => keep(onClose)}>{copy.keepAndClose}</button>
      <button type="button" disabled={busy} onClick={onClose}>{copy.discardAndClose}</button><button type="button" onClick={() => setLeaving(false)}>{copy.stay}</button>
    </section>}
    {extracting && sourcePreview ? <WorkflowTemplateExtractForm preview={sourcePreview} busy={busy} onExtract={extract} /> : !editor ? <WorkflowTemplateCatalog cwd={cwd} busy={busy} kind={catalogKind} onKind={setCatalogKind} showDrafts={showDrafts} onShowDrafts={setShowDrafts} onOpen={open} onOpenDraft={openDraft}
      onNew={source => void action(() => api.saveDraft({ scope: scope(destination), source }), draft => acceptDraft(draft, ''))}
      onCheckFix={check => void action(() => api.saveDraft({ scope: scope('project'), source: JSON.stringify(workflowCheckFixTemplate(check), null, 2) }), draft => acceptDraft(draft, ''))}
      onBatchMigration={source => void action(() => api.saveDraft({ scope: scope('project'), source }), draft => acceptDraft(draft, ''))} /> : <>
      <div className="workflow-actions">
        <button type="button" disabled={busy} onClick={() => { if (dirty) { setLeaving(true); return } setEditor(null); setHistory(null); setStage('edit'); setNotice(null) }}>{copy.browse}</button>
        {editor.draft && <code>{copy.sourceIdentity(copy.scopes[editor.draft.scope.kind], editor.draft.templateId)}</code>}
        {editor.snapshot && <><code>{copy.sourceIdentity(copy.scopes[editor.snapshot.ref.scope.kind], editor.snapshot.ref.templateId)}</code><button type="button" disabled={busy} onClick={() => readHistory()}>{copy.history}</button></>}
      </div>
      {history && <WorkflowTemplateHistoryPanel revisions={history} cursor={historyCursor} busy={busy} dirty={dirty} onMore={readHistory}
        onOpen={ref => void action(async () => { const old = await api.revision(ref); if (!old) throw new Error(copy.missing); return old }, old => { setEditor(current => current ? { ...current, snapshot: old, draft: null, text: old.source } : current); setStage('edit'); setNotice(copy.historical) })} />}
      {editor.snapshot?.ref.scope.kind === 'builtin' && !editor.draft && <p>{copy.readOnly}</p>}
      {dirty && <p role="status">{copy.dirty}</p>}
      {editor.draft && <p>{copy.draftRevision}: {editor.draft.draftRevision} · {copy.candidate}: <code>{editor.draft.candidateHash}</code></p>}
      {editor.snapshot && <p>{copy.revision}: <code>{editor.snapshot.ref.revisionHash}</code></p>}
      {initialEdit && editTask && !editor.draft && <WorkflowTemplateEditCandidatePanel task={editTask} snapshot={initialEdit.snapshot ?? editor.snapshot ?? undefined} current={editor.snapshot} agents={agents} cwd={cwd} orchestrator={orchestrator} disabled={busy}
        onDraft={draft => acceptDraft(draft, initialEdit.snapshot?.source ?? '')} />}
      {stage === 'edit' && <>
        <div className="workflow-template-editor-grid"><label>{copy.source}<textarea className="workflow-template-source" aria-label={copy.source} value={editor.text} readOnly={!editable} disabled={busy} spellCheck={false} onChange={event => { setEditor(current => current ? { ...current, text: event.target.value } : current); setReviewed(false); setShareReviewed(false) }} /></label>
          <section aria-label={copy.structure}><h3>{copy.structure}</h3>{definition ? <><p>{copy.sourceValid}</p><p>{copy.nodesPage(structurePage, structure.length)}</p><ol className="workflow-template-structure">{structure.slice(structurePage, structurePage + 128).map(row => <li key={row.id} style={{ paddingInlineStart: `${row.depth * 12}px` }}><code>{copy.node(row.id, row.kind)}</code>{row.inputs.length > 0 && <span>{copy.inputs}: {row.inputs.join(', ')}</span>}</li>)}</ol>
            {structurePage > 0 && <button type="button" onClick={() => setStructurePage(value => value - 128)}>{copy.previous}</button>}
            {structure.length > structurePage + 128 && <button type="button" onClick={() => setStructurePage(value => value + 128)}>{copy.more}</button>}</> : <p>{dirty ? copy.dirty : copy.sourceInvalid}</p>}</section>
        </div>
        {editor.draft?.validation.state === 'invalid' && <p role="alert">{editor.draft.validation.error}</p>}
        <div className="workflow-actions">
          {!editor.draft && editor.snapshot && editor.snapshot.ref.scope.kind !== 'builtin' && <button type="button" disabled={busy} onClick={() => void action(() => api.restoreDraft({ ref: editor.snapshot!.ref, base: editor.current?.ref ?? null }), draft => acceptDraft(draft))}>{editor.current?.ref.revisionHash === editor.snapshot.ref.revisionHash ? copy.edit : copy.restore}</button>}
          <label>{copy.destination}<select value={destination} disabled={busy} onChange={event => setDestination(event.target.value as 'personal' | 'project')}><option value="personal">{copy.scopes.personal}</option><option value="project">{copy.scopes.project}</option></select></label>
          <button type="button" disabled={busy} onClick={() => void action(() => api.saveDraft({ scope: scope(destination), source: editor.text }), draft => acceptDraft(draft, ''))}>{copy.saveAs}</button>
          {editor.draft && <><button type="button" disabled={busy || !dirty} onClick={() => keep()}>{copy.saveDraft}</button><button type="button" disabled={busy || dirty || !definition || editor.baseline === null} onClick={() => { setStage('review'); setReviewed(false); setShareReviewed(false) }}>{copy.review}</button></>}
          <button type="button" disabled={busy || !definition || dirty} onClick={beginBinding}>{copy.onlyRun}</button>
          {editor.current && editor.current.ref.scope.kind !== 'builtin' && <button type="button" disabled={busy || dirty} onClick={() => setDeleting(true)}>{copy.delete}</button>}
        </div>
      </>}
      {stage === 'review' && difference && editor.baseline !== null && <WorkflowTemplatePublicationReview
        difference={difference} baseline={editor.baseline} source={editor.text} project={editor.draft?.scope.kind === 'project'}
        reviewed={reviewed} shareReviewed={shareReviewed} busy={busy} onReviewed={setReviewed} onShareReviewed={setShareReviewed} onEdit={() => setStage('edit')} onPublish={publish} />}
      {stage === 'bind' && <section className="workflow-template-bind"><h3>{copy.bind}</h3>
        <label>{copy.goal}<input disabled={busy} value={goal} onChange={event => setGoal(event.target.value)} maxLength={16000} /></label>
        <label>{copy.parameters}<textarea disabled={busy} aria-label={copy.parameters} value={parameterText} onChange={event => setParameterText(event.target.value)} spellCheck={false} /></label>
        {bindings.map(binding => <WorkflowRolePicker key={binding.role} binding={binding} agents={agents} cwd={cwd} disabled={busy} onChange={next => setBindings(current => current.map(item => item.role === next.role ? next : item))} onReady={(role, value) => setReady(current => ({ ...current, [role]: value }))} />)}
        <div className="workflow-actions"><button type="button" disabled={busy} onClick={() => setStage('edit')}>{copy.edit}</button><button type="button" disabled={busy || !goal.trim() || bindings.some(role => !ready[role.role])} onClick={prepare}>{copy.prepare}</button></div>
      </section>}
      {deleting && editor.current && <WorkflowTemplateDeleteConfirmation snapshot={editor.current} busy={busy} onDelete={deleteCurrent} onCancel={() => setDeleting(false)} />}
    </>}
  </ModalFrame>
}
