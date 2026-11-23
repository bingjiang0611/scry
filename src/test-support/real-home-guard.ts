import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

// Guards one user directory (the real ~/.scry) against changes made while the suite runs.
//
// A change is only the suite's fault when it can be attributed to a test run: the changed grant
// file names a workspace that lives under this run's temporary root or the system temporary
// directory. Everything else is the developer's own machine working normally — a real Scry
// session commits a turn, the agent running the tests is itself captured, another checkout runs
// its own tests — so in a normal local run those changes warn once and fail nobody. CI is
// different: nobody else writes there, so every change there is a real leak and fails.

export interface TreeEntry {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
}

export interface Change {
  status: 'added' | 'modified' | 'removed'
  path: string
}

export type GuardOutcome = { failures: Change[]; warnings: Change[] }

/** `lstat`, not `stat`: a symlink swap is a change even when its target is untouched. */
export function snapshotTree(root: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>()
  const walk = (directory: string): void => {
    let children: Dirent[]
    try {
      children = readdirSync(directory, { withFileTypes: true })
    } catch {
      return // A missing guarded directory means "no user data", not a failure.
    }
    for (const child of children) {
      const path = join(directory, child.name)
      const key = relative(root, path)
      const info = lstatSync(path, { throwIfNoEntry: false })
      if (!info) continue
      const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
      entries.set(key, { kind, size: info.size, mtimeMs: info.mtimeMs })
      if (kind === 'dir') walk(path)
    }
  }
  walk(root)
  return entries
}

export function changedEntries(before: Map<string, TreeEntry>, after: Map<string, TreeEntry>): Change[] {
  const changes: Change[] = []
  for (const [path, entry] of after) {
    const previous = before.get(path)
    if (!previous) changes.push({ status: 'added', path })
    else if (previous.kind !== entry.kind) changes.push({ status: 'modified', path })
    // A directory's mtime only follows the files inside it; reporting the parent as well would
    // duplicate every change and add an entry that names no workspace of its own.
    else if (entry.kind !== 'dir' && (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs)) {
      changes.push({ status: 'modified', path })
    }
  }
  // A removed entry has no content left to name a workspace, so it can never be attributed.
  for (const path of before.keys()) if (!after.has(path)) changes.push({ status: 'removed', path })
  return changes
}

function normalizedForms(path: string): string[] {
  const forms = [resolve(path)]
  try {
    forms.push(realpathSync(path))
  } catch {
    // A removed fixture root has no realpath; the literal form still has to be checked.
  }
  return forms
}

function within(candidate: string, roots: string[]): boolean {
  return normalizedForms(candidate).some((form) =>
    roots.some((root) => form === root || form.startsWith(`${root}${sep}`)))
}

/**
 * The workspace a grant-like file names, or null when the file is not one or no longer parses.
 * Recorder grants and their host records both carry `workspace: <absolute path>`.
 */
function recordedWorkspace(guardDir: string, path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(guardDir, path), 'utf8')) as { workspace?: unknown }
    return typeof value.workspace === 'string' && value.workspace.trim() ? value.workspace.trim() : null
  } catch {
    return null
  }
}

export interface GuardInput {
  guardDir: string
  before: Map<string, TreeEntry>
  after: Map<string, TreeEntry>
  /** Directories that belong to this test run: its HOME root plus the system temporary directory. */
  temporaryRoots: string[]
  /** CI: nobody else shares the machine, so every change is the suite's responsibility. */
  strict: boolean
}

export function evaluateGuard(input: GuardInput): GuardOutcome {
  const roots = input.temporaryRoots.flatMap(normalizedForms)
  const failures: Change[] = []
  const warnings: Change[] = []
  for (const change of changedEntries(input.before, input.after)) {
    if (input.strict) {
      failures.push(change)
      continue
    }
    const workspace = change.status === 'removed' ? null : recordedWorkspace(input.guardDir, change.path)
    if (workspace && within(workspace, roots)) failures.push(change)
    else warnings.push(change)
  }
  return { failures, warnings }
}

export function describe(change: Change, guardDir: string): string {
  const workspace = change.status === 'removed' ? null : recordedWorkspace(guardDir, change.path)
  return `${change.status.padEnd(8)} ${change.path}${workspace ? ` (workspace ${workspace})` : ''}`
}

export interface ReportInput {
  guardDir: string
  testPath: string
  /** Collects one warning block per test file; the run prints them together at the end. */
  warn: (message: string) => void
}

/**
 * Turn one file's outcome into the two visible effects: a warning block, or a failure naming the
 * file. Warning and failure are exclusive per file: an attributable change is never "only a
 * warning", because that is exactly the case the guard exists to stop.
 */
export function applyOutcome(outcome: GuardOutcome, input: ReportInput): void {
  if (outcome.warnings.length > 0) {
    input.warn([
      `${input.testPath} found the real ${input.guardDir} changed by something other than these tests:`,
      ...outcome.warnings.map((change) => `  ${describe(change, input.guardDir)}`),
      'Not a failure: a real session, another checkout or the agent running the suite also writes',
      'there locally. CI fails on any change.'
    ].join('\n'))
  }
  if (outcome.failures.length === 0) return
  throw new Error([
    `${input.testPath} changed the real ${input.guardDir} while it ran:`,
    ...outcome.failures.map((change) => `  ${describe(change, input.guardDir)}`),
    'Tests must write under their temporary workspace, HOME or userData. Pass an explicit env',
    '(HOME and SCRY_GRANT_DIR) instead of building one from the real user home.'
  ].join('\n'))
}
