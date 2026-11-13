import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter, piUserEntryIdAfterBaseline } from './pi'
import { recoverManagedRecorderTurns } from '../../core/turn-recorder/managed'
import { withFixture } from './pi-test-fixture'

describe('Pi RPC Provider', () => {
  it('fails a native prompt admission as unknown after dispatch was attempted', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-pi-preflight-failed', prompt: 'preflight-reject', cwd, agentProfileId: profile.id,
        trackInputReceipt: true, attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })
      await expect(handle.promise).rejects.toThrow('preflight rejected')
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'unknown', reason: expect.stringContaining('尚无') })
    })
  }, 15_000)

  it('fails closed when an explicit skill is absent from get_commands', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-missing-skill', prompt: '/skill:missing', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).rejects.toThrow('命令目录未证明')
    })
  }, 10_000)

  it('fails closed after prompt acceptance when no authoritative user entry appears', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-no-entry', prompt: 'no-entry', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).rejects.toThrow('prompt 已接受')
    })
  }, 15_000)

  it('uses append order as the cursor and accepts a user descendant through prompt-time compaction', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-compact', prompt: 'with-compact', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).resolves.toMatchObject({ providerTurnId: 'pi-user-2' })
    })

    expect(piUserEntryIdAfterBaseline('leaf-before', [
      { type: 'compaction', id: 'compact', parentId: 'leaf-before' },
      { type: 'message', id: 'user-next', parentId: 'compact', message: { role: 'user', content: 'expanded' } }
    ])).toBe('user-next')
    expect(() => piUserEntryIdAfterBaseline('leaf-before', [
      { type: 'message', id: 'user-next', parentId: 'different-leaf', message: { role: 'user' } }
    ])).toThrow('ancestry')
    expect(() => piUserEntryIdAfterBaseline(null, [
      { type: 'message', id: 'user-1', parentId: null, message: { role: 'user' } },
      { type: 'message', id: 'user-2', parentId: 'user-1', message: { role: 'user' } }
    ])).toThrow('多个新增')
    expect(piUserEntryIdAfterBaseline('leaf-before', [
      { type: 'message', id: 'root-expanded', parentId: 'leaf-before', message: { role: 'user', content: 'expanded slash command' } },
      { type: 'message', id: 'assistant-after-root', parentId: 'root-expanded', message: { role: 'assistant' } },
      { type: 'message', id: 'supplementary-same-prompt', parentId: 'assistant-after-root', message: { role: 'user', content: '/same' } }
    ], true)).toBe('root-expanded')
    expect(() => piUserEntryIdAfterBaseline('leaf-before', [
      { type: 'message', id: 'root-expanded', parentId: 'leaf-before', message: { role: 'user', content: 'expanded slash command' } },
      { type: 'message', id: 'unrelated-branch', parentId: 'leaf-before', message: { role: 'user', content: '/same' } }
    ], true)).toThrow('active branch')
  }, 15_000)

  it('cancels the exact managed provisional lifecycle when Pi rejects prompt preflight', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        workspaceId: 'pi-managed-reject-fixture',
        dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      const prompt = 'preflight-reject'
      const runId = 'run-managed-preflight-reject'
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId,
        prompt,
        cwd,
        agentProfileId: profile.id,
        attachments: [],
        permissionMode: 'full_access',
        managedRecorder: true,
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(prompt).digest('hex')
        },
        emit: vi.fn()
      }).promise).rejects.toThrow('preflight rejected')
      await expect(recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' }))
        .resolves.toEqual({ recovered: 0, pending: 0 })
    })
  }, 15_000)

  it('retains the managed provisional lifecycle when prompt transport outcome is uncertain', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        workspaceId: 'pi-managed-transport-fixture',
        dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      const prompt = 'transport-exit'
      const runId = 'run-managed-transport-exit'
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId,
        prompt,
        cwd,
        agentProfileId: profile.id,
        attachments: [],
        permissionMode: 'full_access',
        managedRecorder: true,
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(prompt).digest('hex')
        },
        emit: vi.fn()
      }).promise).rejects.toThrow()
      await expect(recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' }))
        .resolves.toEqual({ recovered: 0, pending: 1 })
    })
  }, 10_000)

  it('fails closed when full access was not explicitly selected', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-1', prompt: 'hello', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'default', emit: vi.fn()
      }).promise).rejects.toThrow('本机完全访问')
    })
  })

  it('does not answer an extension question after the RPC stdin has closed', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let questionAborted = false
      const result = await adapter.run({
        runId: 'run-pending-question', prompt: 'pending-question', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn(),
        requestUserInput: (_question, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            questionAborted = true
            reject(new Error('question aborted'))
          }, { once: true })
        })
      }).promise
      expect(result).toMatchObject({ stopped: false, status: 'completed' })
      expect(questionAborted).toBe(true)
      await new Promise((resolve) => setImmediate(resolve))
    })
  })

  it('does not wait for a redundant final state snapshot after an acknowledged stop', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let promptStarted!: () => void
      const started = new Promise<void>((resolve) => { promptStarted = resolve })
      const handle = adapter.run({
        runId: 'run-stop-before-final-state', prompt: 'stop-before-final-state', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access',
        emit: (event) => {
          if (event.stage === 'text_delta') promptStarted()
        }
      })
      await started
      handle.interrupt()
      await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
      expect(existsSync(join(cwd, 'final-state-requested'))).toBe(false)
    })
  }, 10_000)

  it('settles as interrupted when abort has to terminate a stuck launcher', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-hang', prompt: 'hang', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })
      // 每轮 run 自己 spawn Pi RPC 子进程：硬杀仅限本 run。
      expect(handle.forceKillScope).toBe('run_scoped')
      setTimeout(() => handle.interrupt(), 50)
      await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
    })
  }, 10_000)
})
