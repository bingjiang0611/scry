import { execFileSync } from 'node:child_process'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import moduleApi from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { FileHandle } from 'node:fs/promises'
import type { LoadedSessionTurn } from '../../src/shared/session-history.js'
import type { TraceArchiveTurn } from '../../src/main/transcript-archive.js'
import type { AgentTurnRecord } from '../../src/shared/turn-record.js'
import type { GitTurnDiffCapture } from '../../src/core/turn-recorder/git.js'
import type { TurnDiffSnapshot } from '../../src/shared/trace.js'
import { describe, expect, it } from 'vitest'

type JsonRecord = Record<string, unknown>
type GitSource = {
  beginGitTurnDiff(cwd: string): Promise<GitTurnDiffCapture>
  finishGitTurnDiff(capture: GitTurnDiffCapture, deadlineMs?: number): Promise<TurnDiffSnapshot>
}
type PiSource = {
  readPiNativeHistory?(args: JsonRecord): Promise<LoadedSessionTurn[] | null>
  readPiNativeHistorySnapshot?(args: JsonRecord): Promise<{ turns: LoadedSessionTurn[]; hydrate(runIds: readonly string[]): Promise<LoadedSessionTurn[]> } | null>
  sessionHistoryPage(turns: readonly LoadedSessionTurn[], request: JsonRecord): { turns: LoadedSessionTurn[]; offset: number }
}
type ArchiveSource = {
  traceArchiveTurnPath(userDataDir: string, cwd: string, sessionId: string, providerId: 'codex', turn: Pick<TraceArchiveTurn, 'runId' | 'providerTurnId'>): string
  readTraceArchivePageAsync(args: JsonRecord, request: JsonRecord): Promise<JsonRecord>
  upsertTraceArchiveTurn(args: JsonRecord): boolean
  upsertTraceArchiveTurnAsync?(args: JsonRecord): Promise<boolean>
}
type CommitSource = { commitManagedTraceTurn(input: JsonRecord, options: JsonRecord): Promise<{ recorder: string }> }
type AggregateSource = { aggregateTurnEvidence(input: JsonRecord): JsonRecord }
type HookSource = { handleRecorderHook(input: JsonRecord): Promise<unknown> }
type StoreSource = { listRecords(dataRoot: string): Promise<AgentTurnRecord[]> }
type WriteSample = { directory: string; path: string; bytes: number }

const here = dirname(fileURLToPath(import.meta.url))
const requestedSource = process.env.SCRY_B_SOURCE ? resolve(process.env.SCRY_B_SOURCE) : resolve(here, '../../src')
const sourceRoot = existsSync(join(requestedSource, 'main', 'pi-native-history.ts'))
  ? requestedSource
  : join(requestedSource, 'src')
const small = process.env.SCRY_BENCH_SMALL === '1'
const repeats = small ? 1 : Math.min(3, Math.max(1, Number(process.env.SCRY_BENCH_REPEATS ?? 3)))
const gitCounts = small ? [4] : [4, 100, 1000]
const roots: string[] = []

type Counters = { git: number; patchSpawns: number; nativeBytes: number; jsonParses: number; writes: WriteSample[]; archiveWrites: WriteSample[] }
let counters: Counters = freshCounters()
let nativeScope = false
let commitScope = false
let archiveScope = false
let archiveUserDataRoot: string | undefined

function freshCounters(): Counters { return { git: 0, patchSpawns: 0, nativeBytes: 0, jsonParses: 0, writes: [], archiveWrites: [] } }
function pathIsWithin(path: string, root: string | undefined): boolean {
  return !!root && (path === root || path.startsWith(`${root}/`))
}
function archiveWriteKind(path: string): string {
  if (path.includes('/trace-archive-index-v1')) return 'catalog'
  if (path.includes('/trace-archive-turns-v1/')) {
    if (path.includes('.meta-v1')) return 'metadata'
    if (path.includes('.index-v1')) return 'index'
    if (path.includes('/turn-')) return 'canonical'
  }
  return 'other'
}
function recordArchiveWrite(path: string, value: unknown): void {
  if (archiveScope && pathIsWithin(path, archiveUserDataRoot)) counters.archiveWrites.push({ directory: archiveWriteKind(path), path, bytes: bytesOf(value) })
}
function resetCounters(): void { counters = freshCounters() }
function elapsed(start: bigint): number { return Number(process.hrtime.bigint() - start) / 1e6 }
function bytesOf(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (value instanceof Uint8Array) return value.byteLength
  return 0
}
function commandArgs(args: unknown[]): string[] {
  return Array.isArray(args[1]) ? args[1].map(String) : []
}

function installTransparentCounters(): () => void {
  const originalOpen = fsPromises.open
  const originalWriteFile = fsPromises.writeFile
  const originalOpenSync = fs.openSync
  const originalWriteFileSync = fs.writeFileSync
  const originalExecFile = childProcess.execFile
  const originalParse = JSON.parse
  const fdPaths = new Map<number, string>()
  const originalExecCustom = Reflect.get(originalExecFile, promisify.custom) as ((...args: unknown[]) => unknown) | undefined
  const countGit = (args: readonly unknown[]): void => {
    if (String(args[0]) !== 'git' || nativeScope || commitScope) return
    const argv = commandArgs([...args])
    counters.git += 1
    if (argv.some((arg) => arg.startsWith('--output='))) counters.patchSpawns += 1
  }
  const wrapHandle = (handle: FileHandle, path: string): FileHandle => new Proxy(handle, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'read') return (...args: unknown[]) => Promise.resolve(Reflect.apply(value, target, args)).then((result: unknown) => {
        const read = result as { bytesRead: number }
        if (nativeScope) counters.nativeBytes += read.bytesRead
        return result
      })
      if (property === 'readFile') return (...args: unknown[]) => Promise.resolve(Reflect.apply(value, target, args)).then((result: unknown) => {
        if (nativeScope) counters.nativeBytes += bytesOf(result)
        return result
      })
      if (property === 'writeFile') return (...args: unknown[]) => {
        if (commitScope && (path.includes('/managed-turn-commits/') || path.includes('/managed-turn-journal-state/'))) {
          counters.writes.push({ directory: path.includes('/managed-turn-journal-state/') ? 'managed-turn-journal-state' : 'managed-turn-commits', path, bytes: bytesOf(args[0]) })
        }
        recordArchiveWrite(path, args[0])
        return Reflect.apply(value, target, args)
      }
      return value.bind(target)
    }
  }) as FileHandle
  const wrappedOpen = function(this: unknown, ...args: unknown[]): Promise<FileHandle> {
    return Promise.resolve(Reflect.apply(originalOpen, this, args)).then((handle) => wrapHandle(handle as FileHandle, String(args[0])))
  }
  const wrappedWriteFile = function(this: unknown, ...args: unknown[]): unknown {
    recordArchiveWrite(String(args[0]), args[1])
    return Reflect.apply(originalWriteFile, this, args)
  }
  const wrappedOpenSync = function(this: unknown, ...args: unknown[]): unknown {
    const result = Reflect.apply(originalOpenSync, this, args)
    if (typeof result === 'number') fdPaths.set(result, String(args[0]))
    return result
  }
  const wrappedWriteFileSync = function(this: unknown, ...args: unknown[]): unknown {
    const target = args[0]
    recordArchiveWrite(typeof target === 'number' ? (fdPaths.get(target) ?? `fd:${target}`) : String(target), args[1])
    return Reflect.apply(originalWriteFileSync, this, args)
  }
  const wrappedExecFile = function(this: unknown, ...args: unknown[]): unknown {
    countGit(args)
    return Reflect.apply(originalExecFile, this, args)
  }
  const wrappedExecCustom = function(this: unknown, ...args: unknown[]): unknown {
    countGit(args)
    return originalExecCustom ? Reflect.apply(originalExecCustom, this, args) : undefined
  }
  ;(fsPromises as { open: typeof fsPromises.open; writeFile: typeof fsPromises.writeFile }).open = wrappedOpen as typeof fsPromises.open
  ;(fsPromises as { open: typeof fsPromises.open; writeFile: typeof fsPromises.writeFile }).writeFile = wrappedWriteFile as typeof fsPromises.writeFile
  ;(fs as { openSync: typeof fs.openSync; writeFileSync: typeof fs.writeFileSync }).openSync = wrappedOpenSync as typeof fs.openSync
  ;(fs as { openSync: typeof fs.openSync; writeFileSync: typeof fs.writeFileSync }).writeFileSync = wrappedWriteFileSync as typeof fs.writeFileSync
  ;(childProcess as { execFile: typeof childProcess.execFile }).execFile = wrappedExecFile as typeof childProcess.execFile
  if (originalExecCustom) Object.defineProperty(wrappedExecFile, promisify.custom, { value: wrappedExecCustom })
  moduleApi.syncBuiltinESMExports()
  JSON.parse = (...args: Parameters<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
    if (nativeScope) counters.jsonParses += 1
    return Reflect.apply(originalParse, JSON, args)
  }
  return () => {
    ;(fsPromises as { open: typeof fsPromises.open; writeFile: typeof fsPromises.writeFile }).open = originalOpen
    ;(fsPromises as { open: typeof fsPromises.open; writeFile: typeof fsPromises.writeFile }).writeFile = originalWriteFile
    ;(fs as { openSync: typeof fs.openSync; writeFileSync: typeof fs.writeFileSync }).openSync = originalOpenSync
    ;(fs as { openSync: typeof fs.openSync; writeFileSync: typeof fs.writeFileSync }).writeFileSync = originalWriteFileSync
    ;(childProcess as { execFile: typeof childProcess.execFile }).execFile = originalExecFile
    moduleApi.syncBuiltinESMExports()
    JSON.parse = originalParse
  }
}

async function sourceModule(path: string): Promise<unknown> { return import(pathToFileURL(join(sourceRoot, path)).href) }
async function sourceInfo(): Promise<{ root: string; sha: string; env: string | null; childProcessEntrypoints: string[] }> {
  let sha = 'unknown'
  try { sha = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
  const gitSource = await readFile(join(sourceRoot, 'core/turn-recorder/git.ts'), 'utf8')
  const importLine = gitSource.match(/import\s+\{([^}]+)\}\s+from\s+['"]node:child_process['"]/)?.[1] ?? ''
  if (!/\bexecFile\b/.test(importLine) || /\b(?:spawn|fork|exec|execFileSync|spawnSync)\b/.test(importLine)) throw new Error('Git child-process entrypoint is not the measured execFile path')
  return { root: sourceRoot, sha, env: process.env.SCRY_B_SOURCE ?? null, childProcessEntrypoints: ['node:child_process.execFile', 'promisify.custom(execFile)'] }
}

async function gitFixture(count: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-evidence-git-')); roots.push(root)
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'evidence@scry.local'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Scry evidence'])
  for (let i = 0; i < count; i++) await writeFile(join(root, `changed-${i}.txt`), 'before\n')
  execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'baseline'])
  return root
}

async function runGit(git: GitSource, count: number): Promise<Record<string, unknown>> {
  const samples: Array<Record<string, unknown>> = []
  for (let repeat = 0; repeat < repeats; repeat++) {
    const root = await gitFixture(count)
    const capture = await git.beginGitTurnDiff(root)
    for (let i = 0; i < count; i++) await writeFile(join(root, `changed-${i}.txt`), `after-${i}\n`)
    resetCounters(); const started = process.hrtime.bigint(); nativeScope = false
    const snapshot = await git.finishGitTurnDiff(capture, 10_000); const ms = elapsed(started)
    const files = snapshot.files.map((file) => file.path).sort()
    expect(files).toHaveLength(count)
    expect(files.map((path) => path.slice(path.lastIndexOf('/') + 1))).toEqual(Array.from({ length: count }, (_, i) => `changed-${i}.txt`).sort())
    expect(snapshot.status).not.toBe('failed')
    samples.push({ repeat, ms, status: snapshot.status, reason: snapshot.reason ?? null, fileCount: files.length, gitProcesses: counters.git, batchPatchSpawns: counters.patchSpawns, patchCaptured: snapshot.files.filter((file) => file.patchStatus === 'captured').length, patchUnavailable: snapshot.files.filter((file) => file.patchStatus === 'unavailable').length })
    await rm(root, { recursive: true, force: true }); roots.splice(roots.indexOf(root), 1)
  }
  return { operation: 'git.finishGitTurnDiff', changedFiles: count, repeats: samples }
}

function sessionDirectory(root: string, cwd: string): string { return join(root, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`) }
function nativeEntry(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message: { role, content }, ...extra }
}
async function piFixture(turnCount: number): Promise<{ root: string; cwd: string; file: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scry-evidence-pi-')); roots.push(root)
  const cwd = join(root, 'workspace'); await fsPromises.mkdir(cwd, { recursive: true })
  const sessionId = '11111111-1111-4111-8111-111111111111'; const lines: string[] = [JSON.stringify({ type: 'session', id: sessionId, cwd, version: 3 })]
  let parent: string | null = null
  const addTurn = (i: number): void => {
    const user = `user-${i}`, assistant = `assistant-${i}`, result = `result-${i}`, tool = `tool-${i}`
    lines.push(JSON.stringify(nativeEntry(user, parent, 'user', `prompt-${i}`)))
    lines.push(JSON.stringify(nativeEntry(assistant, user, 'assistant', [{ type: 'text', text: `${'A'.repeat(2048)}-${i}` }, { type: 'toolCall', id: tool, name: 'read', arguments: { path: `file-${i}` } }])))
    lines.push(JSON.stringify(nativeEntry(result, assistant, 'toolResult', [{ type: 'text', text: `tool-output-${i}` }], { message: { role: 'toolResult', toolCallId: tool, toolName: 'read', content: [{ type: 'text', text: `tool-output-${i}` }] } })))
    parent = result
  }
  for (let i = 0; i < turnCount; i++) addTurn(i)
  const directory = sessionDirectory(root, cwd); await fsPromises.mkdir(directory, { recursive: true })
  const file = join(directory, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`); await writeFile(file, `${lines.join('\n')}\n`)
  return { root, cwd, file, sessionId }
}
function selectedPayload(turns: LoadedSessionTurn[]): string {
  return JSON.stringify(turns.map((turn) => ({ runId: turn.runId, userText: turn.userText, items: turn.items.map((item) => ({ id: item.id, stage: item.stage, text: item.text, tool: item.tool, toolUseId: item.toolUseId, input: item.input, output: item.output })) })))
}
async function runPi(pi: PiSource, session: { root: string; cwd: string; sessionId: string }, phase: string, turnsCount: number): Promise<Record<string, unknown>> {
  resetCounters(); nativeScope = true; const started = process.hrtime.bigint()
  let selected: LoadedSessionTurn[]; let mode: string
  if (pi.readPiNativeHistorySnapshot) {
    mode = 'snapshot'; const snapshot = await pi.readPiNativeHistorySnapshot({ sessionRoot: session.root, cwd: session.cwd, sessionId: session.sessionId })
    if (!snapshot) throw new Error('Pi snapshot unexpectedly unavailable')
    const latest = pi.sessionHistoryPage(snapshot.turns, { limit: 40 }); const older = pi.sessionHistoryPage(snapshot.turns, { before: latest.offset, limit: 40 })
    selected = await snapshot.hydrate([...older.turns, ...latest.turns].map((turn) => turn.runId ?? ''))
  } else {
    mode = 'native-all'; const turns = await pi.readPiNativeHistory?.({ sessionRoot: session.root, cwd: session.cwd, sessionId: session.sessionId })
    if (!turns) throw new Error('Pi history unexpectedly unavailable')
    const latest = pi.sessionHistoryPage(turns, { limit: 40 }); const older = pi.sessionHistoryPage(turns, { before: latest.offset, limit: 40 }); selected = [...older.turns, ...latest.turns]
  }
  nativeScope = false
  return { operation: 'pi.history', phase, turns: turnsCount, mode, ms: elapsed(started), physicalBytes: counters.nativeBytes, jsonParseCalls: counters.jsonParses, selectedRunIds: selected.map((turn) => turn.runId), selectedPayloadSha256: createHash('sha256').update(selectedPayload(selected)).digest('hex') }
}

function archiveTurn(index: number, runId = `archive-run-${index}`): TraceArchiveTurn {
  return { runId, providerTurnId: `archive-turn-${index}`, userText: `archive-prompt-${index}`, items: [], done: true, status: 'completed', ts: index + 1 }
}
async function archiveFixture(archive: ArchiveSource, count: number): Promise<{ root: string; args: JsonRecord; turns: TraceArchiveTurn[] }> {
  const root = await mkdtemp(join(tmpdir(), 'scry-evidence-archive-')); roots.push(root)
  const cwd = join(root, 'workspace'); await fsPromises.mkdir(cwd, { recursive: true })
  const args: JsonRecord = { cwd, sessionId: `archive-session-${count}`, providerId: 'codex', userDataDir: root }
  const turns = Array.from({ length: count }, (_, index) => archiveTurn(index))
  for (const turn of turns) {
    const path = archive.traceArchiveTurnPath(root, cwd, String(args.sessionId), 'codex', turn)
    await fsPromises.mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ version: 3, cwd, sessionId: args.sessionId, externalSessionId: args.sessionId, providerId: 'codex', runtimeProvider: 'codex_cli', turns: [turn] })}\n`)
  }
  return { root, args, turns }
}
async function runArchive(archive: ArchiveSource, count: number): Promise<Record<string, unknown>> {
  const session = await archiveFixture(archive, count)
  resetCounters(); archiveUserDataRoot = session.root; archiveScope = true
  const started = process.hrtime.bigint()
  const cold = await archive.readTraceArchivePageAsync(session.args, { limit: 40 })
  const older = await archive.readTraceArchivePageAsync(session.args, { before: 40, limit: 40 })
  archiveScope = false; const coldMs = elapsed(started)
  const coldTotal = Number(cold.totalTurns); const olderTotal = Number(older.totalTurns)
  expect(coldTotal).toBe(count); expect(olderTotal).toBe(count); expect(Number(cold.turnFilesRead)).toBeGreaterThanOrEqual(count)
  const coldWrites = counters.archiveWrites
  const inserted = { ...session.turns[0], runId: `archive-insert-${count}`, providerTurnId: `archive-insert-turn-${count}`, userText: `archive-insert-prompt-${count}`, ts: count + 2 }
  const upsertArgs: JsonRecord = { ...session.args, turn: inserted }
  resetCounters(); archiveUserDataRoot = session.root; archiveScope = true; const insertStarted = process.hrtime.bigint()
  const insertResult = archive.upsertTraceArchiveTurnAsync
    ? await archive.upsertTraceArchiveTurnAsync(upsertArgs)
    : archive.upsertTraceArchiveTurn(upsertArgs)
  const retryResult = archive.upsertTraceArchiveTurnAsync
    ? await archive.upsertTraceArchiveTurnAsync(upsertArgs)
    : archive.upsertTraceArchiveTurn(upsertArgs)
  archiveScope = false
  const insertMs = elapsed(insertStarted)
  const insertedWrites = counters.archiveWrites
  expect(insertResult).toBe(true); expect(retryResult).toBe(true)
  resetCounters(); archiveScope = true; const postReadStarted = process.hrtime.bigint()
  const postRead = await archive.readTraceArchivePageAsync(session.args, { limit: 40 })
  const postReadMs = elapsed(postReadStarted)
  archiveScope = false
  expect(postRead.totalTurns).toBe(count + 1)
  const postWrites = counters.archiveWrites
  return { operation: 'archive.index', readAfterInsert: { ms: postReadMs, totalTurns: postRead.totalTurns, readMode: postRead.readMode, turnFilesRead: postRead.turnFilesRead, writeCount: postWrites.length, writeBytes: postWrites.reduce((total, write) => total + write.bytes, 0) }, existingTurns: count, cold: { ms: coldMs, readMode: cold.readMode, turnFilesRead: cold.turnFilesRead, totalTurns: coldTotal, writes: coldWrites.map(({ directory, bytes }) => ({ directory, bytes })), writeCount: coldWrites.length, writeBytes: coldWrites.reduce((total, write) => total + write.bytes, 0) }, warmedInsert: { ms: insertMs, api: archive.upsertTraceArchiveTurnAsync ? 'upsertTraceArchiveTurnAsync' : 'upsertTraceArchiveTurn', retry: 'same-ts-same-payload', inserted: insertResult, retryResult, writes: insertedWrites.map(({ directory, bytes }) => ({ directory, bytes })), writeCount: insertedWrites.length, writeBytes: insertedWrites.reduce((total, write) => total + write.bytes, 0) } }
}

async function runCommit(modules: { commit: CommitSource; aggregate: AggregateSource; hook: HookSource; store: StoreSource }): Promise<Record<string, unknown>> {
  const userText = `evidence-large-${'U'.repeat(256 * 1024 - 20)}-done`
  const workspace = await mkdtemp(join(tmpdir(), 'scry-evidence-managed-workspace-')); const userDataDir = await mkdtemp(join(tmpdir(), 'scry-evidence-managed-user-')); roots.push(workspace, userDataDir)
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'evidence', dataDir: '.scry', repositories: { mode: 'workspace-only' }, capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true } }))
  const events: JsonRecord[] = [{ id: 'assistant', ts: '2026-01-01T00:00:01.000Z', runId: 'run-evidence', kind: 'model', stage: 'text_delta', text: 'assistant' }, { id: 'result', ts: '2026-01-01T00:00:02.000Z', runId: 'run-evidence', kind: 'harness', stage: 'result', durationMs: 1 }]
  await modules.hook.handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace, managed: true, payload: { session_id: 'session-evidence', turn_id: 'turn-evidence', prompt: userText, timestamp: '2026-01-01T00:00:00.000Z' } })
  const evidence = modules.aggregate.aggregateTurnEvidence({ userText, events, source: 'scry_provider_adapter' })
  resetCounters(); commitScope = true; const started = process.hrtime.bigint()
  const result = await modules.commit.commitManagedTraceTurn({ userDataDir, cwd: workspace, sessionId: 'session-evidence', providerTurnId: 'turn-evidence', providerId: 'codex', runtimeProvider: 'codex_cli', timing: { startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z', durationMs: 1000 }, status: 'completed', turn: { runId: 'run-evidence', providerTurnId: 'turn-evidence', userText, items: events, turnEvidence: evidence, done: true, status: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z', durationMs: 1000, ts: Date.parse('2026-01-01T00:00:02.000Z') } }, { commitHookEnv: { ...process.env, SCRY_COMMIT_HOOK_TRUST: 'auto' } })
  commitScope = false
  const records = await modules.store.listRecords(join(workspace, '.scry'))
  const canonicalPromptPersisted = records.some((record) => record.user.value?.text === userText)
  expect(result.recorder).toBe('committed'); expect(canonicalPromptPersisted).toBe(true)
  const byDirectory = { 'managed-turn-commits': counters.writes.filter((write) => write.directory === 'managed-turn-commits'), 'managed-turn-journal-state': counters.writes.filter((write) => write.directory === 'managed-turn-journal-state') }
  const journalWrites = counters.writes.filter((write) => write.directory === 'managed-turn-commits' && !write.path.includes('/locks/'))
  return { operation: 'managed.commit', ms: elapsed(started), result: result.recorder, canonicalRecordCount: records.length, writes: byDirectory, writeCount: counters.writes.length, writeBytes: counters.writes.reduce((total, write) => total + write.bytes, 0), journalWriteCount: journalWrites.length, journalWriteBytes: journalWrites.reduce((total, write) => total + write.bytes, 0), canonicalPromptPersisted }
}

function emit(value: Record<string, unknown>): void {
  const line = JSON.stringify(value); process.stdout.write(`${line}\n`)
  const output = process.env.SCRY_BENCH_OUT
  if (output) void appendFile(resolve(output), `${line}\n`)
}

describe('performance evidence fixed before/after harness', () => {
  it('runs the real baseline/candidate operations without setup in timed sections', async () => {
    const restore = installTransparentCounters()
    try {
      const info = await sourceInfo(); const git = await sourceModule('core/turn-recorder/git.ts') as GitSource
      const pi = { ...(await sourceModule('main/pi-native-history.ts') as PiSource), ...(await sourceModule('main/session-history.ts') as PiSource) } as PiSource
      const archive = await sourceModule('main/transcript-archive.ts') as ArchiveSource
      const commit = await sourceModule('main/managed-turn-commit.ts') as CommitSource; const aggregate = await sourceModule('core/turn-recorder/aggregate.ts') as AggregateSource; const hook = await sourceModule('core/turn-recorder/recorder.ts') as HookSource; const store = await sourceModule('core/turn-recorder/store.ts') as StoreSource
      for (const count of gitCounts) emit({ source: info, scope: small ? 'small' : 'all', ...(await runGit(git, count)) })
      for (const turnsCount of (small ? [40] : [40, 400, 4000])) {
        const session = await piFixture(turnsCount)
        for (const phase of ['cold', 'unchanged-warm']) emit({ source: info, scope: small ? 'small' : 'all', ...(await runPi(pi, session, phase, turnsCount)) })
        await appendFile(session.file, `${JSON.stringify(nativeEntry('append-user', `result-${turnsCount - 1}`, 'user', 'appended'))}\n${JSON.stringify(nativeEntry('append-assistant', 'append-user', 'assistant', [{ type: 'text', text: 'appended-assistant' }, { type: 'toolCall', id: 'append-tool', name: 'read', arguments: { path: 'appended' } }]))}\n${JSON.stringify(nativeEntry('append-result', 'append-assistant', 'toolResult', [{ type: 'text', text: 'appended-output' }], { message: { role: 'toolResult', toolCallId: 'append-tool', toolName: 'read', content: [{ type: 'text', text: 'appended-output' }] } }))}\n`)
        emit({ source: info, scope: small ? 'small' : 'all', ...(await runPi(pi, session, 'append-once', turnsCount)) })
        emit({ source: info, scope: small ? 'small' : 'all', ...(await runPi(pi, session, 'second-warm', turnsCount)) })
      }
      for (const count of (small ? [40] : [40, 400, 4000])) emit({ source: info, scope: small ? 'small' : 'all', ...(await runArchive(archive, count)) })
      for (let repeat = 0; repeat < repeats; repeat++) emit({ source: info, scope: small ? 'small' : 'all', repeat, ...(await runCommit({ commit, aggregate, hook, store })) })
    } finally { nativeScope = false; commitScope = false; restore(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) }
  }, 180_000)
})
