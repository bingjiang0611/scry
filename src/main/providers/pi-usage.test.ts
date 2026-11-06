import { describe, expect, it, vi } from 'vitest'
import { billingRowsFromItems } from '../billing-ledger'
import { createPiAdapter } from './pi'
import { USAGE_LEDGER_COLS } from '../span-ledger'
import { withFixture } from './pi-test-fixture'
import type { TraceEvent } from '../../shared/trace'

describe('Pi RPC Provider', () => {
  it('persists Pi Qoder token usage in the billing ledger without treating its USD placeholder as free', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await adapter.run({
        runId: 'pi-qoder-billing', prompt: 'qoder-billing', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: event => events.push(event)
      }).promise
      const terminal = events.find(event => event.stage === 'result')!
      const rows = billingRowsFromItems({
        runId: 'pi-qoder-billing', items: events, nowMs: Date.now(),
        billingProvider: terminal.billingProvider, runtimeProvider: 'pi_rpc'
      }).usageLedger
      expect(rows).toHaveLength(1)
      const row = Object.fromEntries(USAGE_LEDGER_COLS.map((column, index) => [column, rows[0][index]]))
      expect(row).toMatchObject({
        provider: 'qoder', source: 'pi_rpc', model: 'ultimate',
        input_tokens: 10937, output_tokens: 27, reasoning_tokens: 19, cost: null
      })
      expect(terminal.billingProvider).toBe('qoder')
      expect(terminal.costUsd).toBeUndefined()
      expect(terminal.modelUsage?.[0]).toMatchObject({ billingProvider: 'qoder', upstreamProvider: 'qoder' })
      expect(terminal.modelUsage?.[0].costUsd).toBeUndefined()
    })
  })

  it('retains every upstream in a mixed run, including Claude retries with unpriced catalogue cost', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await adapter.run({ runId: 'mixed', prompt: 'mixed-billing', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: event => events.push(event) }).promise
      const terminal = events.find(event => event.stage === 'result')!
      const rows = billingRowsFromItems({ runId: 'mixed', items: events, nowMs: Date.now(), runtimeProvider: 'pi_rpc',
        billingProvider: terminal.billingProvider }).usageLedger.map(row =>
        Object.fromEntries(USAGE_LEDGER_COLS.map((column, index) => [column, row[index]])))
      expect(rows).toMatchObject([
        { provider: 'cc-switch', model: 'claude-opus-5', input_tokens: 10, output_tokens: 2, cost: null },
        { provider: 'qoder', model: 'ultimate', input_tokens: 20, output_tokens: 3, cost: null },
        { provider: 'custom-vendor', model: 'private-model', input_tokens: 30, output_tokens: 4,
          cost: 0.25, cost_source: 'price_table', confidence: 'estimated' }
      ])
      expect(terminal.costUsd).toBeUndefined()
      expect(rows.reduce((sum, row) => sum + Number(row.input_tokens), 0)).toBe(60)
    })
  })

  it('preserves already observed usage once if the transport exits before settlement', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({ runId: 'crash', prompt: 'mixed-billing-crash', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: event => events.push(event) }).promise).rejects.toThrow()
      const results = events.filter(event => event.stage === 'result')
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ tokensIn: 60, tokensOut: 9, isError: true, runtimeMetadata: { usageCoverage: 'partial' } })
      expect(billingRowsFromItems({ runId: 'crash', items: events, nowMs: 1, runtimeProvider: 'pi_rpc' }).usageLedger).toHaveLength(3)
    })
  })

  it('records the authoritative native session and root entry with model/effort controls', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const onSession = vi.fn()
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-1',
        prompt: 'hello',
        cwd,
        agentProfileId: profile.id,
        attachments: [],
        model: { providerId: 'test-provider', id: 'test-model' },
        effort: 'high',
        permissionMode: 'full_access',
        emit: (event) => events.push(event),
        onExternalSessionId: onSession
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', stopped: false, status: 'completed'
      })
      expect(handle.getProviderTurnId?.()).toBe('pi-user-1')
      expect(onSession).toHaveBeenCalledWith('pi-session-1')
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'model', stage: 'thinking', thinking: 'think', messageId: expect.any(String) }),
        expect.objectContaining({ kind: 'model', stage: 'text_delta', text: 'hello\u2028world', messageId: expect.any(String) }),
        expect.objectContaining({
          kind: 'tool', tool: 'read', toolUseId: 'tool-read', fileOp: 'read', filePath: 'README.md'
        }),
        expect.objectContaining({ kind: 'agent', tool: 'Agent', toolUseId: 'tool-1' }),
        expect.objectContaining({
          kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 4, costUsd: 0.01,
          contextTokens: 13, contextModel: 'test-model', contextProvider: 'openai-codex',
          contextUsageSource: 'pi_rpc_assistant_usage', contextUsageQuality: 'exact',
          billingProvider: 'codex', upstreamProvider: 'openai-codex',
          modelUsage: [expect.objectContaining({
            billingProvider: 'codex', upstreamProvider: 'openai-codex', contextWindow: 200000
          })]
        })
      ]))
      const streamedModelEvents = events.filter((event) =>
        event.kind === 'model' && (event.stage === 'thinking' || event.stage === 'text_delta')
      )
      expect(streamedModelEvents.filter((event) => event.stage === 'thinking').map((event) => event.thinking))
        .toEqual(['think', 'ing'])
      const messageIds = [...new Set(streamedModelEvents.map((event) => event.messageId))]
      expect(messageIds).toHaveLength(1)
      expect(messageIds[0]).toMatch(/^pi:run-1:assistant-\d+$/)
    })
  }, 15_000)

  it('times completed main calls from request creation and excludes errored, aborted or empty calls', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const events: TraceEvent[] = []
      const result = await adapter.run({
        runId: 'call-timing', prompt: 'call-timing', cwd, agentProfileId: profile.id, attachments: [],
        permissionMode: 'full_access', emit: (event) => events.push(event)
      }).promise
      expect(result.status).toBe('completed')
      const calls = events.filter((event) => event.stage === 'runtime:llm_stream_end').map((event) => event.llmCall)
      expect(calls.map((call) => call?.outputTokens)).toEqual([120, undefined, undefined, undefined, 80])
      expect(calls[0]).toMatchObject({ model: 'ultimate', durationMs: expect.any(Number) })
      // Local receipt time minus the request stamp; process latency may add a little, never subtract.
      expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(3000)
      expect(calls[0]!.durationMs).toBeLessThan(13_000)
      expect(calls[4]!.durationMs).toBeGreaterThanOrEqual(2000)
      // First content block received after the request stamp and no later than message_end.
      expect(calls[0]!.firstTokenMs).toBeGreaterThanOrEqual(3000)
      expect(calls[0]!.firstTokenMs).toBeLessThanOrEqual(calls[0]!.durationMs)
      expect(calls[4]).not.toHaveProperty('firstTokenMs')
    })
  }, 15_000)

  it.each(['openai', 'openai-codex'])('includes Pi-normalized cached context across resumed turns for %s', async (provider) => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const firstEvents: TraceEvent[] = []
      const first = await adapter.run({
        runId: 'context-first', prompt: `cached-context:${provider}:first`, cwd,
        agentProfileId: profile.id, attachments: [], permissionMode: 'full_access',
        emit: (event) => firstEvents.push(event)
      }).promise
      expect(first.status).toBe('completed')
      expect(firstEvents.find((event) => event.stage === 'result')?.contextTokens).toBe(9100)
      const nextEvents: TraceEvent[] = []
      const next = await adapter.run({
        runId: 'context-second', prompt: `cached-context:${provider}:second`, cwd, resume: first.externalSessionId,
        agentProfileId: profile.id, attachments: [], permissionMode: 'full_access',
        emit: (event) => nextEvents.push(event)
      }).promise
      expect(next.status).toBe('completed')
      expect(nextEvents.filter((event) => event.stage === 'context_usage').map((event) => event.contextTokens))
        .toEqual([101198, 109100, 110000])
      expect(nextEvents.find((event) => event.stage === 'result')).toMatchObject({
        contextTokens: 110000, contextModel: 'test-model', contextProvider: provider,
        contextUsageSource: 'pi_rpc_assistant_usage', contextUsageQuality: 'exact'
      })
    })
  }, 15_000)

  it.each(['success', 'idle', 'aborted', 'missing', 'error'])(
    'publishes request context before settlement and only counts completed compactions: %s', async (scenario) => {
      await withFixture(async (profile, cwd) => {
        const events: TraceEvent[] = []
        const samplesBeforeResult: TraceEvent[] = []
        const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
        const handle = adapter.run({
          runId: 'run-context', prompt: `context-telemetry:${scenario}`, cwd, agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: (event) => {
            if (event.stage === 'context_usage' && !events.some((item) => item.stage === 'result')) {
              samplesBeforeResult.push(event)
            }
            events.push(event)
          }
        })
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
        expect(samplesBeforeResult.map((event) => event.contextTokens)).toEqual(scenario === 'success' ? [50003, 8003] : [50003])
        expect(samplesBeforeResult[0]).toMatchObject({
          contextModel: 'test-model', contextProvider: 'openai-codex',
          contextUsageSource: 'pi_rpc_assistant_usage', contextUsageQuality: 'exact',
          modelUsage: [{ model: 'test-model', upstreamProvider: 'openai-codex', contextWindow: 200000 }]
        })
        expect(samplesBeforeResult[0].tokensIn).toBeUndefined()
        expect(samplesBeforeResult[0].modelUsage?.[0].inputTokens).toBeUndefined()
        const completed = scenario === 'success' || scenario === 'idle'
        const compactions = events.filter((event) => event.stage === 'context_compaction')
        expect(compactions).toHaveLength(completed ? 1 : 0)
        if (completed) expect(compactions[0].compaction).toEqual({ trigger: 'auto', preTokens: 50000 })
        const result = events.find((event) => event.stage === 'result')!
        expect(result.contextTokens).toBe(scenario === 'success' ? 8003 : scenario === 'idle' ? undefined : 50003)
        expect(result.tokensIn).toBe(scenario === 'success' ? 58000 : 50000)
      })
    }, 15_000
  )

})
