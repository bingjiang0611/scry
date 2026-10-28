import { useState } from 'react'
import type { WorkflowCheckRequest } from '@shared/workflow-check'
import { WORKFLOW_CHECK_FIX_COPY as copy } from '@shared/constants/workflow-check-fix-copy'

export function WorkflowCheckFixDraftForm({ busy, onCreate }: { busy: boolean; onCreate: (check: WorkflowCheckRequest) => void }) {
  const [argv, setArgv] = useState(''), [cwd, setCwd] = useState('.')
  const [timeout, setTimeout] = useState('10000'), [parser, setParser] = useState<WorkflowCheckRequest['parser']>('exit_code')
  const [error, setError] = useState<string | null>(null)
  const create = () => {
    let parsed: unknown
    try { parsed = JSON.parse(argv) } catch { setError(copy.invalid); return }
    const timeoutMs = Number(timeout)
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((arg): arg is string => typeof arg === 'string') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) { setError(copy.invalid); return }
    setError(null)
    onCreate({ argv: parsed, cwd, timeoutMs, parser })
  }
  return <details className="workflow-check-fix-draft">
    <summary>{copy.title}</summary>
    <p>{copy.description}</p>
    <fieldset disabled={busy}>
      <label>{copy.argv}<textarea value={argv} maxLength={262144} placeholder={copy.placeholder} onChange={event => setArgv(event.target.value)} /></label>
      <label>{copy.cwd}<input value={cwd} maxLength={4096} onChange={event => setCwd(event.target.value)} /></label>
      <label>{copy.parser}<select value={parser} onChange={event => setParser(event.target.value as WorkflowCheckRequest['parser'])}>
        {(['exit_code', 'typescript', 'node_test'] as const).map(value => <option key={value} value={value}>{copy.parsers[value]}</option>)}
      </select></label>
      <label>{copy.timeout}<input type="number" min={1} max={2147483647} value={timeout} onChange={event => setTimeout(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={create}>{copy.create}</button>
    </fieldset>
  </details>
}
