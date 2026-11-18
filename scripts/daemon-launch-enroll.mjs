#!/usr/bin/env node
// Does the App's launch path really bring up a background daemon the App can then
// enroll with? This runs the same supervisor entry and the same environment the App
// spawns (src/main/bootstrap/daemon-launch.ts), in an isolated userData directory, and
// then does what DaemonClient does: enroll with the one-time secret, then ask the
// daemon who it is over mTLS.
//
//   npm run build && node scripts/daemon-launch-enroll.mjs
//
// Exit 2 with a named reason when any step is missing; a launch that "probably worked"
// is not a result. This is not the App: the App's own spawn call and its credential
// storage are not exercised here (that is what the desktop acceptance script covers).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { enrollLocalDevice, frame, waitForSocket } from './daemon-fixture.mjs'

// Short root: unix sockets have a small path limit.
const root = mkdtempSync('/tmp/scry-launch-')
const userDataDir = join(root, 'userData')
const stateDirectory = join(userDataDir, 'daemon')
const supervisorEntry = resolve('out/main/daemon-supervisor.js')
const result = { started: false, enrolled: false, answered: false, secretReplay: 'not_attempted', stopped: false, cleanup: false }
let reason
let child

function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return child?.exitCode ?? null
  child.kill('SIGTERM')
  return child.exitCode
}

try {
  if (!existsSync(supervisorEntry)) throw new Error('supervisor_entry_missing: npm run build first')
  child = spawn(process.execPath, [supervisorEntry], {
    // The environment the App builds for the supervisor, minus user Provider config:
    // this fixture must not inherit the caller's relay or Provider settings.
    env: {
      PATH: process.env.PATH,
      ELECTRON_RUN_AS_NODE: '1',
      SCRY_REMOTE_RELAY_ENABLED: '0',
      SCRY_DAEMON_STATE_DIR: stateDirectory,
      SCRY_DAEMON_USER_DATA_DIR: userDataDir,
      SCRY_DAEMON_APP_PATH: resolve('.'),
      SCRY_DAEMON_RESOURCES_PATH: resolve('resources'),
      SCRY_DAEMON_APP_VERSION: '0.0.0-launch-acceptance',
      SCRY_DAEMON_PACKAGED: '0',
      SCRY_DAEMON_STARTED_BY: 'launch-acceptance'
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: false
  })
  const alive = () => child.exitCode === null && child.signalCode === null
  result.started = true

  // 1. The supervisor's daemon must create both sockets. A daemon that only half starts
  //    is exactly the failure this checks for.
  if (!await waitForSocket(join(stateDirectory, 'local.sock'), 30_000, alive)) throw new Error('local_socket_missing')
  if (!await waitForSocket(join(stateDirectory, 'enroll.sock'), 10_000, alive)) throw new Error('enroll_socket_missing')

  // 2. Enroll with the one-time secret, like the App's first contact.
  const credentials = await enrollLocalDevice(stateDirectory)
  result.enrolled = true

  // 3. Prove the certificate is accepted and the daemon answers with its identity.
  const info = await frame(stateDirectory, credentials, { op: 'daemonInfo' })
  // The answer is `{op, version, protocol}`, or a refusal: an accepted certificate and a
  // refused frame must not look the same here.
  if (info?.op !== 'daemonInfo' || typeof info.version !== 'string' || typeof info.protocol !== 'number') {
    throw new Error(`daemon_info_unexpected:${JSON.stringify(info).slice(0, 200)}`)
  }
  result.answered = true
  result.version = info.version
  result.protocol = info.protocol

  // 4. A second enrollment with the same (now consumed) secret must be refused: the
  //    one-time property is the security claim, not a convenience.
  const replay = await enrollLocalDevice(stateDirectory).then(() => 'accepted', (error) => String(error.message).slice(0, 60))
  result.secretReplay = replay === 'accepted' ? 'ACCEPTED (unexpected)' : 'refused'
} catch (error) {
  reason = error.message
} finally {
  stop()
  if (child) {
    await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 10_000))])
    result.stopped = child.exitCode !== null || child.signalCode !== null
  }
  rmSync(root, { recursive: true, force: true })
  result.cleanup = !existsSync(root)
}

process.stdout.write(`${JSON.stringify(reason ? { ...result, reason } : result)}\n`)
process.exit(reason ? 2 : 0)
