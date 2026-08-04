import { describe, expect, it } from 'vitest'
import type { AgentTurnRecord, Evidence } from '../../shared/turn-record'
import type { TraceEvent } from '../../shared/trace'
import { logicalCallEventsForTurn } from '../../shared/logical-calls'
import {
  aggregateCalls as aggregateUiCalls,
  aggregateFiles as aggregateUiFiles,
  aggregateHooks as aggregateUiHooks,
  aggregateSegments as aggregateUiSegments
} from '../../renderer/format'
import { aggregateTurnEvidence } from './aggregate'
import { compactModelTiming, summarizeTurnRecords } from './turns-summary'

function emptyEvidence(): Evidence<never[]> {
  return { status: 'available', quality: 'exact', source: ['fixture'], value: [] }
}

function record(
  sequence: number,
  modelTiming?: AgentTurnRecord['modelTiming'],
  overrides: Partial<AgentTurnRecord> = {}
): AgentTurnRecord {
  return {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    sequence,
    recordId: `${sequence}`.padStart(32, '0'),
    recorderVersion: 'test',
    workspace: { id: 'fixture', root: '/repo' },
    provider: { id: 'codex' },
    sessionId: 'session-1',
    generation: sequence,
    turnIndex: sequence,
    startedAt: `2026-01-01T00:00:0${sequence}.000Z`,
    completedAt: `2026-01-01T00:00:0${sequence + 1}.000Z`,
    durationMs: 1_000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'x', textHash: 'hash' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'y', textHash: 'hash' } },
    tools: emptyEvidence(),
    skills: emptyEvidence(),
    mcps: emptyEvidence(),
    hooks: emptyEvidence(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    ...(modelTiming ? { modelTiming } : {}),
    files: emptyEvidence(),
    diff: emptyEvidence(),
    dangerousOperations: emptyEvidence(),
    errors: emptyEvidence(),
    ...overrides
  }
}

describe('turn CLI model timing summaries', () => {
  it('keeps old records readable without turning unknown timing into zero', () => {
    expect(compactModelTiming(record(1))).toEqual({
      status: 'unavailable',
      quality: 'unavailable',
      method: null,
      cumulativeMs: null,
      occupiedMs: null,
      timedCalls: null,
      totalCalls: null,
      source: []
    })
  })

  it('does not turn unavailable overview evidence into zero or an OK verdict', () => {
    const missing = <T>(): Evidence<T> => ({ status: 'unavailable', quality: 'unavailable', source: [], omissionReason: 'not observed' })
    const summary = summarizeTurnRecords([record(1, undefined, {
      tools: missing(),
      skills: missing(),
      mcps: missing(),
      hooks: missing(),
      usage: missing(),
      files: missing(),
      diff: missing(),
      dangerousOperations: missing(),
      errors: missing()
    })], 'session-1')

    expect(summary).toMatchObject({
      verdict: { state: 'unknown', toolErrors: null, dangerousOperations: null },
      calls: { total: null },
      hooks: { handlerInstances: null, lifecycleEvents: null },
      usage: { totalTokens: null, context: null },
      files: {
        uniquePaths: null,
        writeCoverage: { written: null, readBefore: null, inferredReadBefore: null, blind: null }
      },
      diff: { files: null, added: null, deleted: null },
      segments: { rows: null },
      errors: { total: null },
      dangerousOperations: { total: null }
    })
  })

  it('量化跨轮 costUsd 汇总，避免重新产生浮点尾差', () => {
    const usage = (costUsd: number): AgentTurnRecord['usage'] => ({
      status: 'available',
      quality: 'exact',
      source: ['fixture'],
      value: { costUsd }
    })
    const summary = summarizeTurnRecords([
      record(1, undefined, { usage: usage(0.1) }),
      record(2, undefined, { usage: usage(0.2) })
    ])
    expect(summary.usage.costUsd).toBe(0.3)
  })

  it('aggregates known model timing with explicit turn and call coverage', () => {
    const observed = {
      status: 'available',
      quality: 'estimated',
      source: ['scry_provider_adapter'],
      value: {
        method: 'response_intervals',
        cumulativeMs: 800,
        occupiedMs: 600,
        totalCalls: 2,
        timedCalls: 2,
        root: { totalCalls: 1, timedCalls: 1, cumulativeMs: 300 },
        subagents: { totalCalls: 1, timedCalls: 1, cumulativeMs: 500 }
      }
    } satisfies NonNullable<AgentTurnRecord['modelTiming']>
    const summary = summarizeTurnRecords([record(1, observed), record(2)])

    expect(summary.modelTiming).toMatchObject({
      cumulativeMs: 800,
      occupiedMs: 600,
      rootCumulativeMs: 300,
      subagentCumulativeMs: 500,
      knownTurns: 1,
      totalTurns: 2,
      complete: false,
      responseCallCoverage: { timedCalls: 2, totalCalls: 2, knownTurns: 1 },
      qualityCounts: { estimated: 1, unavailable: 1 },
      methodCounts: { response_intervals: 1 }
    })
  })

  it('uses the same public overview denominator as Scry', () => {
    const exact = <T>(value: T): Evidence<T> => ({ status: 'available', quality: 'exact', source: ['fixture'], value })
    const summary = summarizeTurnRecords([
      record(1, undefined, {
        tools: exact([
          {
            id: 'bash-1',
            category: 'tool',
            order: 1,
            name: 'Bash',
            status: 'success',
            startedAt: '2026-01-01T00:00:01.000Z',
            input: { command: "sed -n '1,20p' src/a.ts", cwd: '/repo' }
          },
          {
            id: 'agent-1',
            category: 'agent',
            order: 3,
            name: 'worker',
            status: 'success',
            input: { agentThreadId: 'thread-1', agentPath: '/root/worker' }
          },
          {
            id: 'edit-1',
            category: 'tool',
            order: 5,
            name: 'Edit',
            status: 'success',
            file: { operation: 'edit', path: '/repo/src/b.ts' }
          }
        ]),
        skills: exact([{ category: 'skill', order: 2, name: 'audit', status: 'success' }]),
        mcps: exact([{
          category: 'mcp',
          order: 4,
          name: 'lookup',
          status: 'success',
          mcp: { server: 'docs', action: 'tools/call', tool: 'lookup' }
        }]),
        hooks: exact([{
          order: 6,
          lifecycleEvents: 2,
          event: 'PostToolUse',
          name: 'PostToolUse:command',
          status: 'success'
        }]),
        usage: exact({
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 0,
          contextTokens: 50,
          contextWindow: 100,
          model: 'fixture-model'
        }),
        files: exact([{ path: '/repo/src/b.ts', operation: 'edit' }]),
        diff: exact([{
          status: 'captured',
          files: [{ path: '/repo/src/b.ts', added: 3, deleted: 1, patchStatus: 'captured' }],
          beforeAt: '2026-01-01T00:00:00.000Z',
          afterAt: '2026-01-01T00:00:01.000Z',
          captureMs: 1,
          cleanup: 'ok'
        }]),
        errors: exact([{ message: 'one failure', source: 'tool_result' }])
      })
    ], 'session-1')

    expect(summary.calls).toMatchObject({
      total: 5,
      ordinaryTools: { total: 2 },
      mcp: { total: 1 },
      skills: { total: 1 },
      subagents: { total: 1 },
      coverage: { complete: true, quality: 'exact' }
    })
    expect(summary.hooks).toMatchObject({ handlerInstances: 1, lifecycleEvents: 2 })
    expect(summary.usage).toMatchObject({
      totalTokens: 12,
      inputTokens: 10,
      outputTokens: 2,
      context: { used: 50, window: 100, pct: 50, remaining: 50, model: 'fixture-model' }
    })
    expect(summary.files).toMatchObject({
      uniquePaths: 2,
      structuredPaths: 1,
      inferredReadPaths: 1,
      inferredOnlyPaths: 1,
      writeCoverage: { written: 1, readBefore: 0, blind: ['/repo/src/b.ts'] }
    })
    expect(summary.segments.rows).toEqual([
      { skill: '（无 skill）', tools: 1, agents: 0, reads: 0, writes: 0, errors: 0 },
      { skill: 'audit', tools: 2, agents: 1, reads: 0, writes: 1, errors: 0 }
    ])
    expect(summary).toMatchObject({
      verdict: { state: 'warning', toolErrors: 1, dangerousOperations: 0 },
      diff: { files: 1, added: 3, deleted: 1 }
    })
  })

  it('stays numerically aligned with the renderer overview oracle', () => {
    const events: TraceEvent[] = [
      {
        id: 'bash',
        ts: '2026-01-01T00:00:00.000Z',
        runId: 'run-1',
        kind: 'tool',
        stage: 'tool:Bash',
        tool: 'Bash',
        name: 'Bash',
        toolUseId: 'bash-1',
        input: { command: "sed -n '1,20p' src/a.ts", cwd: '/repo' }
      },
      { id: 'bash-result', ts: '2026-01-01T00:00:00.010Z', runId: 'run-1', kind: 'tool', stage: 'tool_result', toolUseId: 'bash-1' },
      { id: 'skill', ts: '2026-01-01T00:00:00.020Z', runId: 'run-1', kind: 'skill', stage: 'skill:audit', name: 'audit' },
      { id: 'agent', ts: '2026-01-01T00:00:00.030Z', runId: 'run-1', kind: 'agent', stage: 'agent:worker', name: 'worker', toolUseId: 'agent-1' },
      { id: 'agent-result', ts: '2026-01-01T00:00:00.040Z', runId: 'run-1', kind: 'tool', stage: 'tool_result', toolUseId: 'agent-1' },
      {
        id: 'mcp',
        ts: '2026-01-01T00:00:00.050Z',
        runId: 'run-1',
        kind: 'tool',
        stage: 'tool:mcp',
        tool: 'mcp',
        name: 'lookup',
        toolUseId: 'mcp-1',
        isMcp: true,
        mcpServer: 'docs',
        mcpAction: 'lookup',
        mcpTool: 'lookup'
      },
      { id: 'mcp-result', ts: '2026-01-01T00:00:00.060Z', runId: 'run-1', kind: 'tool', stage: 'tool_result', toolUseId: 'mcp-1' },
      {
        id: 'edit',
        ts: '2026-01-01T00:00:00.070Z',
        runId: 'run-1',
        kind: 'tool',
        stage: 'tool:Edit',
        tool: 'Edit',
        name: 'Edit',
        toolUseId: 'edit-1',
        fileOp: 'edit',
        filePath: '/repo/src/b.ts'
      },
      { id: 'edit-result', ts: '2026-01-01T00:00:00.080Z', runId: 'run-1', kind: 'tool', stage: 'tool_result', toolUseId: 'edit-1' },
      { id: 'hook-start', ts: '2026-01-01T00:00:00.090Z', runId: 'run-1', kind: 'hook', stage: 'hook_started', hookId: 'hook-1', hookEvent: 'PostToolUse', hookName: 'command', hookOutcome: 'started' },
      { id: 'hook-end', ts: '2026-01-01T00:00:00.100Z', runId: 'run-1', kind: 'hook', stage: 'hook_response', hookId: 'hook-1', hookEvent: 'PostToolUse', hookName: 'command', hookOutcome: 'success' }
    ]
    const evidence = aggregateTurnEvidence({ events })
    const summary = summarizeTurnRecords([record(1, undefined, evidence)], 'session-1')
    const logical = logicalCallEventsForTurn(events)
    const uiCalls = aggregateUiCalls(logical)
    const uiHooks = aggregateUiHooks(events)
    const uiFiles = aggregateUiFiles(events).structured
    const uiSegments = aggregateUiSegments(logical)

    expect(summary.calls).toMatchObject({
      total: uiCalls.totalCalls,
      ordinaryTools: { total: uiCalls.ordinaryToolTotal },
      mcp: { total: uiCalls.mcpTotal },
      skills: { total: uiCalls.skillTotal },
      subagents: { total: uiCalls.agentTotal }
    })
    expect(summary.hooks).toMatchObject({
      handlerInstances: uiHooks.logicalRuns,
      lifecycleEvents: uiHooks.rawEvents
    })
    expect(summary.files.rows).toEqual(expect.arrayContaining(uiFiles.map((row) => expect.objectContaining(row))))
    expect(summary.segments.rows).toEqual(uiSegments)
  })
})
