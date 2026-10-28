import { useEffect, useState } from 'react'
import type { WorkflowExecutionInspectionKind, WorkflowExecutionInspectionRecord } from '@shared/workflow-inspection'
import { WORKFLOW_INSPECTION_COPY as copy } from '../constants/workflow-inspection-copy'
import type { AvailableWorkflowFrame } from '../workflow-graph'

type GraphRead = { key: string } & (
  { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; records: WorkflowExecutionInspectionRecord[]; frames: Map<string, AvailableWorkflowFrame>; truncated: boolean; framesTruncated: boolean; unassociated: number; observedAt: number }
)

async function page(workflowId: string, programRevision: string, kind: WorkflowExecutionInspectionKind) {
  const response = await window.scry.workflow.inspectExecution({ workflowId, programRevision, kind, offset: 0 })
  if (response.state !== 'available') throw new Error(response.reason === 'source_changed' ? copy.sourceChanged : copy.sourceMissing)
  return response
}

export function useWorkflowGraph(workflowId: string, programRevision: string, refresh: string | number = 0, includeFrameDetails = true) {
  const key = JSON.stringify([workflowId, programRevision, refresh, includeFrameDetails])
  const [read, setRead] = useState<GraphRead>({ key, state: 'loading' })
  useEffect(() => {
    let current = true
    void Promise.all([page(workflowId, programRevision, 'attempts'), page(workflowId, programRevision, 'systems'), page(workflowId, programRevision, 'classifiers')]).then(async pages => {
      if (!current) return
      const pageRecords = pages.flatMap(result => result.records)
      // Root history spans revisions. A reused block ID alone cannot attach an
      // old or intent-less execution to the currently displayed frozen source.
      const records = pageRecords.filter(record => record.intent.state === 'available' && record.intent.value.programRevision === programRevision)
      const unassociated = pageRecords.length - records.length
      const allFrameIds = includeFrameDetails ? [...new Set(records.flatMap(record => record.intent.state === 'available' && record.intent.value.frame.state === 'available' ? [record.intent.value.frame.frameId] : []))] : []
      const frameIds = allFrameIds.slice(0, 64)
      const frames = new Map<string, AvailableWorkflowFrame>()
      for (let index = 0; index < frameIds.length; index += 8) {
        if (!current) return
        const results = await Promise.all(frameIds.slice(index, index + 8).map(async id => [id, await window.scry.workflow.inspectFrame(workflowId, id)] as const))
        for (const [id, frame] of results) if (frame.state === 'available') frames.set(id, frame)
      }
      if (current) setRead({ key, state: 'ready', records, frames, truncated: pages.some(result => result.nextOffset !== undefined), framesTruncated: allFrameIds.length > frameIds.length, unassociated, observedAt: Math.min(...pages.map(result => result.observedAt)) })
    }).catch(error => { if (current) setRead({ key, state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [key, workflowId, programRevision, refresh, includeFrameDetails])
  return read.key === key ? read : { key, state: 'loading' as const }
}
