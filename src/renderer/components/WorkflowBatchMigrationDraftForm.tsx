import { useState } from 'react'
import type { WorkflowCheckRequest } from '@shared/workflow-check'
import type { WorkflowValue } from '@shared/workflow'
import { workflowBatchMigrationTemplate, WORKFLOW_BATCH_MIGRATION_MAX_ITEMS, type WorkflowBatchMigrationInput } from '@shared/workflow-batch-migration'
import { WORKFLOW_BATCH_MIGRATION_COPY as copy } from '@shared/constants/workflow-batch-migration-copy'

export function WorkflowBatchMigrationDraftForm({ busy, onCreate }: { busy: boolean; onCreate: (source: string) => void }) {
  const [items, setItems] = useState('[]'), [goal, setGoal] = useState(''), [instruction, setInstruction] = useState('')
  const [argv, setArgv] = useState(''), [cwd, setCwd] = useState('.'), [parser, setParser] = useState<WorkflowCheckRequest['parser']>('exit_code')
  const [timeout, setTimeout] = useState('10000'), [error, setError] = useState<string | null>(null)
  const create = () => {
    try {
      const parsed: unknown = JSON.parse(items), argvValue: unknown = JSON.parse(argv), timeoutMs = Number(timeout)
      if (!Array.isArray(parsed) || parsed.length > WORKFLOW_BATCH_MIGRATION_MAX_ITEMS || parsed.some(value => !value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'key'))) throw new Error(copy.invalidItems)
      if (!Array.isArray(argvValue) || !argvValue.length || !argvValue.every(value => typeof value === 'string')) throw new Error(copy.invalidCheck)
      const input: WorkflowBatchMigrationInput = { items: parsed.map(value => ({ key: (value as { key: WorkflowBatchMigrationInput['items'][number]['key'] }).key, value: value as WorkflowValue })), goal, instruction,
        check: { argv: argvValue, cwd, parser, timeoutMs } }
      const source = JSON.stringify(workflowBatchMigrationTemplate(input), null, 2)
      setError(null); onCreate(source)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.invalidJson) }
  }
  return <details className="workflow-batch-migration-draft">
    <summary>{copy.title}</summary><p>{copy.description}</p>
    <fieldset disabled={busy}>
      <label>{copy.items}<textarea value={items} maxLength={4 * 1024 * 1024} onChange={event => setItems(event.target.value)} /></label>
      <label>{copy.goal}<input value={goal} maxLength={16000} onChange={event => setGoal(event.target.value)} /></label>
      <label>{copy.instruction}<textarea value={instruction} maxLength={16000} onChange={event => setInstruction(event.target.value)} /></label>
      <label>{copy.checkArgv}<textarea value={argv} maxLength={262144} onChange={event => setArgv(event.target.value)} /></label>
      <label>{copy.checkCwd}<input value={cwd} maxLength={4096} onChange={event => setCwd(event.target.value)} /></label>
      <label>{copy.parser}<select value={parser} onChange={event => setParser(event.target.value as WorkflowCheckRequest['parser'])}>{(['exit_code', 'typescript', 'node_test'] as const).map(value => <option key={value} value={value}>{copy.parsers[value]}</option>)}</select></label>
      <label>{copy.timeoutMs}<input type="number" min={1} max={2147483647} value={timeout} onChange={event => setTimeout(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}<button type="button" onClick={create}>{copy.create}</button>
    </fieldset>
  </details>
}
