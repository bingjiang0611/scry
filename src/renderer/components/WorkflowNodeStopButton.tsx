import { useEffect, useRef, useState } from 'react'
import type { WorkflowStopTarget } from '@shared/workflow-api'
import type { WorkflowAttemptProgress } from '@shared/workflow'
import { WORKFLOW_COPY as copy } from '../constants/copy'

type StopRequest =
  | { commandId: string; state: 'pending' | 'acknowledged' }
  | { commandId: string; state: 'unknown' | 'unavailable'; error: string }

export function WorkflowNodeStopButton({ workflowId, target, nodeId, settled, stopRequested, onChanged }: {
  workflowId: string
  target: WorkflowStopTarget
  nodeId: string
  settled: boolean
  stopRequested?: WorkflowAttemptProgress['stopRequested']
  onChanged(id: string): void
}) {
  const [request, setRequest] = useState<StopRequest>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  if (settled && !request && !stopRequested) return null
  const pending = request?.state === 'pending'
  const acknowledged = request?.state === 'acknowledged'
  const automatic = stopRequested?.provenance?.source === 'auto' ? stopRequested.provenance : undefined
  const stopAgain = acknowledged || (!request && automatic !== undefined)
  const retry = request?.state === 'unknown' || (!request && stopRequested !== undefined && !automatic)
  const unavailable = request?.state === 'unavailable'
  const label = settled ? copy.scopeClosed : pending ? copy.nodeStopPending : unavailable ? copy.nodeStopUnavailable
    : retry ? copy.nodeStopRetry : stopAgain ? copy.nodeStopAgain : copy.nodeStop

  const stop = async () => {
    if (pending || settled || unavailable) return
    // User retries retain their identity. A policy receipt cannot be rebound
    // as user intent; its explicit stop-again action creates a separate command.
    const commandId = stopAgain ? crypto.randomUUID() : request?.commandId ?? stopRequested?.commandId ?? crypto.randomUUID()
    setRequest({ commandId, state: 'pending' })
    let accepted: boolean
    try {
      accepted = await window.scry.workflow.stopNode(workflowId, target, commandId)
    } catch (error) {
      if (mounted.current) {
        setRequest({ commandId, state: 'unknown', error: error instanceof Error ? error.message : String(error) })
        onChanged(workflowId)
      }
      return
    }
    if (!mounted.current) return
    setRequest(accepted ? { commandId, state: 'acknowledged' } : { commandId, state: 'unavailable', error: copy.stopUnavailable })
    onChanged(workflowId)
  }

  return <span className="workflow-node-stop">
    <button type="button" data-workflow-action="stop-node" data-workflow-node-kind={target.kind} data-workflow-target={target.id}
      aria-disabled={pending || settled || unavailable} aria-busy={pending} tabIndex={settled || unavailable ? -1 : 0}
      aria-label={copy.nodeStopAction(label, nodeId)} onClick={() => { void stop() }}>{label}</button>
    {automatic && <span role="status">{copy.nodeStopAutomatic(automatic.trigger.nodeId)}</span>}
    {acknowledged && !settled && <span role="status">{copy.nodeStopRecorded}</span>}
    {request && 'error' in request && <span role="alert">{request.error}</span>}
  </span>
}
