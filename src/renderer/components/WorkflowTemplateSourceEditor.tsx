import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'
import type { templateStructure } from '../workflow-template-review'

export function WorkflowTemplateSourceEditor({ text, editable, busy, valid, dirty, structure, page, onChange, onPage }: {
  text: string; editable: boolean; busy: boolean; valid: boolean; dirty: boolean
  structure: ReturnType<typeof templateStructure>; page: number
  onChange: (text: string) => void; onPage: (page: number) => void
}) {
  return <div className="workflow-template-editor-grid"><label>{copy.source}
    <textarea className="workflow-template-source" aria-label={copy.source} value={text} readOnly={!editable} disabled={busy} spellCheck={false} onChange={event => onChange(event.target.value)} />
  </label>
    <section aria-label={copy.structure}><h3>{copy.structure}</h3>{valid ? <>
      <p>{copy.sourceValid}</p><p>{copy.nodesPage(page, structure.length)}</p>
      <ol className="workflow-template-structure">{structure.slice(page, page + 128).map(row => <li key={row.id} style={{ paddingInlineStart: `${row.depth * 12}px` }}>
        <code>{copy.node(row.id, row.kind)}</code>{row.inputs.length > 0 && <span>{copy.inputs}: {row.inputs.join(', ')}</span>}
      </li>)}</ol>
      {page > 0 && <button type="button" onClick={() => onPage(page - 128)}>{copy.previous}</button>}
      {structure.length > page + 128 && <button type="button" onClick={() => onPage(page + 128)}>{copy.more}</button>}
    </> : <p>{dirty ? copy.dirty : copy.sourceInvalid}</p>}</section>
  </div>
}
