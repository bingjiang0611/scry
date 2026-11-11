import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter
} from './qoder'

const { sdk } = t

describe('Qoder provider adapter · usage and context evidence', () => {
  beforeEach(() => resetQoderTestState(t))

  it('deduplicates streamed text and treats impossible all-zero usage as unknown', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } } }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }
        yield { type: 'result', subtype: 'success', result: 'OK', usage: { input_tokens: 0, output_tokens: 0 } }
      },
      close,
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-1',
      prompt: 'only OK',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise
    expect(result.stopped).toBe(false)
    expect(events.filter((event) => event.kind === 'model').map((event) => event.text)).toEqual(['O', 'K'])
    expect(events.find((event) => event.kind === 'harness')).toMatchObject({
      stage: 'result',
      tokensIn: undefined,
      tokensOut: undefined,
      costUsd: undefined,
      runtimeMetadata: expect.objectContaining({ reportedZeroUsage: true })
    })
    expect(sdk.runtimeCliEnv).toHaveBeenCalledWith(undefined, { providerId: 'qoder' })
    expect(sdk.startDaemon.mock.calls[0][0].env).toMatchObject({
      QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
    })
  })

  it('emits one independent credit snapshot per run/resume, ignoring cumulative result amounts', async () => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { id: 'm1', content: [], usage: { request_id: 'r1', credits: 2, original_credits: 10, billable: true } } }
        yield { type: 'assistant', message: { id: 'm1', content: [], usage: { request_id: 'r1', credits: 2, billable: true } } }
        yield { type: 'result', subtype: 'success', total_credits: 1000, total_cost_usd: 999, usage: { input_tokens: 4, output_tokens: 1 } }
      },
      close: vi.fn().mockResolvedValue(undefined), interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    for (const resume of [undefined, 'session']) {
      const events: TraceEvent[] = []
      await createQoderAdapter().run({ runId: resume ?? 'new', resume, prompt: 'work', attachments: [], emit: (event) => events.push(event) }).promise
      expect(events.filter((event) => event.stage === 'credit_usage')).toMatchObject([{ creditUsage: {
        status: 'partial', source: ['qoder_sdk'], value: { amount: 2, unit: 'credits', knownRequests: 1 }
      } }])
      expect(events.find((event) => event.stage === 'result')?.costUsd).toBeUndefined()
    }
  })

  it('retains observed credits even when the provider stream fails before a result', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { id: 'm1', content: [], usage: { request_id: 'r1', credits: 3, billable: true } } }
        throw new Error('stream failed')
      },
      close: vi.fn().mockResolvedValue(undefined), interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []
    await createQoderAdapter().run({ runId: 'failed', prompt: 'work', attachments: [], emit: (event) => events.push(event) }).promise.catch(() => {})
    expect(events.find((event) => event.stage === 'credit_usage')?.creditUsage?.value?.amount).toBe(3)
  })

  it('uses Qoder control context usage instead of the zero SDK model window', async () => {
    const getContextUsage = vi.fn().mockResolvedValue({
      totalTokens: 103_176,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 10.3176,
      model: 'ultimate'
    })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 31_803, output_tokens: 301 },
          modelUsage: {
            ultimate: { inputTokens: 103_176, outputTokens: 301, contextWindow: 0 }
          }
        }
      },
      getContextUsage,
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    await createQoderAdapter().run({
      runId: 'run-context', prompt: 'work', attachments: [], emit: (event) => events.push(event)
    }).promise

    expect(getContextUsage).toHaveBeenCalledOnce()
    expect(events.find((event) => event.kind === 'harness')).toMatchObject({
      contextTokens: 103_176,
      contextModel: 'ultimate',
      contextUsageSource: 'qoder_control',
      contextUsageQuality: 'exact',
      modelUsage: [expect.objectContaining({ model: 'ultimate', contextWindow: 1_000_000 })],
      runtimeMetadata: expect.objectContaining({
        contextUsagePercentage: 10.3176,
        rawContextWindow: 1_000_000
      })
    })
  })

  it('uses Qoder input_tokens without double-counting cache when control context is unavailable', async () => {
    const getContextUsage = vi.fn().mockRejectedValue(new Error('control unavailable'))
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 103_176,
            cache_read_input_tokens: 103_046,
            output_tokens: 301
          },
          modelUsage: {
            ultimate: {
              inputTokens: 103_176,
              cacheReadInputTokens: 103_046,
              outputTokens: 301,
              contextWindow: 0
            }
          }
        }
      },
      getContextUsage,
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    await createQoderAdapter().run({
      runId: 'run-context-fallback', prompt: 'work', attachments: [], emit: (event) => events.push(event)
    }).promise

    expect(getContextUsage).toHaveBeenCalledOnce()
    expect(events.find((event) => event.kind === 'harness')).toMatchObject({
      contextTokens: 103_176,
      contextModel: 'ultimate',
      contextProvider: 'qoder',
      contextUsageSource: 'qoder_sdk_usage',
      contextUsageQuality: 'exact',
      modelUsage: [expect.objectContaining({ model: 'ultimate', contextWindow: 0 })]
    })
  })

  it('enriches archived Qoder context from native usage ratio as inferred window evidence', async () => {
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
      message: {
        model: 'ultimate',
        usage: { input_tokens: 103_176, cache_read_input_tokens: 103_046, context_usage_ratio: 0.103176 }
      }
    }])
    const adapter = createQoderAdapter()
    const turns = await adapter.sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [{
        userText: 'work',
        items: [{
          id: 'result-1', runId: 'run-history', ts: '2026-09-03T03:00:12.000Z',
          kind: 'harness', stage: 'result', contextTokens: 31_803,
          modelUsage: [{ model: 'ultimate', contextWindow: 0 }]
        }]
      }]
    )

    expect(turns[0].items[0]).toMatchObject({
      contextTokens: 103_176,
      contextModel: 'ultimate',
      contextUsageSource: 'qoder_native_transcript',
      contextUsageQuality: 'inferred',
      modelUsage: [{ model: 'ultimate', contextWindow: 1_000_000 }],
      runtimeMetadata: expect.objectContaining({
        contextUsagePercentage: 10.3176
      })
    })
  })

  it('pairs adjacent archived turns with disjoint native usage intervals', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      {
        type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
        message: { model: 'ultimate', usage: { input_tokens: 100_000, context_usage_ratio: 0.1 } }
      },
      {
        type: 'assistant', timestamp: '2026-09-03T03:00:20.000Z',
        message: { model: 'ultimate', usage: { input_tokens: 200_000, context_usage_ratio: 0.2 } }
      }
    ])
    const result = (id: string, ts: string): TraceEvent => ({
      id, runId: id, ts, kind: 'harness', stage: 'result', modelUsage: [{ model: 'ultimate', contextWindow: 0 }]
    })

    const turns = await createQoderAdapter().sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [
        { userText: 'one', items: [result('one', '2026-09-03T03:00:12.000Z')] },
        { userText: 'two', items: [result('two', '2026-09-03T03:00:22.000Z')] }
      ]
    )

    expect(turns.map((turn) => turn.items[0].contextTokens)).toEqual([100_000, 200_000])
  })

  it('keeps complete archived context and does not attach evidence to a different model', async () => {
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
      message: { model: 'ultimate', usage: { input_tokens: 100_000, context_usage_ratio: 0.1 } }
    }])
    const adapter = createQoderAdapter()
    const turns = await adapter.sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [{
        userText: 'work',
        items: [
          {
            id: 'exact', runId: 'run-history', ts: '2026-09-03T03:00:11.000Z', kind: 'harness', stage: 'result',
            contextTokens: 50_000, contextUsageQuality: 'exact', modelUsage: [{ model: 'performance', contextWindow: 200_000 }]
          },
          {
            id: 'mismatch', runId: 'run-history', ts: '2026-09-03T03:00:12.000Z', kind: 'harness', stage: 'result',
            modelUsage: [{ model: 'performance', contextWindow: 0 }]
          }
        ]
      }]
    )

    expect(turns[0].items[0]).toMatchObject({
      contextTokens: 50_000,
      contextUsageQuality: 'exact',
      modelUsage: [{ model: 'performance', contextWindow: 200_000 }]
    })
    expect(turns[0].items[1]).toMatchObject({
      contextTokens: 100_000,
      modelUsage: [
        { model: 'performance', contextWindow: 0 },
        { model: 'ultimate', contextWindow: 1_000_000 }
      ]
    })
  })

  it('does not attach model-less Qoder context evidence to the first row of a multi-model result', async () => {
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
      message: { usage: { input_tokens: 100_000, context_usage_ratio: 0.1 } }
    }])
    const turns = await createQoderAdapter().sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [{
        userText: 'work',
        items: [{
          id: 'multi', runId: 'run-history', ts: '2026-09-03T03:00:12.000Z',
          kind: 'harness', stage: 'result',
          modelUsage: [{ model: 'performance' }, { model: 'ultimate' }]
        }]
      }]
    )

    expect(turns[0].items[0]).toMatchObject({
      contextTokens: 100_000,
      contextModel: undefined,
      contextUsageQuality: 'inferred',
      modelUsage: [{ model: 'performance' }, { model: 'ultimate' }]
    })
  })
})
