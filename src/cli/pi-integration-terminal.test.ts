import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { piIntegrationTestRoots } from './pi-integration-test-fixture'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { listRecords } from '../core/turn-recorder/store'

const roots = piIntegrationTestRoots()

describe('Pi recorder extension lifecycle', () => {
  it.each<{
    name: string
    reasons: string[]
    status: string
    error?: string
    aborted?: boolean
    shutdown?: boolean
    toolError?: boolean
  }>([
    { name: 'API error', reasons: ['error'], status: 'failed', error: 'model rejected by account' },
    { name: 'error without diagnostic', reasons: ['error'], status: 'failed' },
    { name: 'aborted response', reasons: ['aborted'], status: 'cancelled' },
    { name: 'aborted settlement', reasons: ['stop'], status: 'cancelled', aborted: true },
    { name: 'successful retry', reasons: ['error', 'stop'], status: 'completed', error: 'temporary error' },
    { name: 'tool failure recovered', reasons: ['stop'], status: 'completed', toolError: true },
    { name: 'shutdown after API error', reasons: ['error'], status: 'failed', error: 'model rejected', shutdown: true },
    { name: 'shutdown before settlement', reasons: ['stop'], status: 'interrupted', shutdown: true },
    { name: 'bounded diagnostic', reasons: ['error'], status: 'failed', error: '你'.repeat(30_000) }
  ])('保留 Pi 真实终态和错误证据：$name', async ({ reasons, status, error, aborted, shutdown, toolError }) => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-terminal space-'))
    roots.push(root)
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'pi-terminal', workspaceLabel: 'Pi terminal' }))
    const capture = join(root, 'capture.jsonl')
    const argvPath = join(root, 'argv.bin')
    const cli = join(root, 'capture.sh')
    await writeFile(cli, `#!/bin/sh\nprintf '%s\\0' "$@" >> ${JSON.stringify(argvPath)}\npayload=$(cat)\nprintf '%s\\n' "$payload" >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    process.env.SCRY_CLI_PATH = cli
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-terminal', getLeafId: () => 'pi-turn' } }
    const handlers = new Map<string, (event: Record<string, unknown>, context: typeof ctx) => unknown>()
    // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
    const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
    extension.default({ on(name: string, handler: (event: Record<string, unknown>, context: typeof ctx) => unknown) { handlers.set(name, handler) } })
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      expect(handlers.has(name)).toBe(true)
      await handlers.get(name)!(event, ctx)
    }
    await emit('before_agent_start', { prompt: 'terminal evidence' })
    if (toolError) await emit('tool_execution_end', { toolName: 'read', toolCallId: 'read-1', isError: true, result: 'missing file' })
    for (const stopReason of reasons) {
      await emit('message_end', { message: { role: 'assistant', stopReason, errorMessage: stopReason === 'error' ? error : undefined, content: error && Buffer.byteLength(error) > 64 * 1024 ? [{ type: 'text', text: '文'.repeat(100_000) }] : [] } })
    }
    await emit(shutdown ? 'session_shutdown' : 'agent_settled', { aborted: aborted ?? false })
    await emit('session_shutdown')
    const argv = (await readFile(argvPath, 'utf8')).split('\0').slice(0, -1)
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map((line, index) => ({
      argv: argv.slice(index * 10, (index + 1) * 10), payload: JSON.parse(line) as Record<string, unknown>
    }))
    expect(argv).toHaveLength(rows.length * 10)
    const stops = rows.filter(({ argv }) => argv[argv.indexOf('--event') + 1] === 'Stop')
    expect(stops).toHaveLength(1)
    expect(stops[0].payload.status).toBe(status)
    const expectedError = reasons.at(-1) === 'error' ? error : undefined
    if (!expectedError) expect(stops[0].payload).not.toHaveProperty('error')
    for (const { argv, payload } of rows) {
      const event = argv[argv.indexOf('--event') + 1]
      expect(argv).toEqual(['recorder', 'hook', '--provider', 'pi', '--event', event, '--workspace', root, '--stdin', '--quiet'])
      await handleRecorderHook({ workspace: root, provider: 'pi', event, payload })
    }
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe(status)
    if (expectedError) {
      const bounded = Buffer.byteLength(expectedError) > 64 * 1024
      expect(records[0].errors.status).toBe(bounded ? 'partial' : 'available')
      if (bounded) expect(records[0].assistant.status).toBe('partial')
      expect(records[0].errors.value).toHaveLength(1)
      expect(records[0].errors.value?.[0].message).toContain(bounded ? '你' : expectedError)
      expect(String(stops[0].payload.error)).not.toContain('\uFFFD')
      expect(Buffer.byteLength(String(stops[0].payload.error))).toBeLessThanOrEqual(64 * 1024)
    } else if (!toolError) {
      expect(records[0].errors.status).toBe('unavailable')
    }
  })

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

  it('SIGINT 先持久化 interrupted 终态，再保留原生信号退出语义', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-sigint-'))
    roots.push(root)
    const capture = join(root, 'capture.jsonl')
    const cli = join(root, 'scry')
    const harness = join(root, 'harness.mjs')
    const extensionUrl = pathToFileURL(resolve('packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')).href
    await writeFile(cli, `#!/bin/sh\npayload=$(cat)\nprintf '%s\\n' "$payload" >> ${JSON.stringify(capture)}\n`)
    await chmod(cli, 0o700)
    await writeFile(harness, `
import extension from ${JSON.stringify(extensionUrl)}
// Pi loads signal-exit. It re-raises SIGINT when its listener becomes the only one
// during the same signal emission, so the recorder listener must remain installed
// until its asynchronous terminal delivery has completed.
const signalExit = () => {
  if (process.listeners('SIGINT').length !== 1) return
  process.removeListener('SIGINT', signalExit)
  process.kill(process.pid, 'SIGINT')
}
process.on('SIGINT', signalExit)
const handlers = new Map()
extension({ on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } })
const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'pi-sigint', getLeafId: () => 'pi-sigint-turn' } }
for (const handler of handlers.get('before_agent_start') ?? []) await handler({ prompt: 'interrupt me' }, ctx)
process.stdout.write('READY\\n')
setInterval(() => {}, 60_000)
`)

    const child = spawn(process.execPath, [harness], {
      cwd: root,
      env: { ...process.env, SCRY_CLI_PATH: cli, SCRY_RECORDER_TRANSPORT: 'direct' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    await new Promise<void>((resolveReady, reject) => {
      child.once('error', reject)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (stdout.includes('READY\n')) resolveReady()
      })
      child.once('close', (code, signal) => reject(new Error(`child exited before READY: ${String(code)} ${String(signal)}`)))
    })
    expect(child.kill('SIGINT')).toBe(true)
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null]
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGINT' })
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ session_id: 'pi-sigint', promptId: 'pi-sigint-turn' })
    expect(rows[1]).toMatchObject({ session_id: 'pi-sigint', promptId: 'pi-sigint-turn', status: 'interrupted' })
  })

  it('direct transport 子进程提前关闭 stdin 时不让 EPIPE 杀死 Pi', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-epipe-'))
    roots.push(root)
    const cli = join(root, 'scry')
    const harness = join(root, 'harness.mjs')
    const extensionUrl = pathToFileURL(resolve('packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')).href
    // Only the parent needs Node. Close the child pipe directly, without another
    // Node startup or a timer that is unrelated to EPIPE handling.
    await writeFile(cli, '#!/bin/sh\nexec 0<&-\n')
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
})
