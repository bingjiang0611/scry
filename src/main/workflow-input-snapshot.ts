import { createHash } from 'node:crypto'
import { WORKFLOW_MAX_BATCH, WORKFLOW_MAX_VALUE_BYTES, type WorkflowValue, type WorkflowValueReference } from '../shared/workflow'
import type { WorkflowCheckInputs, WorkflowInputChange, WorkflowInputSnapshot, WorkflowInputMaterialization } from '../shared/workflow-system'
import type { WorkflowReplicaManifestEntry } from '../shared/workflow-replica'
import { workflowSystemCopy as copy } from '../shared/constants/copy'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { snapshotWorkflowInputManifest, WORKFLOW_REPLICA_MAX_MANIFEST } from './workflow-replica'
import { validateWorkflowValueReference } from './workflow-frames'
import { validateWorkflowInputSnapshot, workflowSystemArtifactKey } from './workflow-system-ledger'

// Encoded manifest parts reuse immutable Workflow values without raising their
// 4 MiB limit or reducing the replica's 8 MiB /32768-entry manifest contract.
// Raw parts are content-addressed within the root. Identical fresh scans reuse
// bytes; each step/phase still has its own observation header and timestamp.
const PART_CHARACTERS = 128 * 1024
const MAX_PARTS = Math.ceil(WORKFLOW_REPLICA_MAX_MANIFEST / PART_CHARACTERS)
export type WorkflowCapturedInputs = Awaited<ReturnType<typeof captureWorkflowInputs>>
export async function captureWorkflowInputs(directory: string, stopped: () => boolean) {
  const startedAt = Date.now(), manifest = await snapshotWorkflowInputManifest(directory, stopped)
  return { ...manifest, info: {
    inputHash: createHash('sha256').update(manifest.text).digest('hex'), entryCount: manifest.entries.length,
    contentBytes: manifest.entries.reduce((bytes, entry) => bytes + entry.bytes, 0), manifestBytes: Buffer.byteLength(manifest.text), startedAt, finishedAt: Date.now()
  } }
}
export const workflowInputSnapshotInfo = ({ reference: _reference, ...info }: WorkflowInputSnapshot) => info

export async function saveWorkflowInputSnapshot(store: WorkflowStore, workflowId: string, stepId: string, phase: 'before' | 'after', captured: WorkflowCapturedInputs): Promise<WorkflowInputSnapshot> {
  const parts: WorkflowValueReference[] = []
  for (let offset = 0; offset < captured.text.length;) {
    let end = Math.min(offset + PART_CHARACTERS, captured.text.length)
    const last = captured.text.charCodeAt(end - 1)
    if (end < captured.text.length && last >= 0xd800 && last <= 0xdbff) end--
    parts.push(await store.saveValue(workflowId, workflowSystemArtifactKey(captured.info.inputHash, `input-part-${parts.length}`), {
      state: 'known', value: captured.text.slice(offset, end), derivedFrom: ['inputs:' + captured.info.inputHash]
    }))
    offset = end
  }
  const reference = await store.saveValue(workflowId, workflowSystemArtifactKey(stepId, 'input-' + phase), {
    state: 'known', value: { ...captured.info, parts: parts.map(part => ({ ...part })) }, derivedFrom: ['system:' + stepId]
  })
  return { ...captured.info, reference }
}

export type WorkflowInputSnapshotObserver = (stepId: string, phase: 'before' | 'after', snapshot: WorkflowInputSnapshot, chunks: readonly string[]) => void

export async function verifyWorkflowInputSnapshot(store: WorkflowStore, workflowId: string, stepId: string, phase: 'before' | 'after', snapshot: WorkflowInputSnapshot, observe?: WorkflowInputSnapshotObserver): Promise<void> {
  validateWorkflowInputSnapshot(snapshot, workflowId, stepId, phase)
  const header = await store.loadValue(workflowId, snapshot.reference)
  if (header.state !== 'known' || !header.value || typeof header.value !== 'object' || Array.isArray(header.value)) throw new Error(copy.intent)
  const { parts, ...info } = header.value
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS || JSON.stringify(info) !== JSON.stringify(workflowInputSnapshotInfo(snapshot))) throw new Error(copy.intent)
  const hash = createHash('sha256'), chunks = observe ? [] as string[] : undefined
  let bytes = 0
  for (const [index, part] of parts.entries()) {
    validateWorkflowValueReference(part, workflowId)
    if (part.key !== workflowSystemArtifactKey(snapshot.inputHash, `input-part-${index}`)) throw new Error(copy.intent)
    const value = await store.loadValue(workflowId, part)
    if (value.state !== 'known' || typeof value.value !== 'string' || value.value.length > PART_CHARACTERS) throw new Error(copy.intent)
    bytes += Buffer.byteLength(value.value)
    if (bytes > WORKFLOW_REPLICA_MAX_MANIFEST) throw new Error(copy.intent)
    hash.update(value.value)
    chunks?.push(value.value)
  }
  if (bytes !== snapshot.manifestBytes || hash.digest('hex') !== snapshot.inputHash) throw new Error(copy.intent)
  if (observe && chunks) observe(stepId, phase, snapshot, chunks)
}

/** Differences over the observation interval, not an attribution to a process.
 * Directory metadata and symlink targets matter too; content hashes alone lose
 * mode-only changes and type replacement. No host path is opened from this list. */
export function compareWorkflowInputs(before: WorkflowReplicaManifestEntry[], after: WorkflowReplicaManifestEntry[]): WorkflowInputChange[] {
  const prior = new Map(before.map(entry => [entry.path, entry])), current = new Map(after.map(entry => [entry.path, entry]))
  return [...new Set([...prior.keys(), ...current.keys()])].sort().flatMap<WorkflowInputChange>(path => {
    const a = prior.get(path), b = current.get(path)
    if (!a) return [{ path, kind: 'added' as const }]
    if (!b) return [{ path, kind: 'removed' as const }]
    return a.kind !== b.kind || a.hash !== b.hash || a.mode !== b.mode || a.bytes !== b.bytes || a.target !== b.target ? [{ path, kind: 'modified' as const }] : []
  })
}

export async function saveWorkflowInputChanges(store: WorkflowStore, workflowId: string, stepId: string, after: WorkflowInputSnapshot, items: WorkflowInputChange[]): Promise<WorkflowCheckInputs['changes']> {
  // Reserve half the value budget for metadata/diagnostics; the combined
  // program value still must pass the unchanged 4 MiB check. Over-limit data
  // remains in the complete manifests; never truncate it into a comparable list.
  if (items.length > WORKFLOW_MAX_BATCH || Buffer.byteLength(JSON.stringify(items)) > WORKFLOW_MAX_VALUE_BYTES / 2) return { state: 'unavailable', reason: copy.snapshotLimit, after }
  const reference = await store.saveValue(workflowId, workflowSystemArtifactKey(stepId, 'input-changes'), {
    state: 'known', value: items, derivedFrom: ['system:' + stepId]
  })
  return { state: 'available', source: 'snapshot_comparison', after, count: items.length, reference }
}

export async function verifyWorkflowCheckInputs(store: WorkflowStore, workflowId: string, stepId: string, before: WorkflowInputSnapshot | undefined, inputs: WorkflowCheckInputs | undefined, observe?: WorkflowInputSnapshotObserver): Promise<void> {
  if (before) await verifyWorkflowInputSnapshot(store, workflowId, stepId, 'before', before, observe)
  if (!inputs) return
  if (inputs.changes.after) await verifyWorkflowInputSnapshot(store, workflowId, stepId, 'after', inputs.changes.after, observe)
  if (inputs.changes.state === 'available') {
    const changes = await store.loadValue(workflowId, inputs.changes.reference)
    if (changes.state !== 'known' || !Array.isArray(changes.value) || changes.value.length !== inputs.changes.count) throw new Error(copy.intent)
  }
}

export async function verifyWorkflowInputMaterialization(store: WorkflowStore, record: WorkflowStoreRecord, materialization: WorkflowInputMaterialization | undefined): Promise<void> {
  if (!materialization) return // Historical checks have no binding; do not mint one.
  const origin = record.systemOutcomes?.find(outcome => outcome.stepId === materialization.preparationStepId)
  if (!origin?.resultRef) throw new Error(copy.intent)
  const value = await store.loadValue(record.preview.workflowId, origin.resultRef)
  if (value.state !== 'known' || JSON.stringify(value.replica) !== JSON.stringify(materialization.materialized) ||
    JSON.stringify(value.value) !== JSON.stringify(materialization.materialized)) throw new Error(copy.intent)
}

export function workflowCheckInputValue(inputs: WorkflowCheckInputs, items: WorkflowInputChange[]): WorkflowValue {
  const after = inputs.changes.after
  return { before: workflowInputSnapshotInfo(inputs.before), ...(after ? { after: workflowInputSnapshotInfo(after) } : {}), ...(inputs.materialization ? { materialization: inputs.materialization } : {}),
    changes: inputs.changes.state === 'available' ? { state: 'available', source: 'snapshot_comparison', items }
      : { state: 'unavailable', reason: inputs.changes.reason } }
}
