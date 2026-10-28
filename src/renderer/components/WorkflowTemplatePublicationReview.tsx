import type { templateSourceDifference } from '../workflow-template-review'
import { WORKFLOW_TEMPLATE_COPY as copy } from '../constants/copy'

export function WorkflowTemplatePublicationReview({ difference, baseline, source, project, reviewed, shareReviewed, busy, onReviewed, onShareReviewed, onEdit, onPublish }: {
  difference: ReturnType<typeof templateSourceDifference>
  baseline: string
  source: string
  project: boolean
  reviewed: boolean
  shareReviewed: boolean
  busy: boolean
  onReviewed: (value: boolean) => void
  onShareReviewed: (value: boolean) => void
  onEdit: () => void
  onPublish: () => void
}) {
  return <section className="workflow-template-review">
    <h3>{copy.changedSpan}</h3><p>{copy.difference(difference.removedLines, difference.addedLines)}</p>
    <div className="workflow-template-editor-grid"><label>{copy.before}<textarea readOnly aria-label={copy.before} value={difference.removed} /></label><label>{copy.after}<textarea readOnly aria-label={copy.after} value={difference.added} /></label></div>
    <details><summary>{copy.fullSources}</summary><div className="workflow-template-editor-grid"><textarea aria-label={copy.before} readOnly value={baseline} /><textarea aria-label={copy.after} readOnly value={source} /></div></details>
    <p>{copy.sensitive}</p><label><input type="checkbox" checked={reviewed} onChange={event => onReviewed(event.target.checked)} />{copy.sourceReview}</label>
    {project && <label><input type="checkbox" checked={shareReviewed} onChange={event => onShareReviewed(event.target.checked)} />{copy.projectReview}</label>}
    <div className="workflow-actions"><button type="button" disabled={busy} onClick={onEdit}>{copy.edit}</button><button type="button" disabled={busy || !reviewed || (project && !shareReviewed)} onClick={onPublish}>{copy.publish}</button></div>
  </section>
}
