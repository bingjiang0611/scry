import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { providerHookSource } from '../../cli/workspace-hook-sources.js'
import { listenRecorderDaemon, sendRecorderDaemonHook, type RecorderDaemonHandle } from './daemon.js'
import { drainRecorderDelivery, handleRecorderHook, recoverRecorder } from './recorder.js'
import { listRecords } from './store.js'

const roots: string[] = []
const daemons: RecorderDaemonHandle[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-env-')))
  roots.push(root)
  const output = join(root, 'delivered.jsonl')
  const hook = join(root, 'commit.cjs')
  await writeFile(hook, `#!${process.execPath}\nconst fs = require('node:fs'); const n = JSON.parse(fs.readFileSync(0, 'utf8')); fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({ sessionId: n.sessionId, enabled: process.env.SCRY_TURN_UPLOAD_ENABLED ?? null, url: process.env.TMCP_TRACE_URL ?? null, installation: process.env.SCRY_INSTALLATION_ID ?? null }) + '\\n')\n`, { mode: 0o700 })
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'env-fixture', capture: { diff: false } }))
  await mkdir(join(root, '.scry'))
  await writeFile(join(root, '.scry/cli-path'), '/bin/false\n')
  await writeFile(join(root, '.scry/node-bin-dir'), `${dirname(process.execPath)}\n`)
  const script = join(root, '.scry/provider-hook.sh')
  await writeFile(script, providerHookSource(), { mode: 0o700 })
  const env = { PATH: process.env.PATH, HOME: root, SCRY_RECORDER_COMMIT_HOOK: hook, SCRY_TURN_UPLOAD_ENABLED: '0', TMCP_TRACE_URL: 'daemon-only-secret' }
  const delivered = async () => (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { root, script, env, delivered }
}

async function shell(script: string, event: string, session: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/sh', [script, 'pi', event], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`hook exit ${code}: ${stderr}`)))
    child.stdin.end(JSON.stringify({ session_id: session, prompt: 'fixture', assistant_response: 'done' }))
  })
}

it('shell fast path pins the starting session env, including absence, not the daemon or Stop env', async () => {
  const f = await fixture()
  daemons.push(await listenRecorderDaemon({ workspace: f.root, env: f.env }))
  const sessionEnv = { PATH: process.env.PATH, HOME: f.root }
  await shell(f.script, 'UserPromptSubmit', 'shell', sessionEnv)
  await shell(f.script, 'Stop', 'shell', { ...sessionEnv, SCRY_TURN_UPLOAD_ENABLED: '0' })
  await drainRecorderDelivery(f.root, f.env)
  expect(await f.delivered()).toEqual([{ sessionId: 'shell', enabled: null, url: null, installation: null }])
  const [record] = await listRecords(join(f.root, '.scry'))
  expect(JSON.stringify(record)).not.toContain('daemon-only-secret')
}, 15_000)

it('shell fast path honors session SCRY_RECORDER_ENABLED=0 without creating an open turn', async () => {
  const f = await fixture()
  daemons.push(await listenRecorderDaemon({ workspace: f.root, env: f.env }))
  await shell(f.script, 'UserPromptSubmit', 'disabled', { ...f.env, SCRY_RECORDER_ENABLED: '0' })
  await shell(f.script, 'Stop', 'disabled', { ...f.env, SCRY_RECORDER_ENABLED: '0' })
  await drainRecorderDelivery(f.root, f.env)
  expect(await listRecords(join(f.root, '.scry'))).toEqual([])
}, 15_000)

it('Node transport preserves upload values with quotes, Unicode and newlines outside the record body', async () => {
  const f = await fixture()
  daemons.push(await listenRecorderDaemon({ workspace: f.root, env: f.env }))
  const url = 'https://fixture.invalid/秘密?token="private"\\line\r\nnext'
  for (const event of ['UserPromptSubmit', 'Stop']) await sendRecorderDaemonHook({ workspace: f.root, provider: 'pi', event,
    payload: { session_id: 'node', prompt: 'fixture', assistant_response: 'done' },
    env: event === 'UserPromptSubmit' ? { ...f.env, SCRY_TURN_UPLOAD_ENABLED: '1', TMCP_TRACE_URL: url, SCRY_INSTALLATION_ID: '' } : f.env })
  await drainRecorderDelivery(f.root, f.env)
  expect(await f.delivered()).toEqual([{ sessionId: 'node', enabled: '1', url, installation: '' }])
  const [record] = await listRecords(join(f.root, '.scry'))
  expect(JSON.stringify(record)).not.toContain('private')
}, 15_000)

it('durable inbox replay uses the queued start environment, not the recovery process environment', async () => {
  const f = await fixture()
  for (const event of ['UserPromptSubmit', 'Stop']) await handleRecorderHook({ workspace: f.root, provider: 'pi', event, queueOnly: true,
    payload: { session_id: 'queued', prompt: 'fixture', assistant_response: 'done' },
    env: event === 'UserPromptSubmit' ? { ...f.env, SCRY_TURN_UPLOAD_ENABLED: '1', TMCP_TRACE_URL: 'queued-secret' } : f.env })
  await recoverRecorder(f.root, f.env)
  await drainRecorderDelivery(f.root, f.env)
  expect(await f.delivered()).toEqual([{ sessionId: 'queued', enabled: '1', url: 'queued-secret', installation: null }])
  const [record] = await listRecords(join(f.root, '.scry'))
  expect(JSON.stringify(record)).not.toContain('queued-secret')
}, 15_000)
