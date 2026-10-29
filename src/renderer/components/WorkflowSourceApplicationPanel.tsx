import { useEffect, useRef, useState } from 'react'
import type { WorkflowSourceApplicationCatalog, WorkflowSourceApplicationReceipt, WorkflowSourceApplicationReview } from '@shared/workflow-source-application'
import { WORKFLOW_WORKSPACE_COPY as copy } from '../constants/workflow-workspace-copy'

function shortHash(value: string): string { return `${value.slice(0, 10)}…${value.slice(-6)}` }

export function WorkflowSourceApplicationPanel({ workflowId, programRevision, onApplied }: Readonly<{ workflowId: string; programRevision: string; onApplied: () => void }>) {
  const [catalog, setCatalog] = useState<WorkflowSourceApplicationCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmed, setConfirmed] = useState<Record<string, { mutation: boolean; rollback: boolean }>>({})
  const [receipts, setReceipts] = useState<Record<string, WorkflowSourceApplicationReceipt>>({})
  const [unknownDispatches, setUnknownDispatches] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string | null>(null)
  const operationIds = useRef(new Map<string, string>())

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const next = await window.scry.workflow.sourceApplications(workflowId, programRevision)
      setCatalog(next)
      const retryable = new Set(next.items.map(item => item.stepId))
      for (const stepId of retryable) if (receipts[stepId]?.state === 'rejected') operationIds.current.delete(stepId)
      setReceipts(current => {
        const updated = { ...current }
        for (const stepId of retryable) if (updated[stepId]?.state === 'rejected') delete updated[stepId]
        return updated
      })
      setConfirmed(current => { const updated = { ...current }; for (const stepId of retryable) delete updated[stepId]; return updated })
      for (const [stepId, operationId] of operationIds.current) {
        const receipt = next.receipts.find(item => item.operationId === operationId)
        if (!receipt) continue
        setReceipts(current => ({ ...current, [stepId]: receipt }))
        setUnknownDispatches(current => { const updated = { ...current }; delete updated[stepId]; return updated })
      }
    }
    catch (cause) { setError(String(cause)); setCatalog(null) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [workflowId, programRevision])

  const setConfirmation = (stepId: string, key: 'mutation' | 'rollback', value: boolean) => {
    setConfirmed(current => ({ ...current, [stepId]: { mutation: current[stepId]?.mutation ?? false, rollback: current[stepId]?.rollback ?? false, [key]: value } }))
  }
  const apply = async (review: WorkflowSourceApplicationReview) => {
    const confirmation = confirmed[review.stepId]
    if (!confirmation?.mutation || !confirmation.rollback || pending || receipts[review.stepId] || unknownDispatches[review.stepId]) return
    let operationId = operationIds.current.get(review.stepId)
    if (!operationId) { operationId = crypto.randomUUID(); operationIds.current.set(review.stepId, operationId) }
    setPending(review.stepId); setError(null)
    try {
      const receipt = await window.scry.workflow.applySourceApplication({ operationId,
        target: { workflowId: review.workflowId, programRevision: review.programRevision, workflowRevision: review.workflowRevision, stepId: review.stepId, nodeId: review.nodeId },
        expected: { baseHash: review.baseHash, candidateHash: review.candidateHash, trustFingerprint: review.trustFingerprint },
        confirmation: { acknowledgesSourceMutation: true, acknowledgesNoAutomaticRollback: true } })
      setReceipts(current => ({ ...current, [review.stepId]: receipt }))
      if (receipt.state === 'applied' || receipt.state === 'partial') onApplied()
    } catch (cause) { setUnknownDispatches(current => ({ ...current, [review.stepId]: String(cause) })) }
    finally { setPending(null) }
  }

  return <section className="workflow-source-application" aria-labelledby="workflow-source-application-title">
    <div className="workflow-source-application-heading">
      <div><h3 id="workflow-source-application-title">{copy.sourceApplication.title}</h3><p>{copy.sourceApplication.description}</p></div>
      <button type="button" className="workflow-secondary" data-workflow-source-refresh onClick={() => void load()} disabled={loading || pending !== null}>{copy.sourceApplication.refresh}</button>
    </div>
    {loading && <p className="workflow-muted">{copy.sourceApplication.loading}</p>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {!loading && !error && !catalog?.items.length && <p className="workflow-muted">{copy.sourceApplication.empty}</p>}
    {!!catalog?.receipts.length && <div className="workflow-source-history"><h4>{copy.sourceApplication.receipts}</h4>{catalog.receipts.map(receipt => <div className={`workflow-source-receipt is-${receipt.state}`} key={receipt.operationId}>
      <strong>{copy.sourceApplication.result[receipt.state]}</strong><span>{receipt.target.nodeId}</span><code>{receipt.operationId}</code>
      {receipt.changedPaths && <span>{copy.sourceApplication.resultPaths(receipt.changedPaths.length)}</span>}{receipt.reason && <span>{receipt.reason}</span>}
    </div>)}</div>}
    {catalog?.items.map(review => {
      const confirmation = confirmed[review.stepId] ?? { mutation: false, rollback: false }, receipt = receipts[review.stepId], dispatchUnknown = unknownDispatches[review.stepId]
      return <article className="workflow-source-candidate" data-workflow-source-candidate={review.stepId} key={review.stepId}>
        <header><div><strong>{review.nodeId}</strong><span>{copy.sourceApplication.recordedCheck}</span></div><span>{copy.sourceApplication.pathCount(review.changedPaths.length)}</span></header>
        <dl>
          <div><dt>{copy.sourceApplication.sourceHash}</dt><dd><code>{shortHash(review.baseHash)}</code></dd></div>
          <div><dt>{copy.sourceApplication.candidateHash}</dt><dd><code>{shortHash(review.candidateHash)}</code></dd></div>
          <div><dt>{copy.sourceApplication.trustFingerprint}</dt><dd><code>{shortHash(review.trustFingerprint)}</code></dd></div>
        </dl>
        <div className="workflow-source-paths"><span>{copy.sourceApplication.changedPaths}</span><ul>{review.changedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></div>
        {!receipt && !dispatchUnknown && <div className="workflow-source-confirmations">
          <label><input type="checkbox" data-workflow-source-confirm="mutation" checked={confirmation.mutation} onChange={event => setConfirmation(review.stepId, 'mutation', event.target.checked)} />{copy.sourceApplication.acknowledgeMutation}</label>
          <label><input type="checkbox" data-workflow-source-confirm="rollback" checked={confirmation.rollback} onChange={event => setConfirmation(review.stepId, 'rollback', event.target.checked)} />{copy.sourceApplication.acknowledgeRollback}</label>
          <button type="button" className="workflow-primary" data-workflow-source-apply disabled={!confirmation.mutation || !confirmation.rollback || pending !== null} onClick={() => void apply(review)}>
            {pending === review.stepId ? copy.sourceApplication.applying : copy.sourceApplication.apply}
          </button>
        </div>}
        {dispatchUnknown && <div className="workflow-source-receipt is-unknown" role="status"><strong>{copy.sourceApplication.result.unknown}</strong><span>{dispatchUnknown}</span><span>{copy.sourceApplication.unknownWarning}</span></div>}
        {receipt && <div className={`workflow-source-receipt is-${receipt.state}`} role="status">
          <strong>{copy.sourceApplication.result[receipt.state]}</strong>
          {receipt.changedPaths && <span>{copy.sourceApplication.resultPaths(receipt.changedPaths.length)}</span>}
          {receipt.reason && <span>{receipt.reason}</span>}
          {receipt.state === 'unknown' && <span>{copy.sourceApplication.unknownWarning}</span>}
        </div>}
      </article>
    })}
  </section>
}
