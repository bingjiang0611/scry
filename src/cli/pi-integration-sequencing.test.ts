import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { piIntegrationTestRoots } from './pi-integration-test-fixture'


const roots = piIntegrationTestRoots()

describe('Pi recorder extension lifecycle', () => {
  it('按一个顶层轮次串行发送 start、tool 与 settled terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-'))
    roots.push(root)
    const capture = join(root, 'capture.jsonl')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\npayload=$(cat)\nprintf '%s\\t%s\\n' "$*" "$payload" >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli

    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
      }
    }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionId: () => 'pi-session',
        getLeafId: () => 'pi-turn-1'
      }
    }
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
    }

    await emit('before_agent_start', { prompt: 'inspect only' })
    await emit('tool_execution_start', { toolCallId: 'call-1', toolName: 'read', args: { path: 'README.md' } })
    await emit('tool_execution_end', { toolCallId: 'call-1', toolName: 'read', result: { ok: true }, isError: false })
    const message = {
      role: 'assistant',
      id: 'response-1',
      model: 'native-pi-model',
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'done' }],
      usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, reasoning: 1, cost: { total: 0.01 } }
    }
    await emit('message_start', { message })
    await emit('message_end', { message })
    await emit('agent_settled')
    await emit('before_agent_start', { prompt: 'no usage available' })
    await emit('agent_settled')

    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => {
      const [args, payload] = line.split('\t', 2)
      return { args, payload: JSON.parse(payload) as Record<string, any> }
    })
    expect(rows.map((row) => row.args.match(/--event ([^ ]+)/)?.[1])).toEqual([
      'UserPromptSubmit', 'PreToolUse:read', 'PostToolUse:read', 'Stop',
      'UserPromptSubmit', 'Stop'
    ])
    expect(rows[0].payload).toMatchObject({ session_id: 'pi-session', promptId: 'pi-turn-1', prompt: 'inspect only' })
    expect(rows[3].payload).toMatchObject({
      session_id: 'pi-session',
      promptId: 'pi-turn-1',
      assistant_response: 'done',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
      status: 'completed'
    })
    expect(rows[3].payload.model_segments).toHaveLength(1)
    expect(rows[3].payload).toMatchObject({ model_ids: ['native-pi-model'], model_ids_complete: true })
    expect(rows[5].payload).not.toHaveProperty('usage')
  }, 15_000)
})
