import { createHash } from 'node:crypto'
import { WORKFLOW_MAX_PROTECTED_PATHS, type WorkflowProtectedSurface as WorkflowProtectedSurfaceValue } from '../shared/workflow-verification'
import type { WorkflowInputSnapshot } from '../shared/workflow-system'
import type { WorkflowReplicaManifestEntry } from '../shared/workflow-replica'
import { workflowVerificationCopy as copy } from '../shared/constants/copy'

// Literal relative paths only. Directories include descendants; overlapping
// selectors are rejected, not normalized into a broader declaration.
export function validateWorkflowProtectedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > WORKFLOW_MAX_PROTECTED_PATHS) throw new Error(copy.protectedPaths)
  const paths: string[] = []
  for (const path of value) {
    if (typeof path !== 'string' || !path.length || path.length > 1024 || /[\\\x00-\x1f\x7f*?\[\]:]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.scry') ||
      paths.some(prior => prior === path || prior.startsWith(path + '/') || path.startsWith(prior + '/'))) throw new Error(copy.protectedPaths)
    paths.push(path)
  }
  return paths.sort()
}

type Projection = { hash: string; count: number; reason?: string }
type Observation = { inputHash: string; projection: Projection }
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

/** Reads no paths and executes nothing. Its observer receives parts only after
 * the ordinary immutable-header/part/hash verification, in that same read.
 * This proves declared path preservation, never discovery or executed coverage.
 * A protected symlink is unavailable until target closure can also be proven. */
export class WorkflowProtectedSurface {
  private readonly projections = new Map<string, Projection>()
  private readonly observations = new Map<string, Observation>()
  private bytes = 0
  constructor(private readonly paths: string[]) {}

  readonly observe = (stepId: string, phase: 'before' | 'after', snapshot: WorkflowInputSnapshot, chunks: readonly string[]): void => {
    let projection = this.projections.get(snapshot.inputHash)
    if (!projection) {
      this.bytes += snapshot.manifestBytes
      projection = this.bytes > MAX_MANIFEST_BYTES
        ? { hash: '', count: 0, reason: copy.surfaceLimit }
        : this.project(snapshot, chunks)
      this.projections.set(snapshot.inputHash, projection)
    }
    this.observations.set(stepId + ':' + phase, { inputHash: snapshot.inputHash, projection })
  }

  result(referenceStepId: string | undefined): WorkflowProtectedSurfaceValue {
    const unavailable = (reason: string): WorkflowProtectedSurfaceValue => ({ state: 'unavailable', source: 'main_manifest', reason })
    const reference = referenceStepId ? this.observations.get(referenceStepId + ':before') : undefined
    if (!reference || !referenceStepId) return unavailable(copy.surfaceBaseline)
    for (const { projection } of this.observations.values()) {
      if (projection.reason) return unavailable(projection.reason)
      if (projection.hash !== reference.projection.hash) return unavailable(copy.surfaceChanged)
    }
    return { state: 'available', source: 'main_manifest', protectedPaths: [...this.paths], referenceStepId,
      referenceInputHash: reference.inputHash, entryCount: reference.projection.count, observations: this.observations.size }
  }

  private project(snapshot: WorkflowInputSnapshot, chunks: readonly string[]): Projection {
    const data: unknown = JSON.parse(chunks.join(''))
    if (!Array.isArray(data) || data.length !== snapshot.entryCount) throw new Error(copy.contract)
    const selected: WorkflowReplicaManifestEntry[] = [], present = new Set<string>()
    const entries: unknown[] = data
    for (const input of entries) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(copy.contract)
      const entry = input as Record<string, unknown>
      if (typeof entry.path !== 'string' || typeof entry.hash !== 'string' || typeof entry.mode !== 'number' || typeof entry.bytes !== 'number' ||
        !Number.isSafeInteger(entry.mode) || !Number.isSafeInteger(entry.bytes) || (entry.kind !== 'file' && entry.kind !== 'directory' && entry.kind !== 'symlink')) throw new Error(copy.contract)
      const entryPath = entry.path
      const path = this.paths.find(path => entryPath === path || entryPath.startsWith(path + '/'))
      if (path === undefined) continue
      if (entry.path === path) present.add(path)
      if (entry.kind === 'symlink') return { hash: '', count: 0, reason: copy.surfaceSymlink }
      selected.push({ path: entry.path, hash: entry.hash, mode: entry.mode, bytes: entry.bytes, kind: entry.kind })
    }
    if (present.size !== this.paths.length) return { hash: '', count: 0, reason: copy.surfaceMissing }
    selected.sort((a, b) => a.path < b.path ? -1 : a.path === b.path ? 0 : 1)
    return { hash: createHash('sha256').update(JSON.stringify(selected)).digest('hex'), count: selected.length }
  }
}
