import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { TraceEvent } from '../src/shared/trace'
import { TerminalOutputBridge } from '../src/main/terminal-output'
import { sessionHistoryPage } from '../src/main/session-history'
import { applyTraceBatch, aggregateFiles } from '../src/renderer/format'
import { listMcp } from '../src/main/mcp-config'
import { listSkills } from '../src/main/skill-config'
import { cleanupAppStoreAtomicTemps } from '../src/main/app-store'
import { cleanupUsageAtomicTemps, readUsageStats } from '../src/main/usage-jsonl'
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
import { activeTurn, assertCompleteProjection, deliverTrace, events, history, terminalChunks, timestamp, type Fixture, type Scenario } from './performance-baseline-fixture'

export function scenariosFor(fixture: Fixture): Record<string, Scenario> {
  let archiveWrite = 0
  return {
    'trace.delivery': { lane: 'domain', workload: 'trace-events=1000;unicode=true', iterations: 20, warmups: 3, samples: 20, run: () => deliverTrace(events) },
    'renderer.batch': {
      lane: 'domain', workload: 'trace-events=1000;unicode=true', iterations: 20, warmups: 3, samples: 20,
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
      lane: 'domain', workload: 'history-turns=4000;page=40', iterations: 20, warmups: 3, samples: 20,
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
      lane: 'domain', workload: 'terminal-chunks=1000;unicode=true', iterations: 20, warmups: 3, samples: 20,
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
          for await (const chunk of leg) chunks.push(Buffer.from(chunk))
          const output = Buffer.concat(chunks)
          expect(protocolError).toBeUndefined()
          expect(output.equals(payload)).toBe(true)
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
