import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { cpus, tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../src/shared/trace'
import { TraceOutputBridge } from '../src/main/trace-output'
import { TerminalOutputBridge } from '../src/main/terminal-output'
import { sessionHistoryPage } from '../src/main/session-history'
import { applyTraceBatch, aggregateFiles, type Turn } from '../src/renderer/format'
import { listMcp } from '../src/main/mcp-config'
import { listSkills } from '../src/main/skill-config'
import { createAppSessionStore, cleanupAppStoreAtomicTemps } from '../src/main/app-store'
import { appendUsage, cleanupUsageAtomicTemps, readUsageStats } from '../src/main/usage-jsonl'
import { cleanupTraceTurnProgressTemps } from '../src/main/trace-turn-progress'
import { cleanupTraceArchiveTemps, readTraceArchivePageAsync, upsertTraceArchiveTurn } from '../src/main/transcript-archive'
import { listWorkspace, readWorkspaceFile, readWorkspaceFilePage, writeWorkspaceFile } from '../src/main/workspace-files'
import { readWorkspaceGitDiff } from '../src/core/turn-recorder/git'
import { previewTraceItems } from '../src/main/remote/trace-output'
import { buildAnalyticsStats } from '../src/main/span-ledger'
import { readComposerDrafts, updateComposerDraft, writeComposerDrafts } from '../src/renderer/composer-drafts'
import { CodexAppServerClient } from '../src/main/providers/codex-app-server'
import { RunStopLifecycle } from '../src/main/run-stop-lifecycle'
import { createRelayConnect } from '../src/main/remote/relay-connect'
import { execFileOutcome } from '../src/main/claude-locate'

// Fixed local workloads. Every scenario calls a production implementation and asserts its
// output. Native UI paint, Provider latency and phone/network hops remain separate acceptance.
const timestamp = '2026-01-01T00:00:00.000Z'
const events: TraceEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `event-${index}`, runId: 'run-fixed', ts: timestamp,
  kind: 'model', stage: 'text_delta', messageId: 'message-fixed', text: 'fixed 中文 output\n'
}))
const history = Array.from({ length: 4_000 }, (_, index) => ({
  runId: `turn-${index}`, userText: `fixed request ${index}`, done: true,
  ts: index, items: [{ ...events[0], id: `answer-${index}`, runId: `turn-${index}`, stage: 'text' as const }]
}))
const terminalChunks = Array.from({ length: 1_000 }, () => 'fixed terminal 中文 output\n')
const activeTurn: Turn = { runId: 'run-fixed', userText: 'fixed request', done: false, items: [] }

type Counters = Record<string, number>
type Scenario = {
  lane: 'domain' | 'disk' | 'process'
  workload: string
  iterations: number
  warmups?: number
  samples?: number
  run: () => Counters | Promise<Counters>
}

type Fixture = {
  root: string
  home: string
  workspace: string
  userData: string
  store: ReturnType<typeof createAppSessionStore>
  workspaceGit: string
  archive: { cwd: string; sessionId: string; providerId: 'codex'; userDataDir: string }
}

export function deliverTrace(input: TraceEvent[]): Counters {
  let bytes = 0
  let messages = 0
  let delivered = 0
  const received: TraceEvent[] = []
  const bridge = new TraceOutputBridge({
    canSend: () => true,
    schedule: () => () => {},
    send: batch => {
      bytes += Buffer.byteLength(JSON.stringify(batch))
      messages++
      delivered += batch.events.length
      received.push(...batch.events)
    }
  })
  for (const event of input) bridge.push(event)
  bridge.flushAll()
  bridge.close()
  expect(JSON.stringify(received)).toBe(JSON.stringify(input))
  return { bytes, messages, events: delivered }
}

export function assertCompleteProjection(result: Turn[]): void {
  expect(result).toHaveLength(1)
  expect(result[0].runId).toBe(activeTurn.runId)
  expect(result[0].done).toBe(false)
  expect(result[0].items.map(item => item.text ?? '').join('')).toBe(events.map(event => event.text).join(''))
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'scry-performance-'))
  const home = join(root, 'home')
  const workspace = join(home, 'workspace')
  const userData = join(root, 'user-data')
  const workspaceGit = join(root, 'git-workspace')
  for (const path of [home, workspace, userData, workspaceGit]) mkdirSync(path, { recursive: true })
  mkdirSync(join(home, '.claude', 'skills', 'fixed-skill'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'fixed-skill', 'SKILL.md'), '# Fixed skill\n')
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: {
    fixed: { command: 'node', args: ['fixed-server.mjs'], env: { FIXED: '1' } }
  }}))
  for (let index = 0; index < 120; index++) writeFileSync(join(workspace, `file-${index}.ts`), `export const value${index} = ${index}\n`)
  const largeFile = join(workspace, 'large-fixed.txt')
  writeFileSync(largeFile, 'x'.repeat(1024 * 1024))
  const gitEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' }
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', '.'], { cwd: workspaceGit, env: gitEnv })
  writeFileSync(join(workspaceGit, 'changed.ts'), 'export const changed = false\\n')
  execFileSync('git', ['add', 'changed.ts'], { cwd: workspaceGit, env: gitEnv })
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.email=bench@scry.local', '-c', 'user.name=bench', 'commit', '-q', '-m', 'baseline'], { cwd: workspaceGit, env: gitEnv })
  const store = createAppSessionStore(userData)
  for (let index = 0; index < 500; index++) store.recordPending({
    providerId: 'codex', runtimeProvider: 'codex_cli', runId: `catalog-run-${index}`, cwd: workspace,
    prompt: `catalog prompt ${index}`
  })
  for (let index = 0; index < 240; index++) appendUsage(userData, {
    providerId: 'codex', runtimeProvider: 'codex_cli', cwd: workspace,
    externalSessionId: 'fixed-session', runId: `usage-${index}`
  }, { costUsd: 0.01, tokensIn: 100 + index, tokensOut: 40, ts: timestamp })
  const archive = { cwd: workspace, sessionId: 'fixed-session', providerId: 'codex' as const, userDataDir: userData }
  for (let index = 0; index < 120; index++) upsertTraceArchiveTurn({ ...archive, turn: {
    runId: `archive-${index}`, userText: `archive request ${index}`, done: true, ts: index,
    items: [{ ...events[index % events.length], id: `archive-event-${index}`, runId: `archive-${index}`, stage: 'text' as const }]
  } })
  return { root, home, workspace, userData, store, workspaceGit, archive }
}

export function duplicateTraceControl(): Counters { return deliverTrace([...events, ...events]) }

function scenariosFor(fixture: Fixture): Record<string, Scenario> {
  let archiveWrite = 0
  return {
    'trace.delivery': { lane: 'domain', workload: 'trace-events=1000;unicode=true', iterations: 20, warmups: 3, samples: 15, run: () => deliverTrace(events) },
    'renderer.batch': {
      lane: 'domain', workload: 'trace-events=1000;unicode=true', iterations: 20, warmups: 3, samples: 15,
      run: () => {
        const result = applyTraceBatch([activeTurn], events, new Set())
        assertCompleteProjection(result)
        return { bytes: Buffer.byteLength(JSON.stringify(result)), turns: result.length }
      }
    },
    'startup.recovery': {
      lane: 'disk', workload: 'userData-temp-artifacts=4', iterations: 2,
      run: async () => {
        const stale = [
          join(fixture.userData, 'app-sessions.json.tmp'),
          join(fixture.userData, 'recent-folders.json.tmp'),
          join(fixture.userData, 'usage.jsonl.tmp'),
          join(fixture.userData, 'app-sessions.json.1.00000000-0000-4000-8000-000000000000.tmp')
        ]
        for (const path of stale) writeFileSync(path, 'stale')
        cleanupAppStoreAtomicTemps(fixture.userData)
        cleanupUsageAtomicTemps(fixture.userData)
        cleanupTraceTurnProgressTemps(fixture.userData)
        await cleanupTraceArchiveTemps(fixture.userData)
        expect(stale.every(path => !existsSync(path))).toBe(true)
        expect(readUsageStats(fixture.userData).turns).toBe(240)
        return { files: stale.length }
      }
    },
    'providers.catalog': {
      lane: 'disk', workload: 'home-skills=1;project-mcp=1', iterations: 5,
      run: () => {
        const skills = listSkills(fixture.workspace, fixture.home)
        const mcp = listMcp(fixture.workspace, fixture.home)
        expect(skills.some(skill => skill.name === 'fixed-skill')).toBe(true)
        expect(mcp.some(server => server.name === 'fixed')).toBe(true)
        return { skills: skills.length, mcp: mcp.length }
      }
    },
    'navigation.catalog': {
      lane: 'disk', workload: 'catalog-sessions=500', iterations: 5,
      run: () => {
        const sessions = fixture.store.load()
        expect(sessions).toHaveLength(500)
        expect(fixture.store.health().status).toBe('ready')
        return { sessions: sessions.length, bytes: Buffer.byteLength(JSON.stringify(sessions)) }
      }
    },
    'history.page': {
      lane: 'domain', workload: 'history-turns=4000;page=40', iterations: 20, warmups: 3, samples: 15,
      run: () => {
        const page = sessionHistoryPage(history, { limit: 40 })
        expect(page.turns).toEqual(history.slice(-40))
        expect(page.totalTurns).toBe(history.length)
        expect(page.hasOlder).toBe(true)
        return { bytes: Buffer.byteLength(JSON.stringify(page)), turns: page.turns.length }
      }
    },
    'compose.drafts': {
      lane: 'domain', workload: 'drafts=32;input=4KiB;bytes=131072', iterations: 5,
      run: () => {
        const storage: { value: string; getItem: () => string; setItem: (_key: string, value: string) => void; removeItem: () => void } = {
          value: '', getItem: () => storage.value,
          setItem: (_key, value) => { storage.value = value }, removeItem: () => { storage.value = '' }
        }
        let drafts = readComposerDrafts(storage)
        for (let index = 0; index < 32; index++) {
          const key = `codex\\0fixed\\0session-${index}`
          drafts = updateComposerDraft(drafts, key, () => ({ input: 'x'.repeat(4096), attachments: [] })).drafts
        }
        expect(writeComposerDrafts(storage, drafts)).toBe(true)
        const restored = readComposerDrafts(storage)
        expect(restored).toHaveProperty('size', 32)
        expect([...restored.values()].every(draft => draft.input === 'x'.repeat(4096))).toBe(true)
        return { drafts: restored.size, inputBytes: [...restored.values()].reduce((sum, draft) => sum + Buffer.byteLength(draft.input), 0), bytes: Buffer.byteLength(storage.value) }
      }
    },
    'send.codex-fixture': {
      lane: 'process', workload: 'provider=codex-fixture;thread=1;turn=1;output=hello', iterations: 2,
      run: async () => {
        const fixturePath = fileURLToPath(new URL('../src/main/providers/fixtures/codex-app-server.mjs', import.meta.url))
        const client = new CodexAppServerClient({ command: process.execPath, args: [fixturePath], cwd: fixture.workspace, env: { ...process.env, HOME: fixture.home, CODEX_HOME: join(fixture.root, 'codex-home') } })
        const notifications: Array<{ method: string; params: unknown }> = []
        let resolveCompleted: () => void = () => {}
        const completed = new Promise<void>(resolve => { resolveCompleted = resolve })
        const off = client.onNotification((method, params) => { notifications.push({ method, params }); if (method === 'turn/completed') resolveCompleted() })
        try {
          const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: fixture.workspace })
          await client.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'fixed local request' }] })
          await completed
          const delta = notifications.find(item => item.method === 'item/agentMessage/delta')
          expect(delta?.params).toMatchObject({ delta: 'hello', threadId: 'thread-1' })
          expect(notifications.some(item => item.method === 'turn/completed')).toBe(true)
          return { providerTurns: 1, notifications: notifications.length, outputBytes: Buffer.byteLength('hello') }
        } finally { off(); await client.shutdown() }
      }
    },
    'controls.stop-lifecycle': {
      lane: 'process', workload: 'provider=codex-fixture;turn=hangCompletion;stop=interrupt-settle', iterations: 2,
      run: async () => {
        const fixturePath = fileURLToPath(new URL('../src/main/providers/fixtures/codex-app-server.mjs', import.meta.url))
        const client = new CodexAppServerClient({ command: process.execPath, args: [fixturePath], cwd: fixture.workspace, env: { ...process.env, HOME: fixture.home } })
        const published: string[] = []
        const lifecycle = new RunStopLifecycle({ publish: state => published.push(state.phase) })
        let resolveCompleted: (params: unknown) => void = () => {}
        const completed = new Promise<unknown>(resolve => { resolveCompleted = resolve })
        const off = client.onNotification((method, params) => { if (method === 'turn/completed') resolveCompleted(params) })
        let interruption: Promise<unknown> | undefined
        try {
          const thread = await client.request<{ thread: { id: string } }>('thread/start', { cwd: fixture.workspace })
          await client.request('turn/start', { threadId: thread.thread.id, hangCompletion: true })
          const state = lifecycle.request({ runId: 'fixed-stop', providerId: 'codex', runtimeProvider: 'codex_cli', interrupt: () => { interruption = client.request('turn/interrupt', { threadId: thread.thread.id, turnId: 'turn-1' }) }, forceKill: () => client.close(), forceKillScope: () => 'run_scoped' })
          expect(state.phase).toBe('interrupt_requested')
          await interruption
          // The command response is only a receipt. Settlement requires the provider terminal event.
          expect(await completed).toMatchObject({ threadId: thread.thread.id, turn: { id: 'turn-1', status: 'interrupted' } })
          const settled = lifecycle.settle('fixed-stop')
          expect(settled?.providerSettled).toBe(true)
          expect(published).toEqual(['interrupt_requested', 'settled'])
          return { interruptRequests: 1, terminalStates: 1, providerSettled: 1 }
        } finally { off(); lifecycle.close(); await client.shutdown() }
      }
    },
    'persistence.archive': {
      lane: 'disk', workload: 'archive-turns=120;page=40', iterations: 2,
      run: async () => {
        const writtenRunId = 'archive-fixed-write'
        // Equal-size changes force each measured write to persist fresh evidence.
        const writtenText = ++archiveWrite % 2 ? 'persisted fixed output' : 'persisted fixed Output'
        const written = upsertTraceArchiveTurn({ ...fixture.archive, turn: {
          runId: writtenRunId, userText: 'persisted fixed request', done: true, ts: 121,
          items: [{ ...events[0], id: 'archive-fixed-write-event', runId: writtenRunId, stage: 'text' as const, text: writtenText }]
        } })
        expect(written).toBe(true)
        const page = await readTraceArchivePageAsync(fixture.archive, { limit: 40 })
        expect(page.archive?.turns).toHaveLength(40)
        expect(page.totalTurns).toBe(121)
        const restored = (await readTraceArchivePageAsync(fixture.archive, { before: 121, limit: 1 })).archive?.turns.at(-1)
        expect(restored?.runId).toBe(writtenRunId)
        expect(restored?.items[0].text).toBe(writtenText)
        return { turns: page.archive?.turns.length ?? 0, writtenTurns: 1, bytes: Buffer.byteLength(JSON.stringify(page)) }
      }
    },
    'evidence.projection': {
      lane: 'domain', workload: 'trace-events=1000;tool-events=2', iterations: 20,
      run: () => {
        const toolEvents: TraceEvent[] = [
          { ...events[0], kind: 'tool', stage: 'tool_use', tool: 'Read', toolUseId: 'tool-1', fileOp: 'read', filePath: 'src/fixed.ts' },
          { ...events[1], kind: 'tool', stage: 'tool_result', tool: 'Read', toolUseId: 'tool-1', output: 'fixed content' }
        ]
        const rows = aggregateFiles(toolEvents)
        const preview = previewTraceItems([...events, ...toolEvents])
        expect(rows.structured).toHaveLength(1)
        expect(preview.items.length).toBeGreaterThan(0)
        return { files: rows.structured.length, previewItems: preview.items.length, bytes: Buffer.byteLength(JSON.stringify(preview)) }
      }
    },
    'analytics.stats': {
      lane: 'domain', workload: 'analytics-results=240;days=90', iterations: 5,
      run: () => {
        const now = Date.parse(timestamp)
        const results = Array.from({ length: 240 }, (_, index) => ({ tsStart: now - index * 3_600_000, providerId: 'codex', inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 2 }))
        const result = buildAnalyticsStats({ nowMs: now, results, tools: results.map(row => ({ tsStart: row.tsStart })), dangers: results.map(row => ({ tsStart: row.tsStart, level: 'warn' })), mcp: results.map(row => ({ server: 'fixed', durationMs: 3, isError: 0 })) })
        expect(result.tokenDaily).toHaveLength(30)
        expect(result.providerCoverage.find(row => row.providerId === 'codex')?.turns).toBeGreaterThan(0)
        return { resultRows: results.length, days: result.tokenDaily.length, providers: result.providerCoverage.length }
      }
    },
    'workspace.files': {
      lane: 'disk', workload: 'directory=122;file=1MiB;page=64KiB', iterations: 2,
      run: async () => {
        const listed = await listWorkspace({ cwd: fixture.workspace, path: '', limit: 200 })
        const file = await readWorkspaceFile({ cwd: fixture.workspace, path: 'large-fixed.txt' })
        const page = await readWorkspaceFilePage({ cwd: fixture.workspace, path: 'large-fixed.txt', limit: 64 * 1024 })
        expect(['x', 'y']).toContain(file.content[0])
        expect(file.content).toBe(file.content[0].repeat(1024 * 1024))
        const content = (file.content[0] === 'x' ? 'y' : 'x').repeat(1024 * 1024)
        const saved = await writeWorkspaceFile({ cwd: fixture.workspace, path: 'large-fixed.txt', content, expectedRevision: file.revision })
        expect(listed.entries).toHaveLength(122)
        expect(listed.entries.some(entry => entry.path === 'large-fixed.txt' && entry.size === 1024 * 1024)).toBe(true)
        expect(page.content.startsWith(file.content.slice(0, 64 * 1024))).toBe(true)
        expect(saved.content).toBe(content)
        expect(readFileSync(join(fixture.workspace, 'large-fixed.txt'), 'utf8')).toBe(content)
        return { entries: listed.entries.length, bytes: file.size, pageBytes: Buffer.byteLength(page.content) }
      }
    },
    'source-control.diff': {
      lane: 'process', workload: 'git-worktree=1;changed-files=1', iterations: 2,
      run: async () => {
        writeFileSync(join(fixture.workspaceGit, 'changed.ts'), 'export const changed = true\\n')
        const diff = await readWorkspaceGitDiff(fixture.workspaceGit)
        expect(diff.status).toBe('captured')
        expect(diff.patch).toContain('changed = true')
        return { files: 1, bytes: Buffer.byteLength(diff.patch) }
      }
    },
    'terminal.delivery': {
      lane: 'domain', workload: 'terminal-chunks=1000;unicode=true', iterations: 20, warmups: 3, samples: 15,
      run: () => {
        let bytes = 0
        let messages = 0
        let output = ''
        const bridge = new TerminalOutputBridge({
          canSend: () => true,
          sendData: batch => { messages++; bytes += Buffer.byteLength(JSON.stringify(batch)); output += batch.map(item => item.data).join('') },
          sendExit: () => {}, pauseTerminal: () => {}, resumeTerminal: () => {}
        })
        const epoch = bridge.started('terminal-fixed')
        bridge.ready('terminal-fixed', epoch)
        for (const data of terminalChunks) bridge.data({ id: 'terminal-fixed', data })
        bridge.exit({ id: 'terminal-fixed', exitCode: 0 })
        bridge.close()
        expect(output).toBe(terminalChunks.join(''))
        return { bytes, messages, outputBytes: Buffer.byteLength(output) }
      }
    },
    'remote.loopback': {
      lane: 'process', workload: 'loopback-relay=1;payload=64KiB;auth=1', iterations: 2,
      run: async () => {
        const payload = Buffer.alloc(64 * 1024, 'r')
        const request = Buffer.from('fixed-device-request')
        let authLines = 0
        let relaySessions = 0
        let protocolError: unknown
        const server = createServer(socket => {
          socket.on('error', error => { protocolError = error })
          let received = Buffer.alloc(0)
          let sent = false
          socket.on('data', chunk => {
            received = Buffer.concat([received, chunk])
            const newline = received.indexOf(10)
            if (sent || newline < 0 || received.length < newline + 1 + request.length) return
            try {
              expect(JSON.parse(received.subarray(0, newline).toString())).toEqual({ hostId: 'fixed-host', token: 'isolated-fixture', mode: 'run' })
              expect(received.subarray(newline + 1)).toEqual(request)
              authLines++
              sent = true
              socket.end(payload)
            } catch (error) {
              protocolError = error
              socket.end()
            }
          })
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address() as { port: number }
        const { connect, readyEvent } = createRelayConnect({ host: '127.0.0.1', port: address.port, hostId: 'fixed-host', token: 'isolated-fixture', mode: 'run' })
        const leg = connect()
        leg.on('relaySession', () => { relaySessions++ })
        try {
          await once(leg, readyEvent)
          leg.write(request)
          const chunks: Buffer[] = []
          // Read through EOF, not just the expected prefix: duplicate bytes must fail too.
          for await (const chunk of leg) chunks.push(Buffer.from(chunk))
          const output = Buffer.concat(chunks)
          expect(protocolError).toBeUndefined()
          expect(output).toEqual(payload)
          expect(authLines).toBe(1)
          expect(relaySessions).toBe(1)
          return { authLines, payloadBytes: output.length, relaySessions }
        } finally { leg.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) }
      }
    },
    'resources-shell.process': {
      lane: 'process', workload: 'local-child=1;stdout=1;exit=0', iterations: 2,
      run: async () => {
        const result = await execFileOutcome(process.execPath, ['-e', "process.stdout.write('shell-fixed\\n')"], { env: { HOME: fixture.home, PATH: process.env.PATH ?? '' } })
        expect(result).toEqual({ stdout: 'shell-fixed\n', exitCode: 0, signal: null, timedOut: false })
        const output = result.stdout
        const usage = process.resourceUsage()
        expect(usage.userCPUTime).toBeGreaterThanOrEqual(0)
        return { childExit: 1, outputBytes: Buffer.byteLength(output), resourceUsageObserved: 1 }
      }
    }
  }
}

export const scenarioCatalogue = scenariosFor

describe('fixed production-path performance harness', () => {
  it('covers every user-path group with correct, measured local work', async () => {
    const fixture = makeFixture()
    try {
      const scenarios = scenariosFor(fixture)
      expect(Object.keys(scenarios)).toHaveLength(17)
      const results: Record<string, { counters: Counters; durationMs: number[]; iterations: number; warmups: number; samples: number; lane: Scenario['lane']; workload: string; outcome: 'completed' }> = {}
      for (const [name, scenario] of Object.entries(scenarios)) {
        const warmups = scenario.warmups ?? 1
        const samples = scenario.samples ?? 7
        for (let warmup = 0; warmup < warmups; warmup++) for (let iteration = 0; iteration < scenario.iterations; iteration++) await scenario.run()
        const durationMs: number[] = []
        let counters: Counters | undefined
        for (let sample = 0; sample < samples; sample++) {
          const started = performance.now()
          let next: Counters | undefined
          for (let iteration = 0; iteration < scenario.iterations; iteration++) next = await scenario.run()
          durationMs.push((performance.now() - started) / scenario.iterations)
          if (counters) expect(next).toEqual(counters)
          counters = next
        }
        results[name] = { counters: counters!, durationMs, iterations: scenario.iterations, warmups, samples, lane: scenario.lane, workload: scenario.workload, outcome: 'completed' }
      }
      expect(results['trace.delivery'].counters.events).toBe(events.length)
      expect(results['renderer.batch'].counters.turns).toBe(1)
      expect(results['history.page'].counters.turns).toBe(40)
      expect(results['terminal.delivery'].counters.outputBytes).toBeGreaterThan(0)
      const output = process.env.SCRY_PERFORMANCE_OUTPUT
      if (output) writeFileSync(output, JSON.stringify({
        schema: 1,
        measurement: { kind: 'batch-mean-ms', warmups: 3, samples: 15, iterationsPerSample: 20, perScenario: true },
        harness: createHash('sha256').update(readFileSync('scripts/performance-baseline.test.ts')).update(readFileSync('vitest.config.ts')).update(readFileSync('src/main/providers/fixtures/codex-app-server.mjs')).digest('hex'),
        revision: process.env.SCRY_PERFORMANCE_REVISION ?? 'working-tree',
        environment: { node: process.versions.node, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
        results
      }, null, 2))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('negative control: real duplicate publication increases transfer work', () => {
    const normal = deliverTrace(events)
    const duplicated = duplicateTraceControl()
    expect(duplicated.events).toBe(normal.events * 2)
    expect(duplicated.bytes).toBeGreaterThan(normal.bytes * 1.9)
    expect(duplicated.messages).toBeGreaterThan(normal.messages)
    expect(() => assertCompleteProjection(applyTraceBatch([activeTurn], events.slice(0, 1), new Set()))).toThrow()
  })
})
