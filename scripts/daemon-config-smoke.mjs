import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = process.env.SCRY_ELECTRON_BINARY || (process.platform === 'darwin'
  ? resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : resolve('node_modules/electron/dist/electron'))
const entries = [resolve('out/main/daemon.js'), resolve('out/main/daemon-supervisor.js')]
const bundleVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
const required = {
  SCRY_DAEMON_STATE_DIR: '/tmp/scry-config-smoke/state',
  SCRY_DAEMON_USER_DATA_DIR: '/tmp/scry-config-smoke/userData',
  SCRY_DAEMON_APP_PATH: resolve('.'),
  SCRY_DAEMON_RESOURCES_PATH: resolve('resources'),
  SCRY_DAEMON_APP_VERSION: 'test-version',
  SCRY_DAEMON_PACKAGED: '0'
}
const results = []
const run = (entry, env) => spawnSync(executable, [entry], { env, encoding: 'utf8', timeout: 10_000 })
for (const entry of entries) {
  const role = entry.endsWith('daemon.js') ? 'daemon' : 'supervisor'
  for (const key of Object.keys(required)) {
    // The supervisor takes its version from its own bundle (P5 §2.1): a missing one is
    // not an error there, and the run below checks what it does instead.
    if (role === 'supervisor' && key === 'SCRY_DAEMON_APP_VERSION') continue
    const env = { ...process.env, ...required, ELECTRON_RUN_AS_NODE: '1' }
    delete env[key]
    const result = run(entry, env)
    if (result.status !== 2 || !result.stderr.includes(`daemon_config_missing_${key.toLowerCase()}`)) {
      throw new Error(`${entry} did not reject missing ${key}: status=${result.status} signal=${result.signal} stderr=${result.stderr}`)
    }
    results.push({ entry: role, missing: key, exitCode: result.status })
  }
}

// A version that is not the supervisor bundle's is refused before anything starts.
const supervisor = entries[1]
const conflict = run(supervisor, { ...process.env, ...required, ELECTRON_RUN_AS_NODE: '1' })
if (conflict.status !== 2 || !conflict.stderr.includes('daemon_config_version_conflict')) {
  throw new Error(`supervisor did not reject a foreign version: status=${conflict.status} signal=${conflict.signal} stderr=${conflict.stderr}`)
}
results.push({ entry: 'supervisor', conflict: 'test-version', exitCode: conflict.status })

// Started as a login service would start it (no version, no SHELL), the supervisor
// hands the daemon its bundle version, a default SHELL and launchedBy=service. A stand-in daemon records what it received and exits 0.
const root = mkdtempSync(join(tmpdir(), 'scry-config-smoke-'))
try {
  const fakeDaemon = join(root, 'daemon.mjs')
  const received = join(root, 'received.json')
  const keys = ['SHELL', 'SCRY_DAEMON_APP_VERSION', 'SCRY_DAEMON_STARTED_BY', 'SCRY_DAEMON_LAUNCHED_BY']
  writeFileSync(fakeDaemon, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(received)}, JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, process.env[key] ?? null]))))\n`)
  const { SCRY_DAEMON_APP_VERSION: _version, ...withoutVersion } = required
  const minimal = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    ...withoutVersion,
    SCRY_DAEMON_STATE_DIR: join(root, 'state'),
    SCRY_DAEMON_USER_DATA_DIR: join(root, 'userData'),
    SCRY_DAEMON_ENTRY: fakeDaemon,
    SCRY_DAEMON_LAUNCHED_BY: 'service',
    ELECTRON_RUN_AS_NODE: '1'
  }
  const started = run(supervisor, minimal)
  if (started.status !== 0) throw new Error(`supervisor without version/SHELL failed: status=${started.status} signal=${started.signal} stderr=${started.stderr}`)
  const seen = JSON.parse(readFileSync(received, 'utf8'))
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  if (seen.SHELL !== shell || seen.SCRY_DAEMON_APP_VERSION !== bundleVersion || seen.SCRY_DAEMON_LAUNCHED_BY !== 'service' || !/^supervisor:\d+$/.test(seen.SCRY_DAEMON_STARTED_BY ?? '')) {
    throw new Error(`supervisor handed the daemon an unexpected environment: ${JSON.stringify(seen)}`)
  }
  results.push({ entry: 'supervisor', handedToDaemon: seen, exitCode: started.status })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(JSON.stringify({ checks: results.length, results }))
