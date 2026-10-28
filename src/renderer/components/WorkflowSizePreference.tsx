import { useEffect, useRef, useState } from 'react'
import { WORKFLOW_SIZE_GUIDELINES, type WorkflowPlanningSize, type WorkflowSizeGuideline, type WorkflowSizeSnapshot } from '../../shared/workflow-size'
import { WORKFLOW_SIZE_COPY as copy } from '../constants/copy'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function WorkflowSizePreference({ onReady, onChanged }: { onReady: (ready: boolean) => void; onChanged: () => void }) {
  const [snapshot, setSnapshot] = useState<WorkflowSizeSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [readAt, setReadAt] = useState<number>()
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const update = async (value?: WorkflowSizeGuideline | null) => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true); setError(null); onReady(false)
    try {
      const next = value === undefined ? await window.scry.workflow.sizeGuideline() : await window.scry.workflow.setSizeGuideline(value)
      if (!mounted.current) return
      setSnapshot(next); setReadAt(Date.now()); onReady(true)
      if (value !== undefined) onChanged()
    } catch (error) {
      if (mounted.current) { setSnapshot(null); setReadAt(undefined); setError(message(error)) }
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void update()
    return () => { mounted.current = false }
  }, [])
  return <div className="workflow-size-setting" aria-busy={pending}>
    {snapshot && snapshot.source !== 'file' ? <label>{copy.title}
      <select data-workflow-size="preference" aria-disabled={pending} value={snapshot.source === 'default' ? 'default' : snapshot.value}
        onChange={event => { if (!inFlight.current) void update(event.target.value === 'default' ? null : event.target.value as WorkflowSizeGuideline) }}>
        <option value="default">{copy.defaultChoice}</option>
        {WORKFLOW_SIZE_GUIDELINES.map(value => <option key={value} value={value}>{copy.values[value]}</option>)}
      </select>
    </label> : <p>{snapshot ? copy.recorded(copy.values[snapshot.value], copy.sources[snapshot.source]) : copy.title}</p>}
    <button type="button" data-workflow-size="refresh" aria-disabled={pending} onClick={() => void update()}>{copy.refresh}</button>
    <p>{snapshot?.source === 'file' ? copy.fileOverride : copy.hint}</p>
    {pending && <p role="status">{copy.loading}</p>}
    {readAt !== undefined && <p>{copy.readAt(new Date(readAt).toLocaleString())}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}

/** Historical rows never substitute today's preference for a missing snapshot. */
export function WorkflowRecordedSize({ value }: { value?: WorkflowPlanningSize }) {
  return <div className="workflow-size-recorded">
    <p>{value ? copy.recorded(copy.values[value.snapshot.value], copy.sources[value.snapshot.source]) : copy.unrecorded}</p>
    {value?.overrideReason !== undefined && <p>{copy.reason(value.overrideReason)}</p>}
  </div>
}
