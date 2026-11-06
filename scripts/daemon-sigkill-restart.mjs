import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'

// Unix-domain sockets have a small platform path limit. Keep this acceptance root
// deliberately short; the daemon still receives an isolated userData directory.
const root = mkdtempSync('/tmp/scry-kill-')
const userData = join(root, 'userData')
const state = join(userData, 'daemon')
const socket = join(state, 'local.sock')
const daemonEntry = resolve('out/main/daemon.js')
const executable = process.env.SCRY_ELECTRON_BINARY || (process.platform === 'darwin'
  ? resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : resolve('node_modules/electron/dist/electron'))
const logPath = process.env.SCRY_DAEMON_SIGKILL_LOG || join(root, 'daemon.log')
const logFd = openSync(logPath, 'a', 0o600)

function launch() {
  return spawn(executable, [daemonEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SCRY_REMOTE_RELAY_ENABLED: '0',
      SCRY_DAEMON_STATE_DIR: state,
      SCRY_DAEMON_USER_DATA_DIR: userData,
      SCRY_DAEMON_APP_PATH: resolve('.'),
      SCRY_DAEMON_RESOURCES_PATH: resolve('resources'),
      SCRY_DAEMON_APP_VERSION: '0.2.237',
      SCRY_DAEMON_PACKAGED: '0',
      SCRY_DAEMON_STARTED_BY: 'sigkill-acceptance'
    },
    stdio: ['ignore', logFd, logFd]
  })
}

async function waitFor(predicate, child, label) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (predicate()) return
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label}: daemon exited code=${child.exitCode} signal=${child.signalCode}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`${label}: timeout; log=${logPath}`)
}

function lease(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!value.startedAt || !value.identityKey) throw new Error(`lease identity missing: ${path}`)
  return value
}

let first
let second
try {
  first = launch()
  await waitFor(() => existsSync(socket), first, 'first-ready')
  const firstSocket = lstatSync(socket)
  const leasePaths = [
    join(userData, 'remote', 'pairing', 'pairing-state.lock'),
    join(userData, 'remote', 'ledger', 'session-ledger.lock'),
    join(userData, 'remote', 'output', 'run-output.lock')
  ]
  const firstLeases = leasePaths.map(lease)
  process.kill(first.pid, 'SIGKILL')
  const [firstCode, firstSignal] = await once(first, 'exit')
  if (firstSignal !== 'SIGKILL') throw new Error(`first daemon was not SIGKILL: code=${firstCode} signal=${firstSignal}`)

  second = launch()
  await waitFor(() => {
    if (!existsSync(socket)) return false
    try { return lstatSync(socket).ino !== firstSocket.ino } catch { return false }
  }, second, 'restart-ready')
  const secondLeases = leasePaths.map(lease)
  if (secondLeases.some((value, index) => value.pid === firstLeases[index].pid && value.startedAt === firstLeases[index].startedAt)) {
    throw new Error('restart retained an old lease owner')
  }
  second.kill('SIGTERM')
  const [secondCode, secondSignal] = await once(second, 'exit')
  if (secondCode !== 0 || secondSignal !== null) throw new Error(`restart did not stop cleanly: code=${secondCode} signal=${secondSignal}`)
  if (leasePaths.some(existsSync) || existsSync(join(state, 'daemon.lock'))) throw new Error('graceful restart left an active lease')
  console.log(JSON.stringify({ firstSignal, restartReady: true, secondCode, leaseIdentity: true, logPath }))
} finally {
  if (first && first.exitCode === null && first.signalCode === null) first.kill('SIGKILL')
  if (second && second.exitCode === null && second.signalCode === null) second.kill('SIGKILL')
  closeSync(logFd)
  if (!process.env.SCRY_DAEMON_SIGKILL_KEEP) rmSync(root, { recursive: true, force: true })
}
