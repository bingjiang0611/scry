import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const executable = process.env.SCRY_ELECTRON_BINARY || (process.platform === 'darwin'
  ? resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : resolve('node_modules/electron/dist/electron'))
const entries = [resolve('out/main/daemon.js'), resolve('out/main/daemon-supervisor.js')]
const required = {
  SCRY_DAEMON_STATE_DIR: '/tmp/scry-config-smoke/state',
  SCRY_DAEMON_USER_DATA_DIR: '/tmp/scry-config-smoke/userData',
  SCRY_DAEMON_APP_PATH: resolve('.'),
  SCRY_DAEMON_RESOURCES_PATH: resolve('resources'),
  SCRY_DAEMON_APP_VERSION: 'test-version',
  SCRY_DAEMON_PACKAGED: '0'
}
const results = []
for (const entry of entries) {
  for (const key of Object.keys(required)) {
    const env = { ...process.env, ...required, ELECTRON_RUN_AS_NODE: '1' }
    delete env[key]
    const run = spawnSync(executable, [entry], { env, encoding: 'utf8', timeout: 10_000 })
    if (run.status !== 2 || !run.stderr.includes(`daemon_config_missing_${key.toLowerCase()}`)) {
      throw new Error(`${entry} did not reject missing ${key}: status=${run.status} signal=${run.signal} stderr=${run.stderr}`)
    }
    results.push({ entry: entry.endsWith('daemon.js') ? 'daemon' : 'supervisor', missing: key, exitCode: run.status })
  }
}
console.log(JSON.stringify({ checks: results.length, results }))
