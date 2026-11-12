import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { readLaunch } from './b4v/process-identity.mjs'
import { resolvePackagedApp } from './daemon-mode-smoke/packaged.mjs'
import { parseRecorderArguments, recorderDaemonLaunch } from './daemon-mode-smoke/recorder.mjs'

// The packaged daemon and its private recorder CLI: started from the packaged binary
// with the entry inside app.asar (what the packaged App's supervisor starts), it must
// come up with the App's own CLI and ignore a `scry` on PATH; given resources without
// that CLI it must refuse to start with exit 4 (daemon_recorder_cli_unavailable).
//   node scripts/daemon-packaged-recorder-smoke.mjs [--app <packaged executable>]

const parsed = parseRecorderArguments(process.argv.slice(2))
if (!parsed.ok) throw new Error(parsed.reason)
const target = resolvePackagedApp(parsed.app)
if (!target.ok) throw new Error(`packaged_daemon_fixture_missing: ${JSON.stringify(target)}`)
const privateCli = join(target.resources, 'bin', 'scry')
if (!existsSync(privateCli)) throw new Error(`packaged_daemon_fixture_missing: ${privateCli}`)

// A short root, as daemon-mode-smoke uses: the daemon refuses socket paths over 100 bytes
// (daemon_socket_path_too_long, exit 4), and macOS's os.tmpdir() under /var/folders made
// <root>/live-state/enroll.sock 101 bytes, which looked like a startup failure.
const root = realpathSync(mkdtempSync('/tmp/scry-pkg-rec-'))
const fakeBin = join(root, 'fake-bin')
mkdirSync(fakeBin, { recursive: true })
writeFileSync(join(fakeBin, 'scry'), '#!/bin/sh\nexit 77\n')
chmodSync(join(fakeBin, 'scry'), 0o755)

function start(name, resources) {
  const state = join(root, `${name}-state`)
  const launch = recorderDaemonLaunch(target, { state, userData: join(root, `${name}-user`), resources, fakeBin })
  const child = spawn(launch.executable, launch.args, { env: launch.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096) })
  return { child, launch, socket: join(state, 'local.sock'), stderr: () => stderr }
}

async function waitForSocket({ socket, child, stderr }) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(socket)) return
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`packaged daemon exited before ready: ${child.exitCode ?? child.signalCode} ${stderr().slice(-400)}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('packaged_daemon_ready_timeout')
}

let live
try {
  live = start('live', target.resources)
  await waitForSocket(live)
  // Evidence, not assumption: the process that answered runs the packaged binary with
  // the archive's entry (Linux: /proc argv; macOS: ps command, compared exactly).
  const observed = readLaunch(live.child.pid)
  const expectedCommand = [live.launch.executable, ...live.launch.args].join(' ')
  const ranPackagedEntry = observed.status === 'available' && observed.command === expectedCommand
  live.child.kill('SIGTERM')
  const [liveCode, liveSignal] = await once(live.child, 'exit')
  if (!ranPackagedEntry) throw new Error(`packaged daemon launch not observed: ${JSON.stringify({ observed, expectedCommand })}`)
  if (liveCode !== 0 || liveSignal !== null) throw new Error(`packaged daemon stop failed: ${liveCode ?? liveSignal}`)

  const missingResources = join(root, 'missing-resources')
  mkdirSync(missingResources, { recursive: true })
  const missing = start('missing', missingResources)
  const [missingCode] = await once(missing.child, 'exit')
  if (missingCode !== 4 || !missing.stderr().includes('daemon_recorder_cli_unavailable')) {
    throw new Error(`packaged daemon did not fail closed with exit 4: code=${missingCode}`)
  }
  console.log(JSON.stringify({
    executable: target.executable, entry: live.launch.args[0], version: target.version, privateCli,
    fakePathIgnored: true, ranPackagedEntry, liveCode, missingCode, missingReason: 'daemon_recorder_cli_unavailable'
  }))
} finally {
  // Only the child this script started, through its own handle.
  if (live && live.child.exitCode === null && live.child.signalCode === null) live.child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
}
