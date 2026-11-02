import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from './aggregate'

describe('aggregateTurnEvidence', () => {
  it('preserves Steer admission evidence without rewriting the canonical root prompt or double counting usage', () => {
    const bytes = Buffer.from('image payload')
    const steer = { messageId: 'message-1', prompt: '补充要求', attachments: [{ kind: 'image' as const, name: 'screen.png', mimeType: 'image/png' as const, dataBase64: bytes.toString('base64') }] }
    const events: TraceEvent[] = [
      { id: 'pending', ts: '2026-10-11T00:00:00Z', runId: 'r', kind: 'human', stage: 'steer', steer: { ...steer, status: 'pending' } },
      { id: 'accepted', ts: '2026-10-11T00:00:01Z', runId: 'r', kind: 'human', stage: 'steer', steer: { ...steer, status: 'accepted', providerTurnId: 'native-turn' } },
      { id: 'usage', ts: '2026-10-11T00:00:02Z', runId: 'r', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 3 }
    ]
    const evidence = aggregateTurnEvidence({ userText: 'original prompt', events })
    expect(evidence.user.value).toEqual({
      text: 'original prompt', textHash: `sha256:${createHash('sha256').update('original prompt').digest('hex')}`,
      steers: [{ messageId: steer.messageId, prompt: steer.prompt, status: 'accepted', providerTurnId: 'native-turn', attachments: [{ name: 'screen.png', mimeType: 'image/png', size: bytes.byteLength, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] }]
    })
    expect(JSON.stringify(evidence.user)).not.toContain(steer.attachments[0].dataBase64)
    expect(evidence.usage.value).toMatchObject({ inputTokens: 10, outputTokens: 3 })
    expect(evidence.tools.value).toEqual([])
    expect(evidence.interventions?.value).toEqual([])
  })

  it('retains unknown delivery as unknown instead of treating it as an accepted supplementary message', () => {
    const evidence = aggregateTurnEvidence({ userText: 'root', events: [{
      id: 'unknown', ts: '2026-10-11T00:00:01Z', runId: 'r', kind: 'human', stage: 'steer',
      steer: { messageId: 'message-1', prompt: 'supplement', attachments: [], status: 'unknown', message: 'response unconfirmed' }
    }] })
    expect(evidence.user.value?.steers).toEqual([{ messageId: 'message-1', prompt: 'supplement', attachments: [], status: 'unknown', message: 'response unconfirmed' }])
  })

  it('preserves unavailable model timing when activity exceeds the turn wall clock', () => {
    const evidence = aggregateTurnEvidence({ events: [
      { id: 'call', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'tool', stage: 'tool_use', toolUseId: 'call', toolName: 'Read' },
      { id: 'result', ts: '2026-01-01T00:00:02.000Z', runId: 'r', kind: 'tool', stage: 'tool_result', toolUseId: 'call', durationMs: 2_000 },
      { id: 'wall', ts: '2026-01-01T00:00:02.000Z', runId: 'r', kind: 'harness', stage: 'turn_wall', durationMs: 1_000 }
    ] })
    expect(evidence.modelTiming).toEqual({
      status: 'unavailable', quality: 'unavailable', source: ['trace_events'],
      value: { method: 'non_call_residual', activityCoverage: { timedCalls: 1, totalCalls: 1 } },
      omissionReason: 'turn wall-clock is inconsistent with observed activity intervals'
    })
  })

  it('把 compact 事件保留为逐轮结构化证据', () => {
    const evidence = aggregateTurnEvidence({ events: [{
      id: 'compact-1',
      ts: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      kind: 'harness',
      stage: 'context_compaction',
      durationMs: 250,
      agentId: 'child-1',
      compaction: { trigger: 'auto', preTokens: 100, postTokens: 20 }
    }] })

    expect(evidence.compactions).toEqual({
      status: 'available',
      quality: 'exact',
      source: ['trace_events'],
      value: [{
        eventId: 'compact-1',
        at: '2026-01-01T00:00:00.000Z',
        trigger: 'auto',
        preTokens: 100,
        postTokens: 20,
        durationMs: 250,
        agentId: 'child-1'
      }]
    })
  })

  it('区分真实零调用与 Provider 不可观测', () => {
    const exact = aggregateTurnEvidence({ userText: 'hello', events: [], observable: { tools: true } })
    const unavailable = aggregateTurnEvidence({ userText: 'hello', events: [], observable: { tools: false } })
    expect(exact.tools).toEqual({ status: 'available', quality: 'exact', source: ['trace_events'], value: [] })
    expect(unavailable.tools).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
  })

  it('OpenCode 能观测工具但未支持危险分类时不伪造精确零值', () => {
    const evidence = aggregateTurnEvidence({
      events: [{
        id: 'opencode-result',
        ts: '2026-01-01T00:00:00.000Z',
        runId: 'run-opencode',
        kind: 'harness',
        stage: 'result',
        providerId: 'opencode',
        runtimeProvider: 'opencode_server'
      }]
    })

    expect(evidence.tools).toMatchObject({ status: 'available', value: [] })
    expect(evidence.dangerousOperations).toMatchObject({
      status: 'unavailable',
      quality: 'unavailable',
      omissionReason: 'danger classification is unsupported for this Provider'
    })
  })

  it('过滤 Recorder 自身 hook，并保留真实 hook', () => {
    const events: TraceEvent[] = [
      { id: '1', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookName: 'turn-recorder-v1', hookEvent: 'Stop', hookOutcome: 'success' },
      { id: '2', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookName: 'audit.py', hookEvent: 'Stop', hookOutcome: 'success' }
    ]
    expect(aggregateTurnEvidence({ events }).hooks.value).toEqual([
      expect.objectContaining({ name: 'audit.py', event: 'Stop', status: 'success' })
    ])
  })

  it('把同一 Hook 的 started/response 聚合为一个处理器实例', () => {
    const events: TraceEvent[] = [
      { id: 'start', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'hook', stage: 'hook_started', hookId: 'h1', hookName: 'audit.py', hookEvent: 'PreToolUse', hookOutcome: 'started' },
      { id: 'end', ts: '2026-01-01T00:00:00.025Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h1', hookName: 'audit.py', hookEvent: 'PreToolUse', hookOutcome: 'success', hookExitCode: 0 },
      { id: 'self', ts: '2026-01-01T00:00:00.030Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h2', hookName: 'command', hookEvent: 'PreToolUse', hookCommand: 'SCRY_HANDLER_ID=turn-recorder-v1 .claude/hooks/scry-recorder.sh claude PreToolUse', hookOutcome: 'success' }
    ]
    expect(aggregateTurnEvidence({ events }).hooks.value).toEqual([
      expect.objectContaining({
        order: 0,
        lifecycleEvents: 2,
        runs: 1,
        name: 'audit.py',
        event: 'PreToolUse',
        status: 'success',
        durationMs: 25
      })
    ])
  })

  it('只有 hook 投递证据时按事件名归并计数，标为 partial 且不伪造脚本身份或成功状态', () => {
    const delivery = (id: string, ts: string, hookEvent: string, agentId?: string): TraceEvent => ({
      id,
      ts,
      runId: 'r',
      kind: 'hook',
      stage: 'hook_delivery',
      name: hookEvent,
      hookId: `delivery:${hookEvent}:${agentId ?? ''}:${id}`,
      hookEvent,
      ...(agentId ? { agentId } : {})
    })
    const evidence = aggregateTurnEvidence({
      events: [
        delivery('d1', '2026-01-01T00:00:00.000Z', 'PreToolUse'),
        delivery('d2', '2026-01-01T00:00:01.000Z', 'PostToolUse'),
        delivery('d3', '2026-01-01T00:00:02.000Z', 'PreToolUse'),
        delivery('d4', '2026-01-01T00:00:03.000Z', 'PreToolUse', 'sub-1')
      ]
    })

    expect(evidence.hooks).toMatchObject({
      status: 'partial',
      quality: 'inferred',
      omissionReason: 'provider only delivered hook lifecycle events; per-hook command, outcome and exit code were not observable'
    })
    expect(evidence.hooks.value).toEqual([
      { order: 0, lifecycleEvents: 2, runs: 2, event: 'PreToolUse', startedAt: '2026-01-01T00:00:00.000Z', status: 'unknown' },
      { order: 1, lifecycleEvents: 1, runs: 1, event: 'PostToolUse', startedAt: '2026-01-01T00:00:01.000Z', status: 'unknown' },
      { order: 3, lifecycleEvents: 1, runs: 1, event: 'PreToolUse', startedAt: '2026-01-01T00:00:03.000Z', status: 'unknown' }
    ])
  })

  it('同一轮里既有真实 hook 运行又有投递事件时，整段按未观测运行数判 partial', () => {
    const events: TraceEvent[] = [
      { id: 'run', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h1', hookName: 'audit.py', hookEvent: 'Stop', hookOutcome: 'success', hookExitCode: 0 },
      { id: 'd1', ts: '2026-01-01T00:00:01.000Z', runId: 'r', kind: 'hook', stage: 'hook_delivery', name: 'Stop', hookEvent: 'Stop' }
    ]
    const evidence = aggregateTurnEvidence({ events })

    // 混合证据不能整段宣称 available/exact：数组里还有 status=unknown 的运行，
    // 否则下游会把派生的 failed=0 当成「Hook 全部成功」。分母写进 omissionReason。
    expect(evidence.hooks).toMatchObject({
      status: 'partial',
      quality: 'inferred',
      omissionReason: '1 of 2 hook runs have no observed outcome; ' +
        'a zero failure count over this section is not proof that every hook succeeded'
    })
    expect(evidence.hooks.value).toEqual([
      expect.objectContaining({ name: 'audit.py', status: 'success' }),
      expect.objectContaining({ event: 'Stop', status: 'unknown', lifecycleEvents: 1 })
    ])
  })

  it('全部 hook 运行都有观测结果时仍然是 available/exact', () => {
    const events: TraceEvent[] = [
      { id: 'run1', ts: '2026-01-01T00:00:00.000Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h1', hookName: 'audit.py', hookEvent: 'Stop', hookOutcome: 'success', hookExitCode: 0 },
      { id: 'run2', ts: '2026-01-01T00:00:01.000Z', runId: 'r', kind: 'hook', stage: 'hook_response', hookId: 'h2', hookName: 'flush.py', hookEvent: 'Stop', hookOutcome: 'failure', hookExitCode: 1 }
    ]
    const evidence = aggregateTurnEvidence({ events })

    expect(evidence.hooks).toMatchObject({ status: 'available', quality: 'exact' })
    expect(evidence.hooks.value).toHaveLength(2)
  })

  it('整轮 Usage 求和，并在原生聚合结果存在时忽略 transcript 影子值', () => {
    const transcript = (id: string, input: number): TraceEvent => ({
      id,
      ts: `2026-01-01T00:00:0${id}.000Z`,
      runId: 'r',
      kind: 'harness',
      stage: 'result',
      text: 'transcript assistant usage',
      tokensIn: input,
      tokensOut: 1
    })
    expect(aggregateTurnEvidence({ events: [transcript('1', 3), transcript('2', 4)] }).usage.value).toMatchObject({ inputTokens: 7, outputTokens: 2 })
    expect(aggregateTurnEvidence({ events: [
      transcript('1', 3),
      transcript('2', 4),
      {
        id: 'native',
        ts: '2026-01-01T00:00:03.000Z',
        runId: 'r',
        kind: 'harness',
        stage: 'result',
        tokensIn: 10,
        tokensOut: 5,
        durationApiMs: 123,
        contextTokens: 42,
        contextModel: 'fixture-model',
        contextProvider: 'fixture-provider',
        contextUsageSource: 'fixture_control',
        contextUsageQuality: 'inferred',
        modelUsage: [{
          model: 'fixture-model', upstreamProvider: 'fixture-provider', contextWindow: 100, inputTokens: 10, outputTokens: 5
        }]
      }
    ] }).usage.value).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      apiDurationMs: 123,
      contextTokens: 42,
      contextWindow: 100,
      contextModel: 'fixture-model',
      contextProvider: 'fixture-provider',
      contextUsageSource: 'fixture_control',
      contextUsageQuality: 'inferred',
      model: 'fixture-model'
    })
    const numeratorOnly = aggregateTurnEvidence({ events: [
      {
        id: 'numerator-only', ts: '2026-01-01T00:00:04.000Z', runId: 'r',
        kind: 'harness', stage: 'result', tokensIn: 2,
        contextTokens: 50, contextModel: 'unknown-window',
        contextUsageSource: 'provider_usage', contextUsageQuality: 'exact',
        modelUsage: [{ model: 'other-model', contextWindow: 100 }]
      }
    ] }).usage
    expect(numeratorOnly.value).toMatchObject({
      contextTokens: 50,
      contextModel: 'unknown-window',
      contextUsageSource: 'provider_usage',
      contextUsageQuality: 'exact'
    })
    expect(numeratorOnly.quality).toBe('exact')

    const legacy = aggregateTurnEvidence({ events: [{
      id: 'legacy', ts: '2026-01-01T00:00:05.000Z', runId: 'r',
      kind: 'harness', stage: 'result', contextTokens: 75,
      modelUsage: [{ model: 'legacy-model', contextWindow: 100 }]
    }] }).usage
    expect(legacy.quality).toBe('inferred')
    expect(legacy.value).toMatchObject({
      contextTokens: 75,
      contextWindow: 100,
      contextUsageSource: 'legacy_unattributed_context',
      contextUsageQuality: 'inferred'
    })
  })

  it('Claude SDK 多个 result 是累计快照，仅使用最终快照', () => {
    const result = (
      id: string,
      usage: Pick<TraceEvent, 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'cacheCreationTokens' | 'costUsd' | 'durationApiMs'>
    ): TraceEvent => ({
      id,
      ts: `2026-01-01T00:00:0${id}.000Z`,
      runId: 'r',
      kind: 'harness',
      stage: 'result',
      runtimeProvider: 'claude_sdk',
      ...usage
    })

    expect(aggregateTurnEvidence({
      events: [
        result('1', { tokensIn: 5, tokensOut: 10, cacheReadTokens: 100, cacheCreationTokens: 20, costUsd: 0.1, durationApiMs: 1_000 }),
        {
          id: 'shadow',
          ts: '2026-01-01T00:00:01.500Z',
          runId: 'r',
          kind: 'harness',
          stage: 'result',
          runtimeProvider: 'claude_sdk',
          text: 'transcript assistant usage',
          tokensIn: 999,
          tokensOut: 999
        },
        result('2', { tokensIn: 7, tokensOut: 15, cacheReadTokens: 180, cacheCreationTokens: 30, costUsd: 0.2, durationApiMs: 1_800 })
      ]
    }).usage.value).toMatchObject({
      inputTokens: 7,
      outputTokens: 15,
      cacheReadTokens: 180,
      cacheCreationTokens: 30,
      costUsd: 0.2,
      apiDurationMs: 1_800
    })
  })

  it('非 Claude provider 的多个 result 仍按整轮求和', () => {
    const events: TraceEvent[] = [
      {
        id: '1',
        ts: '2026-01-01T00:00:01.000Z',
        runId: 'r',
        kind: 'harness',
        stage: 'result',
        runtimeProvider: 'codex_cli',
        tokensIn: 5,
        tokensOut: 10,
        durationApiMs: 1_000
      },
      {
        id: '2',
        ts: '2026-01-01T00:00:02.000Z',
        runId: 'r',
        kind: 'harness',
        stage: 'result',
        runtimeProvider: 'codex_cli',
        tokensIn: 7,
        tokensOut: 15,
        durationApiMs: 1_800
      }
    ]

    expect(aggregateTurnEvidence({ events }).usage.value).toMatchObject({
      inputTokens: 12,
      outputTokens: 25,
      apiDurationMs: 2_800
    })
    expect(aggregateTurnEvidence({
      events: events.map((event) => ({ ...event, runtimeProvider: undefined }))
    }).usage.value).toMatchObject({
      inputTokens: 12,
      outputTokens: 25,
      apiDurationMs: 2_800
    })
  })

  it('把 costUsd 量化为 DECIMAL(20,8) 兼容值', () => {
    const originalCost = 5.858768000000001
    const event: TraceEvent = {
      id: '1',
      ts: '2026-01-01T00:00:01.000Z',
      runId: 'r',
      kind: 'harness',
      stage: 'result',
      runtimeProvider: 'claude_sdk',
      tokensIn: 1,
      costUsd: originalCost
    }
    expect(aggregateTurnEvidence({ events: [event] }).usage.value).toMatchObject({
      inputTokens: 1,
      costUsd: 5.858768
    })
    expect(event.costUsd).toBe(originalCost)

    expect(aggregateTurnEvidence({ events: [{ ...event, costUsd: 0.11662925 }] }).usage.value?.costUsd).toBe(0.11662925)
    expect(aggregateTurnEvidence({ events: [
      { ...event, id: '2', runtimeProvider: 'codex_cli', costUsd: 0.1 },
      { ...event, id: '3', runtimeProvider: 'codex_cli', costUsd: 0.2 }
    ] }).usage.value?.costUsd).toBe(0.3)
  })

  it('省略非法 costUsd 而不丢失其余 usage', () => {
    for (const costUsd of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000_000]) {
      expect(aggregateTurnEvidence({ events: [{
        id: '1',
        ts: '2026-01-01T00:00:01.000Z',
        runId: 'r',
        kind: 'harness',
        stage: 'result',
        tokensIn: 7,
        costUsd
      }] }).usage.value).toMatchObject({ inputTokens: 7, costUsd: undefined })
    }
  })

})
