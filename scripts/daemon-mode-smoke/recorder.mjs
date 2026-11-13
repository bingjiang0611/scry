// The packaged recorder smoke (scripts/daemon-packaged-recorder-smoke.mjs): which binary
// and which daemon entry it starts. Both come from one resolved packaged layout
// (packaged.mjs), so the smoke proves the daemon the packaged App would start: the
// entry inside app.asar, with the artifact's own version. Before S0-5 it ran the
// checkout's out/main/daemon.js with the packaged binary and a hard-coded version, which
// proved the binary and the private CLI but not the packaged entry.
import { join } from 'node:path'
import { defaultPackagedAppPath, packagedAppLayout } from '../packaged-app-layout.mjs'

/** `--app <executable>`, or the platform's default packaged executable. */
export function parseRecorderArguments(argv, { platform = process.platform, arch = process.arch } = {}) {
  if (argv.length === 0) return { ok: true, app: packagedAppLayout(defaultPackagedAppPath({ platform, arch }), { platform }).executable }
  const [name, value, ...rest] = argv
  if (name !== '--app' || typeof value !== 'string' || value.length === 0 || value.startsWith('--') || rest.length > 0) {
    return { ok: false, reason: 'usage: daemon-packaged-recorder-smoke.mjs [--app <packaged executable>]' }
  }
  return { ok: true, app: value }
}

export function recorderDaemonLaunch(target, { state, userData, resources, fakeBin }) {
  if (!target?.ok) throw new Error(`packaged target refused: ${target?.reason ?? 'unknown'}`)
  if (!target.packaged) throw new Error('recorder smoke needs a packaged target')
  return {
    executable: target.executable,
    args: [join(target.entryDirectory, 'daemon.js')],
    env: {
      ...process.env,
      // A `scry` on PATH exits 77: the daemon must use the private CLI it was given.
      PATH: fakeBin,
      ELECTRON_RUN_AS_NODE: '1',
      SCRY_REMOTE_RELAY_ENABLED: '0',
      SCRY_DAEMON_STATE_DIR: state,
      SCRY_DAEMON_USER_DATA_DIR: userData,
      SCRY_DAEMON_APP_PATH: target.appArchive,
      SCRY_DAEMON_RESOURCES_PATH: resources,
      SCRY_DAEMON_APP_VERSION: target.version,
      SCRY_DAEMON_PACKAGED: '1',
      SCRY_DAEMON_STARTED_BY: 'packaged-recorder-smoke'
    }
  }
}
