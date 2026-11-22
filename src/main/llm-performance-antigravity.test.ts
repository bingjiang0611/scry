import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { llmComparisonRounds, type LlmPerformanceHistoryRow } from '../shared/llm-performance'
import { normalizeAgentStartRequest } from '../shared/runtime'
import type { TraceEvent } from '../shared/trace'
import { createLlmPerformanceRecorder } from './bootstrap/run-metrics'
import { readLlmPerformanceHistory } from './llm-performance-history'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { appendLlmPerformance, usageJsonlPath } from './usage-jsonl'

const sessionId = '10000000-0000-4000-8000-000000000000'
const startedAt = '2026-11-22T06:15:18.546Z'
const endedAt = '2026-11-22T06:18:09.115Z'
const observedAt = '2026-11-22T06:18:10.224Z'
const now = Date.parse(observedAt)
const cwd = '/repo'
const sample: LlmPerformanceHistoryRow = {
  providerId: 'antigravity', runId: 'run', model: '所选：gemini-4-neon', ts: observedAt, networkLabel: '', failed: false,
  performance: { state: 'complete', observedAt, networkLabel: '', streamCharacters: 2870, recentOutput: [], windowMs: 3000,
    streamDurationMs: 14270, firstOutputWaitMs: 156_664, outputTokens: 8411 }
}
const result: TraceEvent = { id: 'result', kind: 'harness', stage: 'result', runId: sample.runId, ts: endedAt,
  tokensOut: 8411, durationMs: now - Date.parse(startedAt), runtimeMetadata: { usageCoverage: 'available' } }
const terminal: TraceEvent = { id: 'terminal', kind: 'harness', stage: 'runtime:turn_wall', runId: sample.runId, ts: observedAt,
  llmPerformance: sample.performance }

const step = (index: number, at: string, type: string, fields = {}) => ({ step_index: index, created_at: at, type, ...fields })
const transcript = [
  step(9, '2026-11-22T06:13:00Z', 'USER_INPUT'),
  step(10, '2026-11-22T06:13:50Z', 'PLANNER_RESPONSE', { model: 'previous-model', output_tokens: 8411 }),
  step(11, '2026-11-22T06:15:18Z', 'USER_INPUT', { content: 'not needed for attribution' }),
  step(12, '2026-11-22T06:15:19Z', 'PLANNER_RESPONSE', { model: 'gemini-4-neon-high', output_tokens: 3110 }),
  step(13, '2026-11-22T06:15:24Z', 'RUN_COMMAND'),
  step(14, '2026-11-22T06:17:31Z', 'PLANNER_RESPONSE', { model: 'gemini-4-neon-high', output_tokens: 5301 }),
  step(15, '2026-11-22T06:20:00Z', 'USER_INPUT'),
  step(16, '2026-11-22T06:20:30Z', 'PLANNER_RESPONSE', { model: 'later-model', output_tokens: 8411 })
]

let userDataDir: string
let log: string
function writeTranscript(rows = transcript) {
  writeFileSync(log, rows.map(item => JSON.stringify(item)).join('\n') + '\n')
}

function archive(events = [result, terminal]) {
  expect(upsertTraceArchiveTurn({ userDataDir, cwd, sessionId, providerId: 'antigravity', turn: {
    runId: sample.runId, userText: 'test', done: true, status: 'completed', startedAt, completedAt: endedAt, items: events
  } })).toBe(true)
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'scry-agy-perf-'))
  const geminiRoot = join(userDataDir, 'gemini')
  vi.stubEnv('GEMINI_HOME', geminiRoot)
  vi.stubEnv('SCRY_PROVIDER_ENV_ALLOW', 'antigravity:GEMINI_HOME')
  log = join(geminiRoot, 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  mkdirSync(dirname(log), { recursive: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('Antigravity model attribution in performance history', () => {
  it('matches only the archived turn and keeps unavailable timing out of the comparison', async () => {
    writeTranscript()
    archive()
    await appendLlmPerformance(userDataDir, { cwd, externalSessionId: sessionId }, sample)
    const original = readFileSync(usageJsonlPath(userDataDir), 'utf8')
    const history = await readLlmPerformanceHistory(userDataDir, now)
    expect(history.rows).toEqual([{ ...sample, model: 'gemini-4-neon-high', modelSource: 'antigravity_transcript' }])
    expect(llmComparisonRounds(history.rows)).toMatchObject([{ model: 'gemini-4-neon-high', metrics: { firstOutput: 156.664 } }])
    expect(llmComparisonRounds(history.rows)[0].metrics).toEqual({ firstOutput: 156.664 })
    expect(readFileSync(usageJsonlPath(userDataDir), 'utf8')).toBe(original)
  })

  it('persists the verified model for new turns without relying on later access to the transcript', async () => {
    writeTranscript()
    const persist = createLlmPerformanceRecorder({
      userDataDir, catalogCwd: cwd, providerId: 'antigravity', runId: sample.runId, networkConfiguration: Promise.resolve(undefined),
      request: normalizeAgentStartRequest({ prompt: 'test', cwd }),
      runState: { runId: sample.runId, done: true, userText: 'test', items: [result, terminal] }
    })
    await persist(false, sessionId, startedAt)
    rmSync(log)
    expect((await readLlmPerformanceHistory(userDataDir, now)).rows).toMatchObject([
      { model: 'gemini-4-neon-high', modelSource: 'antigravity_transcript' }
    ])
  })

  it('does not attribute a partially recorded, ambiguous, or symlinked transcript', async () => {
    archive()
    await appendLlmPerformance(userDataDir, { cwd, externalSessionId: sessionId }, sample)
    writeTranscript(transcript.filter(row => row.step_index !== 14))
    expect((await readLlmPerformanceHistory(userDataDir, now)).rows).toEqual([sample])
    writeTranscript(transcript.map(row => row.step_index === 13 ? { ...row, type: 'USER_INPUT' } : row))
    expect((await readLlmPerformanceHistory(userDataDir, now + 1000)).rows).toEqual([sample])
    writeTranscript()
    const target = join(userDataDir, 'outside.log')
    writeFileSync(target, readFileSync(log))
    rmSync(log)
    symlinkSync(target, log)
    expect((await readLlmPerformanceHistory(userDataDir, now + 2000)).rows).toEqual([sample])
  })

  it('does not choose one model when the transcript verifies multiple models', async () => {
    archive()
    await appendLlmPerformance(userDataDir, { cwd, externalSessionId: sessionId }, sample)
    writeTranscript(transcript.map(row => row.step_index === 14 ? { ...row, model: 'other-model' } : row))
    expect((await readLlmPerformanceHistory(userDataDir, now)).rows).toMatchObject([{ model: '多模型' }])
  })
})
