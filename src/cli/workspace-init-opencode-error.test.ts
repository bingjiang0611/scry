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

describe('scry init OpenCode plugin errors', () => {
  it('OpenCode session.error 随 Stop 上报告终态失败证据，干净回合不带错误字段', async () => {
    const root = await gitWorkspace()
    await initWorkspace({ workspace: root, providers: 'opencode', cliPath: process.execPath })
    const source = (await readFile(join(root, '.opencode/plugins/scry-recorder.js'), 'utf8'))
      .replace(/^import .*$/gm, '')
      .replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')", `const root = ${JSON.stringify(root)}`)
      .replace('export const ScryRecorder', 'const ScryRecorder')
      .replace('export default ScryRecorder', 'ScryRecorder()')
    const delivered: Record<string, unknown>[] = []
    const hooks = await runInNewContext(source, {
      resolve, Buffer, TextDecoder, process,
      spawnSync: (_hook: string, _args: string[], options: { input: string }) => {
        delivered.push(JSON.parse(options.input))
        return { status: 0 }
      }
    }) as Record<string, (input: unknown, output?: unknown) => Promise<void>>
    const stops = () => delivered.filter((payload) => payload.hook_event_name === 'Stop')

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
})
