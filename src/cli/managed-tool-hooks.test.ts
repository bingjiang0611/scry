import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readProviderActivity } from '../core/turn-recorder/provider-activity.js'
import { handleRecorderHook } from '../core/turn-recorder/recorder.js'
import { listRecords, readHealth, safeKey } from '../core/turn-recorder/store.js'
import { initWorkspace } from './workspace-init.js'
import { gitWorkspace } from './scry.test-fixture.js'

const toolEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
const identity = { SCRY_MANAGED_RUN_ID: 'bridge-run', SCRY_MANAGED_PROMPT_HASH: 'a'.repeat(64) }
type Delivery = { argv: string[]; payload: string }

async function fixture() {
  const root = await gitWorkspace()
  const cli = join(root, 'private cli.cjs')
  const captured = join(root, 'delivered.jsonl')
  await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify({argv: process.argv.slice(2), payload: fs.readFileSync(0, 'utf8')}) + '\\n')
process.exit(Number(process.env.SCRY_TEST_CLI_EXIT || 0))
`)
  await chmod(cli, 0o700)
  await initWorkspace({ workspace: root, providers: 'claude', cliPath: cli })
  const env = { ...process.env, ...identity, SCRY_RECORDER_MANAGED: '1', SCRY_CLI_PATH: cli,
    SCRY_RECORDER_TRANSPORT: 'direct' }
  const payload = JSON.stringify({ session_id: 'bridge-session', prompt: 'fixture', tool_response: 'x'.repeat(256 * 1024) })
  const invoke = async (event: string, provider = 'claude', environment: NodeJS.ProcessEnv = env, inputPayload = payload) => {
    const child = spawn('/bin/sh', [join(root, '.scry/provider-hook.sh'), provider, event], { env: environment })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const input = new Promise<void>((resolve, reject) => {
      child.stdin.once('error', reject)
      child.stdin.end(inputPayload, (error?: Error | null) => error ? reject(error) : resolve())
    })
    const [written, exited] = await Promise.allSettled([input, once(child, 'close')])
    if (written.status === 'rejected') throw written.reason
    if (exited.status === 'rejected') throw exited.reason
    expect(exited.value[0], stderr).toBe(0)
  }
  const deliveries = async (): Promise<Delivery[]> => {
    try { return (await readFile(captured, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  return { root, env, payload, invoke, deliveries }
}

it.each(toolEvents)('drains a large managed Claude %s payload without starting the CLI or logging a failure', async event => {
  const f = await fixture()
  await f.invoke(event)
  expect((await f.deliveries()).length).toBe(0)
  await expect(readFile(join(f.root, '.scry/logs/hook-skip.log'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['UserPromptSubmit', 'Stop', 'SessionEnd', 'FutureEvent'])('still forwards managed Claude %s with exact argv and payload', async event => {
  const f = await fixture()
  await f.invoke(event)
  const delivered = await f.deliveries()
  expect(delivered).toHaveLength(1)
  expect(delivered[0].argv).toEqual(['recorder', 'hook', '--provider', 'claude', '--event', event,
    '--workspace', f.root, '--stdin', '--quiet', '--managed'])
  expect(delivered[0].payload).toBe(f.payload)
})

it.each([
  { provider: 'claude', override: { SCRY_RECORDER_MANAGED: '0' } },
  { provider: 'codex', override: {} },
  { provider: 'qoder', override: {} },
  { provider: 'opencode', override: {} },
  { provider: 'claude', override: { SCRY_MANAGED_RUN_ID: '' } },
  { provider: 'claude', override: { SCRY_MANAGED_PROMPT_HASH: '' } }
])('preserves tool delivery outside identity-scoped managed Claude ($provider, $override)', async ({ provider, override }) => {
  const f = await fixture()
  for (const event of toolEvents) await f.invoke(event, provider, { ...f.env, ...override })
  const delivered = await f.deliveries()
  expect(delivered.map(item => item.argv[item.argv.indexOf('--event') + 1])).toEqual(toolEvents)
  expect(delivered.every(item => item.payload === f.payload)).toBe(true)
  expect(delivered.every(item => item.argv.includes('--managed'))).toBe(override.SCRY_RECORDER_MANAGED !== '0')
})

it('does not invent Hook activity/health; retained Stop closes the managed identity without prematurely committing', async () => {
  const f = await fixture()
  const apply = async (event: string) => handleRecorderHook({ workspace: f.root, provider: 'claude', event,
    managed: true, payload: JSON.parse((await f.deliveries()).at(-1)!.payload), env: f.env })
  await f.invoke('UserPromptSubmit')
  expect(await apply('UserPromptSubmit')).toMatchObject({ status: 'started' })
  const dataRoot = join(f.root, '.scry')
  const activity = await readProviderActivity(dataRoot)
  const health = await readHealth(dataRoot)
  for (const event of toolEvents) await f.invoke(event)
  expect((await f.deliveries()).length).toBe(1)
  expect(await readProviderActivity(dataRoot)).toEqual(activity)
  expect(await readHealth(dataRoot)).toEqual(health)
  await f.invoke('Stop')
  expect(await apply('Stop')).toMatchObject({ status: 'pending', reason: 'managed turn awaits canonical Scry evidence' })
  expect(JSON.parse(await readFile(join(dataRoot, 'runtime/claude', safeKey('bridge-session'), 'open.json'), 'utf8')))
    .toMatchObject({ status: 'closing', managedRunId: identity.SCRY_MANAGED_RUN_ID, endReason: 'provider_terminal' })
  expect((await readProviderActivity(dataRoot)).providers.claude).toMatchObject({ events: 2, lastEvent: 'Stop' })
  expect(await listRecords(dataRoot)).toEqual([])
})

it('keeps a queued start durable during skipped tools and replays it at the retained terminal', async () => {
  const f = await fixture()
  expect(await handleRecorderHook({ workspace: f.root, provider: 'claude', event: 'UserPromptSubmit',
    managed: true, queueOnly: true, payload: JSON.parse(f.payload), env: f.env })).toMatchObject({ status: 'pending' })
  const sessionRoot = join(f.root, '.scry/runtime/claude', safeKey('bridge-session'))
  const queued = await readdir(join(sessionRoot, 'inbox'))
  expect(queued).toHaveLength(1)
  for (const event of toolEvents) await f.invoke(event)
  expect(await readdir(join(sessionRoot, 'inbox'))).toEqual(queued)
  await f.invoke('Stop')
  const delivered = await f.deliveries()
  expect(delivered).toHaveLength(1)
  expect(await handleRecorderHook({ workspace: f.root, provider: 'claude', event: 'Stop',
    managed: true, payload: JSON.parse(delivered[0].payload), env: f.env })).toMatchObject({ status: 'pending' })
  expect(await readdir(join(sessionRoot, 'inbox'))).toEqual([])
  expect(JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')))
    .toMatchObject({ status: 'closing', managedRunId: identity.SCRY_MANAGED_RUN_ID })
  expect(await listRecords(join(f.root, '.scry'))).toEqual([])
})

it('keeps private CLI validation before the managed tool bypass', async () => {
  const f = await fixture()
  // Invalid launch exits before reading stdin; large-input draining is tested on the successful path above.
  await f.invoke('PreToolUse', 'claude', { ...f.env, SCRY_CLI_PATH: join(f.root, 'missing-cli') }, '{}')
  expect((await f.deliveries()).length).toBe(0)
  expect(await readFile(join(f.root, '.scry/logs/hook-skip.log'), 'utf8')).toContain('\tmanaged_cli_invalid\t0\n')
})

it('retains failure diagnostics for lifecycle CLI errors', async () => {
  const f = await fixture()
  await f.invoke('Stop', 'claude', { ...f.env, SCRY_TEST_CLI_EXIT: '23' })
  expect((await f.deliveries()).length).toBe(1)
  expect(await readFile(join(f.root, '.scry/logs/hook-skip.log'), 'utf8')).toContain('\tmanaged_cli_failed\t23\n')
})
