import { isAbsolute, relative, resolve, sep } from 'node:path'
import { WORKFLOW_MAX_BATCH, type WorkflowValue } from '../shared/workflow'
import type { WorkflowNormalizedDiagnostic } from '../shared/workflow-verification'

/** Location shifts are not removed errors. Preserve multiplicity at distinct
 * locations, but collapse an identical diagnostic repeated by stdout/stderr. */
export function normalizeWorkflowDiagnostics(key: string, value: WorkflowValue, directory: string, cwd: string): WorkflowNormalizedDiagnostic[] | undefined {
  if (!Array.isArray(value) || value.length > WORKFLOW_MAX_BATCH) return undefined
  const positions = new Set<string>(), groups = new Map<string, WorkflowNormalizedDiagnostic>()
  for (const raw of value) {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object' || typeof raw.file !== 'string' || typeof raw.code !== 'string' || typeof raw.message !== 'string' ||
      typeof raw.line !== 'number' || !Number.isSafeInteger(raw.line) || raw.line < 1 || typeof raw.column !== 'number' || !Number.isSafeInteger(raw.column) || raw.column < 1) return undefined
    const file = relative(directory, resolve(directory, cwd, raw.file))
    if (!file || file === '..' || file.startsWith('..' + sep) || isAbsolute(file)) return undefined
    const item = { check: key, file: file.split(sep).join('/'), code: raw.code, message: raw.message.replace(/\r\n?/g, '\n').trim(), count: 1 }
    const position = JSON.stringify([item, raw.line, raw.column])
    if (positions.has(position)) continue
    positions.add(position)
    const identity = workflowDiagnosticKey(item), previous = groups.get(identity)
    if (previous) previous.count++
    else groups.set(identity, item)
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, item]) => item)
}
export function workflowDiagnosticKey(item: WorkflowNormalizedDiagnostic): string {
  return JSON.stringify([item.check, item.file, item.code, item.message])
}
export function compareWorkflowDiagnostics(before: WorkflowNormalizedDiagnostic[], after: WorkflowNormalizedDiagnostic[]) {
  const prior = new Map(before.map(item => [workflowDiagnosticKey(item), item])), next = new Map(after.map(item => [workflowDiagnosticKey(item), item]))
  const difference = (left: typeof next, right: typeof next) => [...left].flatMap(([key, item]) => {
    const count = item.count - (right.get(key)?.count ?? 0)
    return count > 0 ? [{ ...item, count }] : []
  })
  const added = difference(next, prior), removed = difference(prior, next)
  return added.length + removed.length > WORKFLOW_MAX_BATCH ? undefined : { added, removed }
}
