import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'

const app = resolve('dist/mac-arm64/Scry.app')
const resources = join(app, 'Contents', 'Resources')
const executable = join(app, 'Contents', 'MacOS', 'Scry')
const daemonEntry = resolve('out/main/daemon.js')
const privateCli = join(resources, 'bin', 'scry')
if (!existsSync(executable) || !existsSync(daemonEntry) || !existsSync(privateCli)) {
  throw new Error('packaged_daemon_fixture_missing')
}
const root = mkdtempSync('/tmp/scry-packaged-recorder-')
const fakeBin = join(root, 'fake-bin')
mkdirSync(fakeBin, { recursive: true })
writeFileSync(join(fakeBin, 'scry'), '#!/bin/sh\nexit 77\n')
chmodSync(join(fakeBin, 'scry'), 0o755)

function environment(state, userData, resourcesPath) {
  return {
    ...process.env,
    PATH: fakeBin,
    ELECTRON_RUN_AS_NODE: '1',
    SCRY_REMOTE_RELAY_ENABLED: '0',
    SCRY_DAEMON_STATE_DIR: state,
    SCRY_DAEMON_USER_DATA_DIR: userData,
    SCRY_DAEMON_APP_PATH: join(resources, 'app.asar'),
    SCRY_DAEMON_RESOURCES_PATH: resourcesPath,
    SCRY_DAEMON_APP_VERSION: '0.2.237',
    SCRY_DAEMON_PACKAGED: '1',
    SCRY_DAEMON_STARTED_BY: 'packaged-recorder-smoke'
  }
}

async function waitForSocket(path, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`packaged daemon exited before ready: ${child.exitCode ?? child.signalCode}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('packaged_daemon_ready_timeout')
}

let live
try {
  const userData = join(root, 'live-user')
  const state = join(root, 'live-state')
  live = spawn(executable, [daemonEntry], { env: environment(state, userData, resources), stdio: ['ignore', 'ignore', 'pipe'] })
  await waitForSocket(join(state, 'local.sock'), live)
  live.kill('SIGTERM')
  const [liveCode, liveSignal] = await once(live, 'exit')
  if (liveCode !== 0 || liveSignal !== null) throw new Error(`packaged daemon stop failed: ${liveCode ?? liveSignal}`)

  const missingResources = join(root, 'missing-resources')
  mkdirSync(missingResources, { recursive: true })
  const missing = spawn(executable, [daemonEntry], {
    env: environment(join(root, 'missing-state'), join(root, 'missing-user'), missingResources),
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  missing.stderr.setEncoding('utf8')
  missing.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096) })
  const [missingCode] = await once(missing, 'exit')
  if (missingCode === 0 || !stderr.includes('daemon_recorder_cli_unavailable')) {
    throw new Error(`packaged daemon did not fail closed: code=${missingCode}`)
  }
  console.log(JSON.stringify({ privateCli, fakePathIgnored: true, liveCode, missingCode, missingReason: 'daemon_recorder_cli_unavailable' }))
} finally {
  if (live && live.exitCode === null && live.signalCode === null) live.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
}
