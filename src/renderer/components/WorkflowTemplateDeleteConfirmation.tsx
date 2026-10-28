import type { WorkflowTemplateSnapshot } from '@shared/workflow-template'
import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'

export function WorkflowTemplateDeleteConfirmation({ snapshot, busy, onDelete, onCancel }: {
  snapshot: WorkflowTemplateSnapshot
  busy: boolean
  onDelete: () => void
  onCancel: () => void
}) {
  return <section className="workflow-workbench-confirm" aria-label={copy.confirmDelete}><h3>{copy.confirmDelete}</h3>
    <code>{JSON.stringify(snapshot.ref)}</code><textarea aria-label={copy.source} readOnly value={snapshot.source} />
    <button type="button" disabled={busy} onClick={onDelete}>{copy.confirmDelete}</button>
    <button type="button" disabled={busy} onClick={onCancel}>{copy.cancel}</button>
  </section>
}
