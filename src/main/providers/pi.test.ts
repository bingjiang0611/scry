import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { piProfileForExecutable } from '../pi-agent-profiles'
import { createPiAdapter, probePiAgent } from './pi'

const fixtureSource = `#!/usr/bin/env node
let buffer = ''
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
    else if (command.type === 'get_commands') response({ commands: [{
      name: 'skill:review', description: 'Review code', source: 'skill',
      sourceInfo: { scope: 'project', path: '/repo/.pi/agent/skills/review/SKILL.md' }
    }] })
    else if (command.type === 'prompt') {
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
        data: [{ name: 'review', dir: '/repo/.pi/agent/skills/review', scope: 'project' }]
      })
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
        externalSessionId: 'pi-session-1', stopped: false, status: 'completed'
      })
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
