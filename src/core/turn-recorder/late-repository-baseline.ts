import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { TraceEvent, TurnDiffSnapshot } from '../../shared/trace.js'
import { editedAbsolutePaths } from './session-capture-discovery.js'

function contains(root: string, file: string): boolean {
  const rel = relative(root, file)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** An empty comparison against a baseline taken after the write began cannot prove no change. */
export async function qualifyEmptyRepositoryDiffs(
  workspace: string, diffs: TurnDiffSnapshot[], events: TraceEvent[]
): Promise<TurnDiffSnapshot[]> {
  const empty = diffs.filter(diff => diff.status === 'captured' && !diff.files.length && diff.repoRoot &&
    Number.isFinite(Date.parse(diff.beforeAt)))
  if (!empty.length) return diffs
  const late = new Set<TurnDiffSnapshot>()
  const parents = new Map<string, Promise<string | undefined>>()
  for (const event of events) {
    if (event.kind !== 'tool' || event.stage === 'tool_result') continue
    const at = Date.parse(event.ts)
    if (!Number.isFinite(at) || !empty.some(diff => !late.has(diff) && at < Date.parse(diff.beforeAt))) continue
    const paths = event.filePath && (event.fileOp === 'edit' || event.fileOp === 'write') ? [event.filePath] : []
    if (/^(?:apply_patch|edit|write|multiedit)$/i.test(event.tool ?? '')) {
      paths.push(...editedAbsolutePaths({ tool_input: event.input }))
    }
    for (const path of new Set(paths)) {
      const absolute = resolve(workspace, path)
      const parent = dirname(absolute)
      let identity = parents.get(parent)
      if (!identity) {
        identity = realpath(parent).catch(() => undefined)
        parents.set(parent, identity)
      }
      const canonical = await identity
      // If nested repositories overlap, the most specific observed root owns the targeted write.
      const owner = diffs.filter(diff => diff.repoRoot && (contains(diff.repoRoot, absolute) ||
        !!canonical && (canonical === diff.repoRoot || contains(diff.repoRoot, canonical))))
        .sort((a, b) => b.repoRoot!.length - a.repoRoot!.length)[0]
      if (owner && empty.includes(owner) && at < Date.parse(owner.beforeAt)) late.add(owner)
    }
  }
  return diffs.map(diff => late.has(diff) ? { ...diff, status: 'unavailable', reason: 'baseline_after_write' } : diff)
}
