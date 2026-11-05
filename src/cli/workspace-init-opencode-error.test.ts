import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { initWorkspace } from './workspace-init'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

async function gitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-init-opencode-error-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  return root
}

const loadHooks = async (
  root: string,
  respond: (event: string) => { status: number } = () => ({ status: 0 })
) => {
  await initWorkspace({ workspace: root, providers: 'opencode', cliPath: process.execPath })
  const source = (await readFile(join(root, '.opencode/plugins/scry-recorder.js'), 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')", `const root = ${JSON.stringify(root)}`)
    .replace('export const ScryRecorder', 'const ScryRecorder')
    .replace('export default ScryRecorder', 'ScryRecorder()')
  const delivered: Record<string, unknown>[] = []
  const hooks = await runInNewContext(source, {
    resolve, Buffer, TextDecoder, process,
    spawnSync: (_hook: string, args: string[], options: { input: string }) => {
      delivered.push(JSON.parse(options.input))
      return respond(args[1])
    }
  }) as Record<string, (input: unknown, output?: unknown) => Promise<void>>
  return { hooks, stops: () => delivered.filter((payload) => payload.hook_event_name === 'Stop') }
}

describe('scry init OpenCode plugin errors', () => {
  it('OpenCode session.error 随 Stop 上报告终态失败证据，干净回合不带错误字段', async () => {
    const root = await gitWorkspace()
    const { hooks, stops } = await loadHooks(root)

    await hooks['chat.message']({ sessionID: 'failed', prompt: 'go' })
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'failed', error: { name: 'APIError', data: { message: 'fetch() URL is invalid' } } } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'failed' } } })
    expect(stops().at(-1)).toMatchObject({ session_id: 'failed', error: 'fetch() URL is invalid' })

    await hooks['chat.message']({ sessionID: 'clean', prompt: 'go' })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'clean' } } })
    expect(stops().at(-1)).toMatchObject({ session_id: 'clean' })
    expect(stops().at(-1)).not.toHaveProperty('error')

    // 上一轮的错误不能被下一轮继承。
    await hooks['chat.message']({ sessionID: 'failed', prompt: 'again' })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'failed' } } })
    expect(stops().at(-1)).not.toHaveProperty('error')
  })

  it('Stop 首次送达失败时保留暂存错误，重试成功后清除', async () => {
    const root = await gitWorkspace()
    let attempt = 0
    // 第一次 Stop 送达失败，之后成功：失败不能算作“终态已交付”。
    const { hooks, stops } = await loadHooks(root, (event) => ({ status: event === 'Stop' && ++attempt === 1 ? 1 : 0 }))

    await hooks['chat.message']({ sessionID: 'retry', prompt: 'go' })
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'retry', error: { message: 'stream aborted' } } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'retry' } } })
    expect(stops()).toHaveLength(1)
    expect(stops()[0]).toMatchObject({ session_id: 'retry', error: 'stream aborted' })

    // 同一次 session.idle 重试：错误证据仍在，不能被失败的那次送达清掉。
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'retry' } } })
    expect(stops()).toHaveLength(2)
    expect(stops()[1]).toMatchObject({ session_id: 'retry', error: 'stream aborted' })

    // 送达成功后该轮结束：下一次 idle 不再投递，错误也不再随新回合出现。
    await hooks['chat.message']({ sessionID: 'retry', prompt: 'again' })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'retry' } } })
    expect(stops()).toHaveLength(3)
    expect(stops()[2]).not.toHaveProperty('error')
  })
})
