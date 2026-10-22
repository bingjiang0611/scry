import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsPromises from 'node:fs/promises'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const requestedSource = process.env.SCRY_B_SOURCE ? resolve(process.env.SCRY_B_SOURCE) : resolve(here, '../../src')
const sourceRoot = existsSync(join(requestedSource, 'main', 'pi-native-history.ts'))
  ? requestedSource
  : join(requestedSource, 'src')
const small = process.env.SCRY_BENCH_SMALL === '1'
const repeats = small ? 1 : Math.min(3, Math.max(1, Number(process.env.SCRY_BENCH_REPEATS ?? 3)))
const gitCounts = small ? [4] : [4, 100, 1000]
const piTurns = small ? 40 : 4000
const roots: string[] = []

type Counters = { git: number; patchSpawns: number; nativeBytes: number; jsonParses: number; writes: Array<{ directory: string; path: string; bytes: number }> }
let counters: Counters = freshCounters()
let nativeScope = false
let commitScope = false

function freshCounters(): Counters { return { git: 0, patchSpawns: 0, nativeBytes: 0, jsonParses: 0, writes: [] } }
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
  const originalExecFile = (awaitableChildProcess()).execFile
  const originalParse = JSON.parse
  const originalOpenCustom = (originalOpen as unknown as { [key: symbol]: unknown })[Symbol.for('nodejs.util.promisify.custom')]
  const originalExecCustom = (originalExecFile as unknown as { [key: symbol]: unknown })[promisify.custom]
  const wrapHandle = (handle: any, path: string): any => new Proxy(handle, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'read') return (...args: unknown[]) => Promise.resolve(value.apply(target, args)).then((result: { bytesRead: number }) => {
        if (nativeScope) counters.nativeBytes += result.bytesRead
        return result
      })
      if (property === 'readFile') return (...args: unknown[]) => Promise.resolve(value.apply(target, args)).then((result: unknown) => {
        if (nativeScope) counters.nativeBytes += bytesOf(result)
        return result
      })
      if (property === 'writeFile') return (...args: unknown[]) => {
        if (commitScope && (path.includes('/managed-turn-commits/') || path.includes('/managed-turn-journal-state/'))) {
          counters.writes.push({ directory: path.includes('/managed-turn-journal-state/') ? 'managed-turn-journal-state' : 'managed-turn-commits', path, bytes: bytesOf(args[0]) })
        }
        return value.apply(target, args)
      }
      return value.bind(target)
    }
  })
  const wrappedOpen = async function(this: unknown, ...args: any[]): Promise<any> {
    const handle = await originalOpen.apply(this, args)
    return wrapHandle(handle, String(args[0]))
  }
  const wrappedExecFile = function(this: unknown, ...args: any[]): unknown {
    const file = String(args[0])
    if (file === 'git' && !nativeScope && !commitScope) {
      const argv = commandArgs(args)
      counters.git += 1
      if (argv.some((arg) => arg.startsWith('--output='))) counters.patchSpawns += 1
    }
    return originalExecFile.apply(this, args)
  }
  if (originalOpenCustom) Object.defineProperty(wrappedOpen, promisify.custom, { value: originalOpenCustom })
  if (originalExecCustom) Object.defineProperty(wrappedExecFile, promisify.custom, { value: function(this: unknown, ...args: any[]) {
    const file = String(args[0])
    if (file === 'git' && !nativeScope && !commitScope) {
      const argv = commandArgs(args)
      counters.git += 1
      if (argv.some((arg) => arg.startsWith('--output='))) counters.patchSpawns += 1
    }
    return (originalExecCustom as Function).apply(this, args)
  } })
  ;(fsPromises as any).open = wrappedOpen
  ;(awaitableChildProcess() as any).execFile = wrappedExecFile
  const moduleApi = awaitableModuleApi()
  moduleApi.syncBuiltinESMExports()
  JSON.parse = function(this: unknown, ...args: any[]): any {
    if (nativeScope) counters.jsonParses += 1
    return originalParse.apply(this, args)
  }
  return () => {
    ;(fsPromises as any).open = originalOpen
    ;(awaitableChildProcess() as any).execFile = originalExecFile
    moduleApi.syncBuiltinESMExports()
    JSON.parse = originalParse
  }
}

// Kept as functions so importing this fixture never aliases a mutable production module.
function awaitableChildProcess(): typeof import('node:child_process') { return requireBuiltin('node:child_process') }
function awaitableModuleApi(): typeof import('node:module') { return requireBuiltin('node:module') }
function requireBuiltin(name: string): any { return name === 'node:child_process' ? childProcessModule : moduleModule }
import childProcessModule from 'node:child_process'
import moduleModule from 'node:module'

async function sourceModule(path: string): Promise<any> { return import(pathToFileURL(join(sourceRoot, path)).href) }
async function sourceInfo(): Promise<{ root: string; sha: string; env: string | null }> {
  let sha = 'unknown'
  try { sha = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
  return { root: sourceRoot, sha, env: process.env.SCRY_B_SOURCE ?? null }
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

async function runGit(git: any, count: number): Promise<Record<string, unknown>> {
  const samples: Array<Record<string, unknown>> = []
  for (let repeat = 0; repeat < repeats; repeat++) {
    const root = await gitFixture(count)
    const capture = await git.beginGitTurnDiff(root)
    for (let i = 0; i < count; i++) await writeFile(join(root, `changed-${i}.txt`), `after-${i}\n`)
    resetCounters(); const started = process.hrtime.bigint(); nativeScope = false
    const snapshot = await git.finishGitTurnDiff(capture, 10_000); const ms = elapsed(started)
    const files = snapshot.files.map((file: any) => file.path).sort()
    if (snapshot.status === 'captured') {
      expect(files).toHaveLength(count)
      expect(files.map((path: string) => path.slice(path.lastIndexOf('/') + 1))).toEqual(Array.from({ length: count }, (_, i) => `changed-${i}.txt`).sort())
    }
    expect(snapshot.status).not.toBe('failed')
    samples.push({ repeat, ms, status: snapshot.status, reason: snapshot.reason ?? null, fileCount: files.length, gitProcesses: counters.git, batchPatchSpawns: counters.patchSpawns, patchUnavailable: snapshot.files.filter((file: any) => file.patchStatus === 'unavailable').length })
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
function selectedPayload(turns: any[]): string {
  return JSON.stringify(turns.map((turn) => ({ runId: turn.runId, userText: turn.userText, items: turn.items.map((item: any) => ({ id: item.id, stage: item.stage, text: item.text, tool: item.tool, toolUseId: item.toolUseId, output: item.output })) })))
}
async function runPi(pi: any, session: any, phase: string): Promise<Record<string, unknown>> {
  resetCounters(); nativeScope = true; const started = process.hrtime.bigint()
  let selected: any[]; let mode: string
  if (pi.readPiNativeHistorySnapshot) {
    mode = 'snapshot'; const snapshot = await pi.readPiNativeHistorySnapshot({ sessionRoot: session.root, cwd: session.cwd, sessionId: session.sessionId })
    if (!snapshot) throw new Error('Pi snapshot unexpectedly unavailable')
    const latest = pi.sessionHistoryPage(snapshot.turns, { limit: 40 }); const older = pi.sessionHistoryPage(snapshot.turns, { before: latest.offset, limit: 40 })
    selected = await snapshot.hydrate([...older.turns, ...latest.turns].map((turn: any) => turn.runId))
  } else {
    mode = 'native-all'; const turns = await pi.readPiNativeHistory({ sessionRoot: session.root, cwd: session.cwd, sessionId: session.sessionId })
    if (!turns) throw new Error('Pi history unexpectedly unavailable')
    const latest = pi.sessionHistoryPage(turns, { limit: 40 }); const older = pi.sessionHistoryPage(turns, { before: latest.offset, limit: 40 }); selected = [...older.turns, ...latest.turns]
  }
  nativeScope = false
  return { operation: 'pi.history', phase, turns: piTurns, mode, ms: elapsed(started), physicalBytes: counters.nativeBytes, jsonParseCalls: counters.jsonParses, selectedRunIds: selected.map((turn) => turn.runId), selectedPayloadSha256: createHash('sha256').update(selectedPayload(selected)).digest('hex') }
}

async function findPayload(root: string, payload: string): Promise<boolean> {
  if (!existsSync(root)) return false
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && await findPayload(path, payload)) return true
    if (entry.isFile() && (await readFile(path, 'utf8')).includes(payload)) return true
  }
  return false
}
async function runCommit(modules: { commit: any; aggregate: any; hook: any }): Promise<Record<string, unknown>> {
  const userText = `evidence-large-${'U'.repeat(256 * 1024 - 20)}-done`
  const workspace = await mkdtemp(join(tmpdir(), 'scry-evidence-managed-workspace-')); const userDataDir = await mkdtemp(join(tmpdir(), 'scry-evidence-managed-user-')); roots.push(workspace, userDataDir)
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'evidence', dataDir: '.scry', repositories: { mode: 'workspace-only' }, capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true } }))
  const events = [{ id: 'assistant', ts: '2026-01-01T00:00:01.000Z', runId: 'run-evidence', kind: 'model', stage: 'text_delta', text: 'assistant' }, { id: 'result', ts: '2026-01-01T00:00:02.000Z', runId: 'run-evidence', kind: 'harness', stage: 'result', durationMs: 1 }]
  await modules.hook.handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace, managed: true, payload: { session_id: 'session-evidence', turn_id: 'turn-evidence', prompt: userText, timestamp: '2026-01-01T00:00:00.000Z' } })
  const evidence = modules.aggregate.aggregateTurnEvidence({ userText, events, source: 'scry_provider_adapter' })
  resetCounters(); commitScope = true; const started = process.hrtime.bigint()
  const result = await modules.commit.commitManagedTraceTurn({ userDataDir, cwd: workspace, sessionId: 'session-evidence', providerTurnId: 'turn-evidence', providerId: 'codex', runtimeProvider: 'codex_cli', timing: { startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z', durationMs: 1000 }, status: 'completed', turn: { runId: 'run-evidence', providerTurnId: 'turn-evidence', userText, items: events, turnEvidence: evidence, done: true, status: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z', durationMs: 1000, ts: Date.parse('2026-01-01T00:00:02.000Z') } }, { commitHookEnv: { ...process.env, SCRY_COMMIT_HOOK_TRUST: 'auto' } })
  commitScope = false
  const persisted = await findPayload(join(workspace, '.scry'), userText)
  expect(result.recorder).toBe('committed'); expect(persisted).toBe(true)
  const byDirectory = { 'managed-turn-commits': counters.writes.filter((write) => write.directory === 'managed-turn-commits'), 'managed-turn-journal-state': counters.writes.filter((write) => write.directory === 'managed-turn-journal-state') }
  const journalWrites = counters.writes.filter((write) => write.directory === 'managed-turn-commits' && !write.path.includes('/locks/'))
  return { operation: 'managed.commit', ms: elapsed(started), result: result.recorder, writes: byDirectory, writeCount: counters.writes.length, writeBytes: counters.writes.reduce((total, write) => total + write.bytes, 0), journalWriteCount: journalWrites.length, journalWriteBytes: journalWrites.reduce((total, write) => total + write.bytes, 0), canonicalPayloadPersisted: persisted }
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
      const info = await sourceInfo(); const git = await sourceModule('core/turn-recorder/git.ts'); const pi = { ...(await sourceModule('main/pi-native-history.ts')), ...(await sourceModule('main/session-history.ts')) }
      const commit = await sourceModule('main/managed-turn-commit.ts'); const aggregate = await sourceModule('core/turn-recorder/aggregate.ts'); const hook = await sourceModule('core/turn-recorder/recorder.ts')
      for (const count of gitCounts) emit({ source: info, scope: small ? 'small' : 'all', ...(await runGit(git, count)) })
      const session = await piFixture(piTurns)
      for (const phase of ['cold', 'unchanged-warm']) emit({ source: info, scope: small ? 'small' : 'all', ...(await runPi(pi, session, phase)) })
      await appendFile(session.file, `${JSON.stringify(nativeEntry('append-user', `result-${piTurns - 1}`, 'user', 'appended'))}\n${JSON.stringify(nativeEntry('append-assistant', 'append-user', 'assistant', [{ type: 'text', text: 'appended-assistant' }, { type: 'toolCall', id: 'append-tool', name: 'read', arguments: { path: 'appended' } }]))}\n${JSON.stringify(nativeEntry('append-result', 'append-assistant', 'toolResult', [{ type: 'text', text: 'appended-output' }], { message: { role: 'toolResult', toolCallId: 'append-tool', toolName: 'read', content: [{ type: 'text', text: 'appended-output' }] } }))}\n`)
      emit({ source: info, scope: small ? 'small' : 'all', ...(await runPi(pi, session, 'append-once')) })
      emit({ source: info, scope: small ? 'small' : 'all', ...(await runPi(pi, session, 'second-warm')) })
      for (let repeat = 0; repeat < repeats; repeat++) emit({ source: info, scope: small ? 'small' : 'all', repeat, ...(await runCommit({ commit, aggregate, hook })) })
    } finally { nativeScope = false; commitScope = false; restore(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) }
  }, 180_000)
})
