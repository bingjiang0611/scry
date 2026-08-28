import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { installPiIntegration, piIntegrationStatus } from './pi-integration'

const roots: string[] = []
afterEach(async () => {
  delete process.env.SCRY_CLI_PATH
  delete process.env.SCRY_RECORDER_SOCKET
  delete process.env.SCRY_PI_SOCKET_TIMEOUT_MS
  delete process.env.SCRY_RECORDER_TRANSPORT
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Pi recorder integration installer', () => {
  it('原子安装受管 loader，重复安装保持幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-integration-'))
    roots.push(root)
    const source = join(root, 'pi-recorder.mjs')
    await writeFile(source, 'export default function () {}\n')

    const first = await installPiIntegration({ home: root, source })
    const second = await installPiIntegration({ home: root, source })

    expect(second).toEqual(first)
    expect(await piIntegrationStatus({ home: root, source })).toMatchObject({ installed: true })
    expect(await readFile(first.target, 'utf8')).toContain(source)
    expect(JSON.parse(await readFile(join(root, '.pi', 'agent', 'settings.json'), 'utf8')).extensions).toEqual([first.target])
  })

  it('拒绝覆盖用户已有扩展', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-integration-'))
    roots.push(root)
    const source = join(root, 'pi-recorder.mjs')
    const target = join(root, '.pi', 'agent', 'extensions', 'scry-recorder.ts')
    await writeFile(source, 'export default function () {}\n')
    await mkdir(join(root, '.pi', 'agent', 'extensions'), { recursive: true })
    await writeFile(target, 'export default function userExtension() {}\n')

    await expect(installPiIntegration({ home: root, source })).rejects.toThrow('unmanaged Pi extension')
  })
})

describe('Pi recorder extension lifecycle', () => {
  it('daemon 已接收但响应超时时不冷起重复 CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-timeout-'))
    roots.push(root)
    const socket = join(root, 'recorder.sock')
    const fallback = join(root, 'fallback-called')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\n: > ${JSON.stringify(fallback)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_SOCKET = socket
    process.env.SCRY_PI_SOCKET_TIMEOUT_MS = '20'
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"ok":true}')
      }, 100)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    try {
      const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
      const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
      // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
      const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
      extension.default(pi)
      const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-timeout', getLeafId: () => 'pi-timeout-turn' } }
      for (const handler of handlers.get('before_agent_start') ?? []) await handler({ prompt: 'hello' }, ctx)
      await new Promise((resolve) => setTimeout(resolve, 120))
      await expect(readFile(fallback, 'utf8')).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('direct transport 跳过 socket 且不拉起 daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-direct-'))
    roots.push(root)
    const capture = join(root, 'capture.txt')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(capture)}\ncat >/dev/null\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_SOCKET = join(root, 'unused.sock')
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'

    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-direct', getLeafId: () => 'pi-direct-turn' } }
    for (const handler of handlers.get('before_agent_start') ?? []) await handler({ prompt: 'hello' }, ctx)

    const args = await readFile(capture, 'utf8')
    expect(args).toContain('--event UserPromptSubmit')
    expect(args).not.toContain('--start-daemon')
  })

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
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'done' }],
      usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, reasoning: 1, cost: { total: 0.01 } }
    }
    await emit('message_start', { message })
    await emit('message_end', { message })
    await emit('agent_settled')

    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => {
      const [args, payload] = line.split('\t', 2)
      return { args, payload: JSON.parse(payload) as Record<string, any> }
    })
    expect(rows.map((row) => row.args.match(/--event ([^ ]+)/)?.[1])).toEqual([
      'UserPromptSubmit', 'PreToolUse:read', 'PostToolUse:read', 'Stop'
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
  }, 15_000)
})
