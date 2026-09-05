import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  it('daemon 未 ACK 时回退幂等 direct CLI，避免静默丢事件', async () => {
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
      await expect(readFile(fallback, 'utf8')).resolves.toBe('')
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

  it('显式 CLI pin 失效或为空时不回退 PATH 中的未知安装', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-invalid-pin-'))
    roots.push(root)
    const capture = join(root, 'fallback-called')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\n: > ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    const previousPath = process.env.PATH
    process.env.PATH = root
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    try {
      const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
      const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
      // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
      const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
      extension.default(pi)
      const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-invalid-pin', getLeafId: () => 'pi-invalid-pin-turn' } }
      for (const invalidPin of [join(root, 'missing-scry'), '']) {
        process.env.SCRY_CLI_PATH = invalidPin
        for (const handler of handlers.get('before_agent_start') ?? []) await handler({ prompt: 'hello' }, ctx)
      }
      await expect(readFile(capture, 'utf8')).rejects.toThrow()
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('direct transport 子进程提前关闭 stdin 时不让 EPIPE 杀死 Pi', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-epipe-'))
    roots.push(root)
    const cli = join(root, 'scry')
    const harness = join(root, 'harness.mjs')
    const extensionUrl = pathToFileURL(resolve('packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')).href
    await writeFile(cli, '#!/usr/bin/env node\nimport { closeSync } from "node:fs"\ncloseSync(0)\nsetTimeout(() => {}, 200)\n')
    await chmod(cli, 0o700)
    await writeFile(harness, `
import extension from ${JSON.stringify(extensionUrl)}
const handlers = new Map()
extension({ on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } })
const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'pi-epipe', getLeafId: () => 'pi-epipe-turn' } }
for (const handler of handlers.get('before_agent_start') ?? []) {
  await handler({ prompt: 'x'.repeat(8 * 1024 * 1024) }, ctx)
}
`)

    const result = await new Promise<{ error: Error | null, stderr: string }>((done) => {
      execFile(process.execPath, [harness], {
        cwd: root,
        env: { ...process.env, SCRY_CLI_PATH: cli, SCRY_RECORDER_TRANSPORT: 'direct' }
      }, (error, _stdout, stderr) => done({ error, stderr }))
    })

    expect(result.error).toBeNull()
    expect(result.stderr).not.toContain('EPIPE')
  })

  it('对 oversized Pi 证据发送显式 partial capture metadata 且保留 UTF-8 边界', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-bounded-'))
    roots.push(root)
    const capture = join(root, 'capture.jsonl')
    const cli = join(root, 'scry')
    await writeFile(cli, `#!/bin/sh\npayload=$(cat)\nprintf '%s\\n' "$payload" >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'

    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default(pi)
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-bounded', getLeafId: () => 'pi-bounded-turn' } }
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
    }

    await emit('before_agent_start', { prompt: 'bounded' })
    await emit('tool_execution_start', { toolCallId: 'large-tool', toolName: 'read', args: { text: '你'.repeat(70_000) } })
    await emit('tool_execution_end', { toolCallId: 'large-tool', toolName: 'read', result: { text: 'y'.repeat(70_000) } })
    const message = { role: 'assistant', id: 'large-response', content: [{ type: 'text', text: '你'.repeat(100_000) }] }
    await emit('message_start', { message })
    await emit('message_end', { message })
    await emit('agent_settled')

    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    expect(rows[1].scry_capture.fields.tool_input).toMatchObject({ status: 'partial', reason: 'byte_limit' })
    expect(rows[1].scry_capture.fields.tool_input.retainedBytes).toBe(Buffer.byteLength(rows[1].tool_input.preview))
    expect(rows[1].tool_input.preview).not.toContain('\uFFFD')
    expect(rows[2].scry_capture.fields.tool_response).toMatchObject({ status: 'partial', reason: 'byte_limit' })
    expect(rows[3].scry_capture.fields.assistant_response).toMatchObject({ status: 'partial', reason: 'byte_limit' })
    expect(String(rows[3].assistant_response)).not.toContain('\uFFFD')
    expect(Buffer.byteLength(String(rows[3].assistant_response))).toBeLessThanOrEqual(256 * 1024)
  }, 15_000)

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
    expect(rows[5].payload).not.toHaveProperty('usage')
  }, 15_000)
})
