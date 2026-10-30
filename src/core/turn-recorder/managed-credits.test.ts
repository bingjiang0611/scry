import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { creditUsageEvidence } from '../../shared/credit-usage'
import { aggregateTurnEvidence } from './aggregate'
import { commitManagedRecorderTurn, prepareManagedRecorderTurn } from './managed'
import { handleRecorderHook } from './recorder'
import { listRecords, stableHash } from './store'

// Pi drives Qoder models through Rotom, so the agent identity and the billing
// identity differ. Keep this cross-provider commit contract separate from the
// oversized managed recorder suite.

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const timing = {
  startedAt: '2026-07-29T12:00:00.000Z',
  completedAt: '2026-07-29T12:00:10.000Z',
  durationMs: 10_000
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-managed-credits-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'managed-credits-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return root
}

describe('managed recorder provider identity across billing providers', () => {
  it('Pi 轮次携带 Qoder Credits 时仍可提交 canonical record', async () => {
    const root = await workspace()
    const runId = 'run-pi-credits'
    const prompt = '排查这个问题'
    const events: TraceEvent[] = [
      { id: 'assistant', ts: '2026-07-29T12:00:05.000Z', runId, kind: 'model', stage: 'text_delta', text: '完成' },
      {
        id: 'result', ts: '2026-07-29T12:00:10.000Z', runId, kind: 'harness', stage: 'result', durationMs: 10_000,
        tokensIn: 100, tokensOut: 20, upstreamProvider: 'qoder',
        modelUsage: [{ model: 'dfmodel', inputTokens: 100, outputTokens: 20, upstreamProvider: 'qoder' }]
      },
      {
        id: 'credits', ts: '2026-07-29T12:00:10.100Z', runId, kind: 'harness', stage: 'credit_usage',
        creditUsage: creditUsageEvidence([{ id: 'request-1', runId, credits: 5.3 }], 'pi_qoder_credit_observation')
      }
    ]
    const evidence = aggregateTurnEvidence({ userText: prompt, events, source: 'scry_provider_adapter' })
    expect(evidence.usage.value?.credits?.value).toMatchObject({ provider: 'qoder', amount: 5.3 })
    const archiveFingerprint = stableHash({ runId, evidence, timing })
    await handleRecorderHook({
      provider: 'pi',
      event: 'UserPromptSubmit',
      workspace: root,
      managed: true,
      payload: { session_id: 'pi-session-credits', prompt, timestamp: timing.startedAt },
      env: {
        ...process.env,
        SCRY_MANAGED_RUN_ID: runId,
        SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex')
      }
    })

    const prepared = await prepareManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session-credits',
      runId,
      providerTurnId: 'pi-user-entry-credits',
      userText: prompt,
      evidence,
      timing,
      status: 'completed',
      archiveFingerprint
    })
    expect(prepared).toMatchObject({ status: 'prepared' })
    if (prepared.status !== 'prepared') return

    await expect(commitManagedRecorderTurn({
      workspace: root,
      provider: 'pi',
      sessionId: 'pi-session-credits',
      runId,
      recordId: prepared.recordId,
      archiveFingerprint,
      providerTurnId: 'pi-user-entry-credits',
      userText: prompt,
      evidence,
      timing,
      status: 'completed'
    })).resolves.toMatchObject({ status: 'committed' })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ id: 'pi' }),
        usage: expect.objectContaining({
          value: expect.objectContaining({
            credits: expect.objectContaining({ value: expect.objectContaining({ amount: 5.3 }) })
          })
        })
      })
    ])
  })
})
