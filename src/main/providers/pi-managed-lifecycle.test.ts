import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { commitManagedRecorderTurn, prepareManagedRecorderTurn, recoverManagedRecorderTurns } from '../../core/turn-recorder/managed'
import { createPiAdapter } from './pi'
import { historicalInputPrefix } from './historical-input'
import { listRecords, stableHash } from '../../core/turn-recorder/store'
import { withFixture, withCommandFixture } from './pi-test-fixture'
import type { TraceEvent } from '../../shared/trace'

describe('Pi RPC Provider', () => {
  it('opens a managed Pi lifecycle before prompting and returns its authoritative entry id', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        workspaceId: 'pi-managed-fixture',
        dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      const prompt = '/skill:rate-workflow 85781174'
      const runId = 'run-managed-pi'
      const events: TraceEvent[] = []
      const startedAtMs = Date.now()
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId, prompt, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', managedRecorder: true,
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(prompt).digest('hex')
        },
        emit: (event) => events.push(event)
      })

      const result = await handle.promise
      expect(result).toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', status: 'completed'
      })
      const completedAtMs = Date.now()
      const evidence = aggregateTurnEvidence({ userText: prompt, events, source: 'scry_provider_adapter' })
      const timing = {
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs
      }
      const archiveFingerprint = stableHash({ runId, evidence, timing })
      const prepared = await prepareManagedRecorderTurn({
        workspace: cwd,
        provider: 'pi',
        sessionId: result.externalSessionId!,
        providerTurnId: result.providerTurnId,
        runId,
        userText: prompt,
        evidence,
        timing,
        status: 'completed',
        archiveFingerprint
      })
      expect(prepared).toMatchObject({ status: 'prepared' })
      if (prepared.status !== 'prepared') throw new Error(`unexpected prepare status: ${prepared.status}`)
      await expect(commitManagedRecorderTurn({
        workspace: cwd,
        provider: 'pi',
        sessionId: result.externalSessionId!,
        providerTurnId: result.providerTurnId,
        runId,
        recordId: prepared.recordId,
        userText: prompt,
        evidence,
        timing,
        status: 'completed',
        archiveFingerprint
      })).resolves.toMatchObject({ status: 'committed' })
      await expect(listRecords(join(cwd, '.scry'))).resolves.toEqual([
        expect.objectContaining({
          providerTurnId: 'pi-user-1',
          skills: expect.objectContaining({
            value: [expect.objectContaining({ name: 'rate-workflow', category: 'skill' })]
          })
        })
      ])
      await expect(recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' }))
        .resolves.toEqual({ recovered: 0, pending: 0 })
    })
  }, 15_000)

  it.each([false, true])('gates a scoped Pi history extension before prompt and never pools its authority (ready=%s)', async ready => {
    await withCommandFixture(async (profile, cwd) => {
      const { createConversationHistoryReader } = await import('../conversation-history-reader')
      const text = 'prior'
      const reader = await createConversationHistoryReader([{ ref: { runId: 'prior', itemId: 'user', contentHash: createHash('sha256').update(text).digest('hex') }, text }])
      const extension = realpathSync(join(process.cwd(), 'resources/scry-history/pi-history-reader.mjs'))
      if (ready) writeFileSync(join(cwd, 'history-ready'), '')
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile, historyExtensionPath: extension })
      try {
        for (let index = 0; index < (ready ? 2 : 1); index++) {
          const handle = adapter.run({ runId: `reader-${index}`, prompt: 'continue', cwd, agentProfileId: profile.id, resume: 'pi-session-1',
            historicalContext: { text, contentHash: createHash('sha256').update(text).digest('hex'), requiresReader: true },
            historyReader: reader.connection, historyBudget: {}, attachments: [], permissionMode: 'full_access', emit: vi.fn() })
          if (ready) {
            await handle.promise
            expect(handle.getInputReceipt?.()?.status).toBe('accepted')
          } else {
            await expect(handle.promise).rejects.toThrow('未注册本轮历史检索检查命令')
            expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
          }
        }
        const commands = readFileSync(join(cwd, 'fixture-commands'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(commands.filter(command => command.type === 'prompt' && !command.message.startsWith('/scry_history_ready_'))).toHaveLength(ready ? 2 : 0)
        expect(commands.filter(command => command.type === 'prompt' && command.message.startsWith('/scry_history_ready_'))).toHaveLength(ready ? 2 : 0)
        const launch = JSON.parse(readFileSync(join(cwd, 'history-launch.json'), 'utf8'))
        expect(launch.args.slice(-2)).toEqual(['--extension', extension])
        expect(launch.snapshotId).toBe(reader.connection.snapshotId)
        const pids = readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n').map(Number)
        expect(pids).toHaveLength(ready ? 2 : 1)
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
      } finally { await adapter.dispose?.(); await reader.close() }
    })
  }, 15_000)

  it.each(['changed-asset', 'small-window', 'model-select'])('rejects Pi reader admission for %s before native prompt', async failure => {
    await withCommandFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'history-ready'), '')
      if (failure === 'small-window') writeFileSync(join(cwd, 'small-window'), '')
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile,
        historyExtensionPath: failure === 'changed-asset' ? profile.executable : realpathSync(join(process.cwd(), 'resources/scry-history/pi-history-reader.mjs')) })
      try {
        const text = 'prior'
        const handle = adapter.run({ runId: 'reader-rejected', prompt: 'continue', cwd, agentProfileId: profile.id,
          historicalContext: { text, contentHash: createHash('sha256').update(text).digest('hex'), requiresReader: true },
          historyReader: { url: 'http://127.0.0.1:1/mcp', token: 'fixture', snapshotId: 'fixture' }, historyBudget: {},
          ...(failure === 'model-select' ? { model: { providerId: 'test-provider', id: 'changed-model' } } : {}),
          attachments: [], permissionMode: 'full_access', emit: vi.fn() })
        await expect(handle.promise).rejects.toThrow(failure === 'changed-asset' ? '扩展身份' : failure === 'small-window' ? '模型预算' : '模型选择后')
        expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
        const file = join(cwd, 'fixture-commands')
        if (existsSync(file)) {
          const commands = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
          expect(commands.filter(command => command.type === 'prompt' && !command.message.startsWith('/scry_history_ready_'))).toHaveLength(0)
        }
        else expect(failure).toBe('changed-asset')
      } finally { await adapter.dispose?.() }
    })
  }, 15_000)

  it('accepts only exact persisted Pi text and exposes the native receipt', async () => {
    await withFixture(async (profile, cwd) => {
      const context = { text: 'prior answer', contentHash: createHash('sha256').update('prior answer').digest('hex') }
      const prompt = 'continue exactly'
      const outgoing = historicalInputPrefix(context) + prompt
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-pi-receipt', prompt, cwd, agentProfileId: profile.id, resume: 'pi-session-1',
        historicalContext: context, expectedInputTextHash: createHash('sha256').update(outgoing).digest('hex'),
        trackInputReceipt: true, attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })
      await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'pi-user-1' })
      expect(handle.getInputReceipt?.()).toMatchObject({
        status: 'accepted', contextHash: context.contentHash,
        textHash: createHash('sha256').update(outgoing).digest('hex'),
        nativeSessionId: 'pi-session-1', source: 'pi_persisted_session_entry'
      })
      const commands = readFileSync(join(cwd, 'fixture-commands'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      expect(commands.find((command: { type?: string }) => command.type === 'prompt').message).toBe(outgoing)
    })
  }, 15_000)

  it.each([
    { name: 'unchanged image', imageCount: 1, notes: '' },
    { name: 'resized screenshot', imageCount: 1, notes: '\n\n[Image: original 2346x1584, displayed at 2000x1350. Multiply coordinates by 1.17 to map to original image.]' },
    { name: 'multiple resized images', imageCount: 2, notes: '\n\n[Image: original 2346x1584, displayed at 2000x1350. Multiply coordinates by 1.17 to map to original image.]\n[Image: original 4000x2000, displayed at 2000x1000. Multiply coordinates by 2.00 to map to original image.]' }
  ])('accepts a persisted Pi image receipt: $name', async ({ imageCount, notes }) => {
    await withFixture(async (profile, cwd) => {
      const attachments = Array.from({ length: imageCount }, (_, index) => ({
        kind: 'image' as const, name: `screen-${index}.png`, mimeType: 'image/png' as const, dataBase64: 'aW1hZ2U='
      }))
      const content = [
        { type: 'text', text: `inspect this image${notes}` },
        ...attachments.map(attachment => ({ type: 'image', data: attachment.dataBase64, mimeType: attachment.mimeType }))
      ]
      if (notes) writeFileSync(join(cwd, 'persisted-user-content.json'), JSON.stringify(content))
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-pi-image-receipt', prompt: 'inspect this image', cwd, agentProfileId: profile.id,
        trackInputReceipt: true, attachments, permissionMode: 'full_access', emit: vi.fn()
      })
      await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'pi-user-1', status: 'completed' })
      expect(handle.getInputReceipt?.()).toMatchObject({
        status: 'accepted',
        textHash: createHash('sha256').update('inspect this image').digest('hex'),
        nativeSessionId: 'pi-session-1',
        providerTurnId: 'pi-user-1',
        source: 'pi_persisted_session_entry'
      })
      const entries = readFileSync(join(cwd, 'pi-session-1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(entries.at(-1)?.message?.content).toEqual(content)
    })
  }, 15_000)

  it.each([
    { name: 'rewritten body', text: 'rewritten input', block: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } },
    { name: 'arbitrary appended text', text: 'inspect this image\n\nextra instruction', block: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } },
    { name: 'invalid dimension note', text: 'inspect this image\n\n[Image: original 4000x2000, displayed at 2000x1000. Multiply coordinates by 1.00 to map to original image.]', block: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } },
    { name: 'unsupported block', text: 'inspect this image', block: { type: 'toolCall' } },
    { name: 'malformed image', text: 'inspect this image', block: { type: 'image', mimeType: 'image/png' } },
    { name: 'dimension note without image', text: 'inspect this image\n\n[Image: original 4000x2000, displayed at 2000x1000. Multiply coordinates by 2.00 to map to original image.]', block: null }
  ])('keeps invalid persisted Pi image receipts unknown: $name', async ({ text, block }) => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'persisted-user-content.json'), JSON.stringify([
        { type: 'text', text }, ...(block ? [block] : [])
      ]))
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-pi-invalid-image-receipt', prompt: 'inspect this image', cwd, agentProfileId: profile.id,
        trackInputReceipt: true,
        attachments: [{ kind: 'image', name: 'screen.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }],
        permissionMode: 'full_access', emit: vi.fn()
      })
      await expect(handle.promise).rejects.toThrow('未出现 authoritative user session entry')
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'unknown' })
    })
  }, 15_000)

  it.each(['mismatched-entry', 'mismatched-header'])('does not turn a completed run with %s into accepted coverage', async prompt => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({ runId: `run-${prompt}`, prompt, cwd, agentProfileId: profile.id,
        trackInputReceipt: true, attachments: [], permissionMode: 'full_access', emit: vi.fn() })
      await expect(handle.promise).rejects.toThrow('未出现 authoritative user session entry')
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'unknown' })
    })
  }, 15_000)

})
