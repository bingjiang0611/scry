import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { TraceEvent } from '../src/shared/trace'
import type { Turn } from '../src/renderer/format'
import { TraceOutputBridge } from '../src/main/trace-output'
import { createAppSessionStore } from '../src/main/app-store'
import { appendUsage } from '../src/main/usage-jsonl'
import { upsertTraceArchiveTurn } from '../src/main/transcript-archive'

export const timestamp = '2026-01-01T00:00:00.000Z'
export const events: TraceEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `event-${index}`, runId: 'run-fixed', ts: timestamp,
  kind: 'model', stage: 'text_delta', messageId: 'message-fixed', text: 'fixed 中文 output\n'
}))
export const history = Array.from({ length: 4_000 }, (_, index) => ({
  runId: `turn-${index}`, userText: `fixed request ${index}`, done: true,
  ts: index, items: [{ ...events[0], id: `answer-${index}`, runId: `turn-${index}`, stage: 'text' as const }]
}))
export const terminalChunks = Array.from({ length: 1_000 }, () => 'fixed terminal 中文 output\n')
export const activeTurn: Turn = { runId: 'run-fixed', userText: 'fixed request', done: false, items: [] }

export type Counters = Record<string, number>
export type Scenario = { lane: 'domain' | 'disk' | 'process'; workload: string; iterations: number; warmups?: number; samples?: number; run: () => Counters | Promise<Counters> }
export type Fixture = {
  root: string; home: string; workspace: string; userData: string
  store: ReturnType<typeof createAppSessionStore>
  workspaceGit: string
  archive: { cwd: string; sessionId: string; providerId: 'codex'; userDataDir: string }
}

export function deliverTrace(input: TraceEvent[]): Counters {
  let bytes = 0; let messages = 0; let delivered = 0
  const received: TraceEvent[] = []
  const bridge = new TraceOutputBridge({ canSend: () => true, schedule: () => () => {}, send: batch => {
    bytes += Buffer.byteLength(JSON.stringify(batch)); messages++; delivered += batch.events.length; received.push(...batch.events)
  } })
  for (const event of input) bridge.push(event)
  bridge.flushAll(); bridge.close()
  expect(JSON.stringify(received)).toBe(JSON.stringify(input))
  return { bytes, messages, events: delivered }
}

export function assertCompleteProjection(result: Turn[]): void {
  expect(result).toHaveLength(1)
  expect(result[0].runId).toBe(activeTurn.runId)
  expect(result[0].done).toBe(false)
  expect(result[0].items.map(item => item.text ?? '').join('')).toBe(events.map(event => event.text).join(''))
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'scry-performance-'))
  const home = join(root, 'home'); const workspace = join(home, 'workspace')
  const userData = join(root, 'user-data'); const workspaceGit = join(root, 'git-workspace')
  for (const path of [home, workspace, userData, workspaceGit]) mkdirSync(path, { recursive: true })
  mkdirSync(join(home, '.claude', 'skills', 'fixed-skill'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'fixed-skill', 'SKILL.md'), '# Fixed skill\n')
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fixed: { command: 'node', args: ['fixed-server.mjs'], env: { FIXED: '1' } } } }))
  for (let index = 0; index < 120; index++) writeFileSync(join(workspace, `file-${index}.ts`), `export const value${index} = ${index}\n`)
  const largeFile = join(workspace, 'large-fixed.txt')
  writeFileSync(largeFile, 'x'.repeat(1024 * 1024))
  const gitEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' }
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', '.'], { cwd: workspaceGit, env: gitEnv })
  writeFileSync(join(workspaceGit, 'changed.ts'), 'export const changed = false\\n')
  execFileSync('git', ['add', 'changed.ts'], { cwd: workspaceGit, env: gitEnv })
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.email=bench@scry.local', '-c', 'user.name=bench', 'commit', '-q', '-m', 'baseline'], { cwd: workspaceGit, env: gitEnv })
  const store = createAppSessionStore(userData)
  for (let index = 0; index < 500; index++) store.recordPending({ providerId: 'codex', runtimeProvider: 'codex_cli', runId: `catalog-run-${index}`, cwd: workspace, prompt: `catalog prompt ${index}` })
  for (let index = 0; index < 240; index++) appendUsage(userData, { providerId: 'codex', runtimeProvider: 'codex_cli', cwd: workspace, externalSessionId: 'fixed-session', runId: `usage-${index}` }, { costUsd: 0.01, tokensIn: 100 + index, tokensOut: 40, ts: timestamp })
  const archive = { cwd: workspace, sessionId: 'fixed-session', providerId: 'codex' as const, userDataDir: userData }
  for (let index = 0; index < 120; index++) upsertTraceArchiveTurn({ ...archive, turn: { runId: `archive-${index}`, userText: `archive request ${index}`, done: true, ts: index, items: [{ ...events[index % events.length], id: `archive-event-${index}`, runId: `archive-${index}`, stage: 'text' as const }] } })
  return { root, home, workspace, userData, store, workspaceGit, archive }
}

export function duplicateTraceControl(): Counters { return deliverTrace([...events, ...events]) }
