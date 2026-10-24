import type { ScOperation } from '@shared/source-control'
import { sourceControlOperationCopy as copy } from '../constants/source-control-copy'

export function SourceControlOperations({ operations, busy, onReconcile, onAcknowledge }: {
  operations: ScOperation[]
  busy: boolean
  onReconcile: (operationId: string) => void
  onAcknowledge: (operationId: string) => void
}) {
  return <div className="sc-scroll"><section className="sc-section"><h3>{copy.title}</h3>
    {!operations.length && <p>{copy.empty}</p>}
    {operations.map(op => <article className="sc-operation" key={op.id}>
      <strong>{copy.label(op)}</strong>
      <small>{new Date(op.startedAt).toLocaleString()}</small><p className="sc-wrap">{op.message}</p>
      {op.evidence?.sha && <code>{op.evidence.sha}</code>}
      {op.evidence?.url && <a href={op.evidence.url} target="_blank" rel="noreferrer">{copy.viewPr}</a>}
      {op.evidence?.reviewId && <small>{copy.reviewId(op.evidence.reviewId)}</small>}
      {op.status === 'unknown' && <div className="sc-actions">
        <button disabled={busy} onClick={() => onReconcile(op.id)}>{copy.reconcile}</button>
        {!op.acknowledged && <button disabled={busy} onClick={() => onAcknowledge(op.id)}>{copy.acknowledge}</button>}
      </div>}
    </article>)}
  </section></div>
}
