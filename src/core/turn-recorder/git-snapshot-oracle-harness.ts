import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import { beginGitTurnDiff, cleanupCapture, type GitTurnDiffCapture } from './git-capture.js'
import { computeGitTurnDiff } from './git-compute.js'
import type { DiffFile, TurnDiffCollection, TurnDiffSnapshot } from '../../shared/turn-diff.js'

const exec = promisify(execFile)

const roots: string[] = []

export function trackRoot(root: string): string {
  roots.push(root)
  return root
}

export async function removeTrackedRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

/** Fixture git runs with the host's global/system config, templates and repo-locating env removed. */
export const fixtureEnv: NodeJS.ProcessEnv = {
  ...withoutRepoLocatingVariables(process.env),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
  GIT_TEMPLATE_DIR: ''
}

function withoutRepoLocatingVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
  ]) delete copy[key]
  return copy
}

export async function git(args: string[], cwd: string): Promise<string> {
  return gitWith(args, cwd, {})
}

export async function gitWith(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { ...fixtureEnv, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024
  })
  return stdout
}

export const COMMIT_IDENTITY = [
  '-c', 'user.name=oracle',
  '-c', 'user.email=oracle@scry.local',
  '-c', 'commit.gpgsign=false'
]

/** Fresh temporary root containing a `repo` directory with `git init` already done. */
export async function newRepoRoot(label: string): Promise<{ root: string; repo: string }> {
  const root = trackRoot(await realpath(await mkdtemp(join(tmpdir(), `scry-oracle-${label}-`))))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(['init', '-q', '--initial-branch=main'], repo)
  return { root, repo }
}

export async function commitAll(repo: string, message = 'fixture'): Promise<string> {
  await git(['add', '-A'], repo)
  await git([...COMMIT_IDENTITY, 'commit', '-q', '-m', message], repo)
  return (await git(['rev-parse', 'HEAD'], repo)).trim()
}

export function captureRootFor(root: string): string {
  return join(root, 'captures')
}

export interface OracleRun {
  tree: string
  files: DiffFile[]
  status: TurnDiffSnapshot['status']
  collection?: TurnDiffCollection
}

export interface RunResult {
  run: OracleRun
  /** Real `.git/index` identity is unchanged by the capture itself. */
  indexUnchanged: boolean
  /** Real object database gained no loose objects. */
  objectsUnchanged: boolean
  /** Gap between the real index and the in-memory mutation of the fixture. */
  indexUntouchedByMutation: boolean
  objectsUntouchedByMutation: boolean
}

export interface RunOptions {
  forceFull: boolean
  /** Some fixtures intentionally rewrite the real index / object db while mutating. */
  mutationRewritesIndex?: boolean
  mutationWritesObjects?: boolean
  deadlineMs?: number
}

interface IndexFingerprint {
  digest: string
  size: number
  mtimeMs: number
}

async function indexPath(repo: string): Promise<string> {
  return resolve(repo, (await git(['rev-parse', '--git-path', 'index'], repo)).trim())
}

async function indexFingerprint(repo: string): Promise<IndexFingerprint | undefined> {
  try {
    const path = await indexPath(repo)
    const [bytes, info] = await Promise.all([readFile(path), stat(path)])
    return { digest: createHash('sha256').update(bytes).digest('hex'), size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

async function looseObjectCount(repo: string): Promise<number> {
  const raw = (await git(['rev-parse', '--git-common-dir'], repo)).trim()
  const common = isAbsolute(raw) ? raw : resolve(repo, raw)
  const objects = join(common, 'objects')
  let entries
  try {
    entries = await readdir(objects, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue
    total += (await readdir(join(objects, entry.name))).length
  }
  return total
}

/**
 * Run one turn snapshot on `repo`: begin while the worktree is at its pre-turn state, mutate,
 * then build the after tree with either the implementation under test or the full reference path.
 * The after tree is read from the internal `onAfter` seam because it is not part of the
 * persisted snapshot; file evidence is.
 */
export async function runTurn(
  root: string,
  repo: string,
  options: RunOptions,
  mutate: (repo: string) => Promise<void>
): Promise<RunResult> {
  const deadlineMs = options.deadlineMs ?? 20_000
  const indexAtStart = await indexFingerprint(repo)
  const objectsAtStart = await looseObjectCount(repo)
  const capture = await beginGitTurnDiff(repo, deadlineMs, captureRootFor(root), [])
  if (capture.status !== 'ready') throw new Error(`fixture capture was not ready: ${capture.status}/${capture.reason ?? ''}`)
  try {
    const indexAfterBegin = await indexFingerprint(repo)
    const objectsAfterBegin = await looseObjectCount(repo)
    await mutate(repo)
    const indexBeforeFinish = await indexFingerprint(repo)
    const objectsBeforeFinish = await looseObjectCount(repo)
    const result = await finishCapture(capture, options.forceFull, deadlineMs)
    const indexAfterFinish = await indexFingerprint(repo)
    const objectsAfterFinish = await looseObjectCount(repo)
    return {
      run: result,
      indexUnchanged: same(indexBeforeFinish, indexAfterFinish),
      objectsUnchanged: objectsBeforeFinish === objectsAfterFinish,
      indexUntouchedByMutation: options.mutationRewritesIndex === true ||
        same(indexAtStart, indexAfterBegin) && same(indexAtStart, indexBeforeFinish),
      objectsUntouchedByMutation: options.mutationWritesObjects === true ||
        objectsAtStart === objectsAfterBegin && objectsAtStart === objectsBeforeFinish
    }
  } finally {
    await cleanupCapture(capture)
  }
}

export async function finishCapture(capture: GitTurnDiffCapture, forceFull: boolean, deadlineMs: number): Promise<OracleRun> {
  let after: { tree: string } | undefined
  let snapshot: TurnDiffSnapshot | undefined
  snapshot = await computeGitTurnDiff(
    capture,
    deadlineMs,
    { completePatches: true, forceFull },
    false,
    undefined,
    (value) => { after = value }
  )
  if (!after) throw new Error(`capture produced no after tree: ${snapshot.status}/${snapshot.reason ?? ''}`)
  return {
    tree: after.tree,
    files: snapshot.files,
    status: snapshot.status,
    ...(snapshot.collection ? { collection: snapshot.collection } : {})
  }
}

function same(left: IndexFingerprint | undefined, right: IndexFingerprint | undefined): boolean {
  if (!left || !right) return left === right
  return left.digest === right.digest && left.size === right.size && left.mtimeMs === right.mtimeMs
}

/** Repo-root-relative, forward-slash paths so two fixture copies compare on evidence, not location. */
export function relativeFiles(files: DiffFile[], repo: string): DiffFile[] {
  return files
    .map((file) => ({ ...file, path: relative(repo, file.path).split(sep).join('/') }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

/** Build the after tree the reference way from an independent temporary index. */
export async function referenceTree(root: string, repo: string): Promise<string> {
  const capture = await beginGitTurnDiff(repo, 20_000, captureRootFor(root), [])
  if (capture.status !== 'ready') throw new Error(`reference capture was not ready: ${capture.status}`)
  try {
    return (await finishCapture(capture, true, 20_000)).tree
  } finally {
    await cleanupCapture(capture)
  }
}

export function expectIndexAndObjectsUntouched(left: RunResult, right: RunResult): void {
  expect(left.indexUnchanged).toBe(true)
  expect(right.indexUnchanged).toBe(true)
  expect(left.objectsUnchanged).toBe(true)
  expect(right.objectsUnchanged).toBe(true)
  expect(left.indexUntouchedByMutation).toBe(true)
  expect(right.indexUntouchedByMutation).toBe(true)
  expect(left.objectsUntouchedByMutation).toBe(true)
  expect(right.objectsUntouchedByMutation).toBe(true)
}

/** Both implementations must agree on the after tree and the whole file evidence byte for byte. */
export function expectSameEvidence(left: RunResult, right: RunResult, leftRepo: string, rightRepo: string): void {
  expect(right.run.tree).toBe(left.run.tree)
  expect(right.run.status).toBe(left.run.status)
  expect(relativeFiles(right.run.files, rightRepo)).toEqual(relativeFiles(left.run.files, leftRepo))
}

export async function writeFileAt(repo: string, path: string, content: string | Buffer): Promise<void> {
  const target = join(repo, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content)
}

/** Fixed timestamp keeps stat signatures comparable between twins and enables racy-clean fixtures. */
export const OLD_TIMESTAMP = new Date('2020-01-01T00:00:00.000Z')

export async function stamp(repo: string, path: string, when = OLD_TIMESTAMP): Promise<void> {
  await utimes(join(repo, path), when, when)
}

export interface Scenario {
  id: string
  /** Runs on a freshly `git init`-ed copy and must end with a commit. */
  setup: (repo: string) => Promise<void>
  /** Runs after the commit and before the turn capture starts (repo-state fixtures). */
  prepare?: (repo: string) => Promise<void>
  /** Runs after the turn capture started; describes the worktree change under test. */
  mutate: (repo: string) => Promise<void>
  options?: Partial<RunOptions>
  /** Extra assertions on the paired runs, for invariants beyond "the two paths agree". */
  check?: (targeted: RunResult, full: RunResult, repos: { targeted: string; full: string }) => void
}

/**
 * Run the same scenario on two identical fixture copies: the implementation under test on one,
 * the full reference path on the other. Trees and file evidence must match exactly.
 */
export async function runScenarioPair(scenario: Scenario): Promise<void> {
  const left = await newRepoRoot(`${scenario.id}-targeted`)
  const right = await newRepoRoot(`${scenario.id}-full`)
  await scenario.setup(left.repo)
  await scenario.setup(right.repo)
  await scenario.prepare?.(left.repo)
  await scenario.prepare?.(right.repo)
  const targeted = await runTurn(left.root, left.repo, { forceFull: false, ...scenario.options }, scenario.mutate)
  const full = await runTurn(right.root, right.repo, { forceFull: true, ...scenario.options }, scenario.mutate)
  expectIndexAndObjectsUntouched(targeted, full)
  scenario.check?.(targeted, full, { targeted: left.repo, full: right.repo })
  expectSameEvidence(targeted, full, left.repo, right.repo)
}
