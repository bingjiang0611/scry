import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { piProfileForExecutable } from '../pi-agent-profiles'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import {
  commitManagedRecorderTurn,
  prepareManagedRecorderTurn,
  recoverManagedRecorderTurns
} from '../../core/turn-recorder/managed'
import { listRecords, stableHash } from '../../core/turn-recorder/store'
import { createPiAdapter, piRpcEnvironment, piUserEntryIdAfterBaseline, probePiAgent } from './pi'

const fixtureSource = `#!/usr/bin/env node
let buffer = ''
let leafId = 'active-leaf'
let entrySeq = 0
const entries = [
  { type: 'message', id: 'active-leaf', parentId: null, timestamp: new Date().toISOString(), message: { role: 'assistant' } },
  { type: 'message', id: 'abandoned-user', parentId: 'active-leaf', timestamp: new Date().toISOString(), message: { role: 'user' } }
]
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const raw = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!raw) continue
    const command = JSON.parse(raw)
    const response = (data) => send({ type: 'response', id: command.id, command: command.type, success: true, ...(data ? { data } : {}) })
    if (command.type === 'get_state') response({
      model: { provider: 'test-provider', id: 'test-model' },
      thinkingLevel: 'high',
      sessionId: 'pi-session-1',
      sessionFile: '/tmp/pi-session-1.jsonl',
      cwd: process.cwd()
    })
    else if (command.type === 'get_available_models') response({ models: [{
      provider: 'test-provider', id: 'test-model', name: 'Test Model', thinkingLevelMap: { off: null, high: 'high' }
    }] })
    else if (command.type === 'get_available_thinking_levels') response({ levels: ['off', 'high'] })
    else if (command.type === 'get_commands') response({ commands: [
      {
        name: 'skill:review', description: 'Review code', source: 'skill',
        sourceInfo: { scope: 'project', path: '/repo/.pi/agent/skills/review/SKILL.md' }
      },
      {
        name: 'skill:rate-workflow', description: 'Run rate workflow', source: 'skill',
        sourceInfo: { scope: 'project', path: '/repo/.claude/skills/rate-workflow/SKILL.md' }
      }
    ] })
    else if (command.type === 'get_entries') {
      const start = command.since == null ? 0 : entries.findIndex((entry) => entry.id === command.since) + 1
      if (command.since != null && start === 0) {
        send({ type: 'response', id: command.id, command: command.type, success: false, error: 'invalid cursor' })
      } else response({ entries: entries.slice(start), leafId })
    }
    else if (command.type === 'prompt') {
      if (command.message === 'transport-exit') process.exit(17)
      if (command.message === 'preflight-reject') {
        send({ type: 'response', id: command.id, command: command.type, success: false, error: 'preflight rejected' })
        continue
      }
      if (command.message !== 'no-entry') {
        if (command.message === 'with-compact') {
          const compact = { type: 'compaction', id: 'compact-' + (++entrySeq), parentId: leafId, timestamp: new Date().toISOString() }
          entries.push(compact)
          leafId = compact.id
        }
        const entry = {
          type: 'message', id: 'pi-user-' + (++entrySeq), parentId: leafId, timestamp: new Date().toISOString(),
          message: { role: 'user', content: command.message.startsWith('/skill:') ? 'expanded skill content' : command.message }
        }
        entries.push(entry)
        leafId = entry.id
      }
      response()
      if (command.message === 'hang') continue
      send({ type: 'message_start', message: { role: 'assistant' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'think' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' + String.fromCodePoint(0x2028) + 'world' } })
      send({ type: 'tool_execution_start', toolCallId: 'tool-read', toolName: 'read', args: { path: 'README.md' } })
      send({ type: 'tool_execution_end', toolCallId: 'tool-read', toolName: 'read', result: 'contents', isError: false })
      send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'subagent', args: { task: 'inspect' } })
      send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'subagent', result: { content: [{ type: 'text', text: 'done' }] }, isError: false })
      send({ type: 'message_end', message: {
        role: 'assistant', provider: 'openai-codex', model: 'test-model', stopReason: 'stop',
        content: [{ type: 'text', text: 'hello world' }],
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } }
      } })
      send({ type: 'agent_end', willRetry: false })
      setTimeout(() => send({ type: 'agent_settled' }), 20)
    } else response()
  }
})
`

function withFixture<T>(run: (profile: ReturnType<typeof piProfileForExecutable>, cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-pi-rpc-'))
  const executable = join(dir, 'fixture-pi')
  writeFileSync(executable, fixtureSource)
  chmodSync(executable, 0o755)
  return run(piProfileForExecutable(executable), dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('Pi RPC Provider', () => {
  it('pins the packaged Pi runtime from supported PATH bootstrap forms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-bootstrap-'))
    try {
      const packageRoot = join(dir, 'node_modules', '@example', 'pi-coding-agent')
      const runtime = join(packageRoot, 'dist', 'cli.js')
      const launcher = join(dir, 'pi-agent')
      const bootstrap = join(dir, 'pi')
      mkdirSync(join(packageRoot, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{}')
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      chmodSync(launcher, 0o755)
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@example/pi-coding-agent',
        bin: { pi: 'dist/cli.js' }
      }), { flag: 'wx' })
      writeFileSync(runtime, '#!/usr/bin/env node\n', { flag: 'wx' })
      chmodSync(runtime, 0o755)
      writeFileSync(bootstrap, `#!/bin/sh\n: "\${PI_AGENT_PI:=${runtime}}"\nexport PI_AGENT_PI\nexec ${launcher} "$@"\n`)
      chmodSync(bootstrap, 0o755)

      const profile = piProfileForExecutable(launcher)
      expect(piRpcEnvironment(profile, { PATH: dir, HOME: dir }).PI_AGENT_PI).toBe(realpathSync(runtime))

      writeFileSync(bootstrap, `#!/bin/sh\nPI_AGENT_PI=${runtime} \\\n\texec ${launcher} "$@"\n`)
      expect(piRpcEnvironment(profile, { PATH: dir, HOME: dir }).PI_AGENT_PI).toBe(realpathSync(runtime))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not infer PI_AGENT_PI from an unverified shell assignment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-bootstrap-'))
    try {
      const launcher = join(dir, 'pi-agent')
      const bootstrap = join(dir, 'pi')
      const unrelated = join(dir, 'not-a-package-cli')
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      writeFileSync(unrelated, '#!/bin/sh\nexit 0\n')
      writeFileSync(bootstrap, `#!/bin/sh\nPI_AGENT_PI=${unrelated}\nexec ${launcher} "$@"\n`)
      chmodSync(launcher, 0o755)
      chmodSync(unrelated, 0o755)
      chmodSync(bootstrap, 0o755)

      const env = piRpcEnvironment(piProfileForExecutable(launcher), { PATH: dir, HOME: dir })
      expect(env.PI_AGENT_PI).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('probes native models, permissions, commands and skills for the selected profile', async () => {
    await withFixture(async (profile, cwd) => {
      const probe = await probePiAgent(profile, cwd)
      expect(probe).toMatchObject({ levels: ['off', 'high'], models: [{ id: 'test-model' }] })
      await expect(probePiAgent(profile)).resolves.toMatchObject({ state: { cwd: homedir() } })

      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.runControls!.read({ providerId: 'pi', agentProfileId: profile.id, cwd })).resolves.toMatchObject({
        state: 'ready',
        agentProfileId: profile.id,
        data: {
          models: [expect.objectContaining({ model: { providerId: 'test-provider', id: 'test-model' } })],
          permissions: [expect.objectContaining({ id: 'full_access' })]
        }
      })
      await expect(adapter.skills!.list({ providerId: 'pi', agentProfileId: profile.id, cwd })).resolves.toMatchObject({
        data: expect.arrayContaining([
          { name: 'review', dir: '/repo/.pi/agent/skills/review', scope: 'project', description: 'Review code', enabled: true }
        ])
      })
      await expect(adapter.describe()).resolves.toMatchObject({ capabilities: { mcp: 'none' } })
      expect(adapter.mcp).toBeUndefined()
    })
  }, 20_000)

  it('waits for agent_settled and normalizes stream, subagent tools, session and usage', async () => {
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
        expect.objectContaining({ kind: 'model', stage: 'thinking', thinking: 'think' }),
        expect.objectContaining({ kind: 'model', stage: 'text_delta', text: 'hello\u2028world' }),
        expect.objectContaining({
          kind: 'tool', tool: 'read', toolUseId: 'tool-read', fileOp: 'read', filePath: 'README.md'
        }),
        expect.objectContaining({ kind: 'agent', tool: 'Agent', toolUseId: 'tool-1' }),
        expect.objectContaining({
          kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 4, costUsd: 0.01,
          billingProvider: 'codex', upstreamProvider: 'openai-codex',
          modelUsage: [expect.objectContaining({ billingProvider: 'codex', upstreamProvider: 'openai-codex' })]
        })
      ]))
    })
  }, 15_000)

  it('proves an explicit skill through get_commands and emits a skill event', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-skill', prompt: '/skill:rate-workflow 85781174', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })

      await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'pi-user-1' })
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill', stage: 'skill:rate-workflow', tool: 'Skill', name: 'rate-workflow',
          input: expect.objectContaining({ source: 'explicit_user_input' })
        })
      ]))
    })
  }, 15_000)

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

  it('fails closed when an explicit skill is absent from get_commands', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-missing-skill', prompt: '/skill:missing', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).rejects.toThrow('命令目录未证明')
    })
  })

  it('fails closed after prompt acceptance when no authoritative user entry appears', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-no-entry', prompt: 'no-entry', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).rejects.toThrow('prompt 已接受')
    })
  }, 10_000)

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
  })

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
  })

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

  it('settles as interrupted when abort has to terminate a stuck launcher', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-hang', prompt: 'hang', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })
      setTimeout(() => handle.interrupt(), 50)
      await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
    })
  }, 10_000)
})
