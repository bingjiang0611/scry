import type { WorkflowTemplateRef } from '@shared/workflow-template'
import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'

export function WorkflowTemplateHistoryPanel({ revisions, cursor, busy, dirty, onOpen, onMore }: {
  revisions: WorkflowTemplateRef[]
  cursor?: string
  busy: boolean
  dirty: boolean
  onOpen: (ref: WorkflowTemplateRef) => void
  onMore: (cursor: string) => void
}) {
  return <section className="workflow-template-history"><h3>{copy.history}</h3><p>{copy.historical}</p>
    {revisions.map(ref => <button type="button" key={ref.revisionHash} disabled={busy || dirty} onClick={() => onOpen(ref)}><code>{ref.revisionHash}</code></button>)}
    {cursor && <button type="button" disabled={busy} onClick={() => onMore(cursor)}>{copy.more}</button>}
  </section>
}
