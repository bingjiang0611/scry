import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { providerHookSource } from './workspace-hook-sources.js'
import { listenRecorderDaemon, type RecorderDaemonHandle } from '../core/turn-recorder/daemon.js'
import { safeKey } from '../core/turn-recorder/store.js'
import { recorderInboxEntries } from '../core/turn-recorder/inbox.js'
import type { RecorderOpenTurnState } from '../core/turn-recorder/runtime-state.js'

const roots: string[] = []
const servers: Server[] = []
const daemons: RecorderDaemonHandle[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const daemon of daemons.splice(0)) await daemon.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-http-outcome-')))
  roots.push(root)
  await mkdir(join(root, '.scry'))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'http-outcome', capture: { diff: false } }))
  await writeFile(join(root, '.scry/node-bin-dir'), `${dirname(process.execPath)}\n`)
  const marker = join(root, 'tried.txt')
  const cli = join(root, 'cli.sh')
  const script = join(root, '.scry/provider-hook.sh')
  const socket = join(root, 'daemon.sock')
  await writeFile(join(root, '.scry/cli-path'), `${cli}\n`)
  await writeFile(script, providerHookSource(), { mode: 0o700 })
  const capture = `#!/bin/sh\nprintf '%s' "\${SCRY_RECORDER_DAEMON_TRIED-unset}" > ${JSON.stringify(marker)}\n`
  await writeFile(cli, capture, { mode: 0o700 })
  const env = { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: join(root, 'state'), SCRY_GRANT_DIR: join(root, 'grants'), SCRY_AUTO_UPDATE: '0', SCRY_NO_UPDATE_CHECK: '1', SCRY_RECORDER_SOCKET: socket }
  return { root, cli, script, socket, marker, capture, env }
}

async function shell(script: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/sh', [script, 'pi', 'UserPromptSubmit'], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`hook exit ${code}: ${stderr}`)))
    child.stdin.end(JSON.stringify({ session_id: 'protocol', prompt: 'fixture' }))
  })
}

it.each([400, 404, 409, 413, 500])('classifies a completed HTTP %i response without confusing rejection with unknown delivery', async code => {
  const f = await fixture()
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(code)
    response.end()
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(f.socket, resolve))
  await shell(f.script, f.env)
  expect(await readFile(f.marker, 'utf8')).toBe(code >= 500 ? '1' : 'unset')
}, 15_000)

it('a stale protocol header reaches the real CLI and current daemon, applies the event and leaves no inbox item', async () => {
  const f = await fixture()
  const entry = join(f.root, 'cli.mjs')
  await build({ entryPoints: [resolve('src/cli/scry.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  await writeFile(f.cli, `${f.capture}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`, { mode: 0o700 })
  const current = providerHookSource()
  const stale = current.replace(/x-scry-protocol: \d+/, 'x-scry-protocol: 1')
  expect(stale).not.toBe(current)
  await writeFile(f.script, stale)
  daemons.push(await listenRecorderDaemon({ workspace: f.root, env: f.env }))
  await shell(f.script, f.env)
  expect(await readFile(f.marker, 'utf8')).toBe('unset')
  const sessionRoot = join(f.root, '.scry/runtime/pi', safeKey('protocol'))
  const open = JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')) as RecorderOpenTurnState
  expect(open.prompt).toBe('fixture')
  expect(await recorderInboxEntries(sessionRoot)).toEqual([])
}, 30_000)
