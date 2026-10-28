import { useState } from 'react'
import type { WorkflowPlanPreview } from '@shared/workflow'
import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'

type ParameterChoice = { enabled: boolean; schema: string; include: boolean }
export type TemplateExtractionChoices = {
  name: string
  description: string
  destination: 'personal' | 'project'
  parameters: Record<string, ParameterChoice>
}
export function WorkflowTemplateExtractForm({ preview, busy, onExtract }: {
  preview: WorkflowPlanPreview
  busy: boolean
  onExtract: (choices: TemplateExtractionChoices) => void
}) {
  const [name, setName] = useState(preview.userGoal.slice(0, 200)), [description, setDescription] = useState('')
  const [destination, setDestination] = useState<'personal' | 'project'>('personal')
  const [parameters, setParameters] = useState<Record<string, ParameterChoice>>({}), [page, setPage] = useState(0)
  const binds = preview.program.body.kind === 'sequence' ? preview.program.body.blocks.filter(block => block.kind === 'bind' && block.value.kind === 'literal') : []
  return <section className="workflow-template-extract">
    <h3>{copy.extractDefinition}</h3><p>{copy.extractParameters}</p>
    <label>{copy.name}<input value={name} disabled={busy} onChange={event => setName(event.target.value)} maxLength={200} /></label>
    <label>{copy.description}<input value={description} disabled={busy} onChange={event => setDescription(event.target.value)} maxLength={4096} /></label>
    <label>{copy.destination}<select value={destination} disabled={busy} onChange={event => setDestination(event.target.value as 'personal' | 'project')}><option value="personal">{copy.scopes.personal}</option><option value="project">{copy.scopes.project}</option></select></label>
    <p>{binds.length ? copy.nodesPage(page, binds.length, 16) : copy.noParameters}</p>
    {binds.slice(page, page + 16).map(block => {
      if (block.kind !== 'bind') return null
      const choice = parameters[block.blockId] ?? { enabled: false, schema: block.schema ? JSON.stringify(block.schema) : '', include: false }
      return <fieldset key={block.blockId} disabled={busy}><legend><label><input type="checkbox" checked={choice.enabled} onChange={event => setParameters(current => ({ ...current, [block.blockId]: { ...choice, enabled: event.target.checked } }))} />{block.blockId}</label></legend>
        <label>{copy.schema}<input value={choice.schema} onChange={event => setParameters(current => ({ ...current, [block.blockId]: { ...choice, schema: event.target.value } }))} /></label>
        <label><input type="checkbox" checked={choice.include} onChange={event => setParameters(current => ({ ...current, [block.blockId]: { ...choice, include: event.target.checked } }))} />{copy.includeDefault}</label>
      </fieldset>
    })}
    <div className="workflow-actions">{page > 0 && <button type="button" onClick={() => setPage(value => value - 16)}>{copy.previous}</button>}{binds.length > page + 16 && <button type="button" onClick={() => setPage(value => value + 16)}>{copy.more}</button>}</div>
    <details><summary>{copy.source}</summary><textarea aria-label={copy.source} readOnly value={JSON.stringify(preview.program.body, null, 2)} /></details>
    <p>{copy.sensitive}</p><button type="button" disabled={busy || !name.trim()} onClick={() => onExtract({ name, description, destination, parameters })}>{copy.extractDefinition}</button>
  </section>
}
