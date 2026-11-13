import { Buffer } from 'node:buffer'
import { join } from 'node:path'

// Which App runtime the native session-open bench drives. Pure decisions only (no
// process, no filesystem), so the choice of mode, environment and temporary root is
// testable without an App; the daemon lifecycle lives in session-open-bench-daemon.mjs.
//
//   node scripts/session-open-bench.mjs [scenario]            in-process (default, CI gate)
//   node scripts/session-open-bench.mjs [scenario] --daemon   SCRY_HOST_DAEMON=1
export const benchModes = Object.freeze(['in-process', 'daemon'])

/** `[scenario] [--daemon]`, in either order. Anything else is refused, never ignored. */
export function parseBenchArguments(argv, workloads, fallbackScenario = 'markdown') {
  let mode = 'in-process'
  const positional = []
  for (const arg of argv) {
    if (arg === '--daemon') mode = 'daemon'
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else positional.push(arg)
  }
  if (positional.length > 1) throw new Error(`Expected one scenario, got: ${positional.join(' ')}`)
  const scenario = positional[0] ?? fallbackScenario
  if (!Object.hasOwn(workloads, scenario)) throw new Error(`Unknown scenario: ${scenario}`)
  return { scenario, mode }
}

/**
 * The App environment for one mode. The switch is spelled out both ways, so a shell that
 * exported SCRY_HOST_DAEMON=1 cannot silently turn the default (gated) measurement into
 * a daemon one. Daemon mode adds what the established daemon smokes use
 * (scripts/b4v/app.mjs modeEnv, scripts/daemon-mode-timing.mjs):
 *   SCRY_DAEMON_SMOKE_PROVIDER    the daemon's own gate for the offline Codex fixture; the
 *                                 App-side SCRY_ELECTRON_SMOKE_PROVIDER is not forwarded
 *                                 to it and needs a debug port the daemon does not have.
 *   SCRY_DAEMON_CREDENTIAL_PLAINTEXT  a temporary HOME has no default keychain, so
 *                                 safeStorage would block startup; the credential stays
 *                                 inside this run's temporary userData.
 * The side-chat/conversation fixture sets are not needed: the bench drives Codex only.
 */
export function benchAppEnv(mode, home) {
  const shared = {
    HOME: home, SCRY_TEST_APP: '1', SCRY_PERF_LOG: '1', ELECTRON_ENABLE_LOGGING: '1',
    SCRY_ELECTRON_SMOKE_PROVIDER: '1', SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi', SCRY_REMOTE_HOST: '0'
  }
  if (mode === 'in-process') return { ...shared, SCRY_HOST_DAEMON: '0' }
  if (mode === 'daemon') {
    return { ...shared, SCRY_HOST_DAEMON: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1' }
  }
  throw new Error(`Unknown bench mode: ${mode}`)
}

/**
 * Where the temporary root goes. In-process keeps os.tmpdir() (unchanged gate). The
 * daemon refuses unix socket paths over 100 bytes (daemon_socket_path_too_long), and
 * macOS' os.tmpdir() under /var/folders exceeds that, so daemon mode uses /tmp, as
 * daemon-mode-smoke and daemon-packaged-recorder-smoke do. The caller realpaths it.
 */
export function benchTempBase(mode, tmp) {
  return mode === 'daemon' ? '/tmp' : tmp
}

// Mirrors MAX_SOCKET_PATH in src/daemon/local-channel.ts and local-enrollment.ts; the
// longest socket the daemon opens in its state directory is enroll.sock.
export const DAEMON_SOCKET_PATH_LIMIT = 100
export const daemonStateDirectory = userData => join(userData, 'daemon')

/** Fails before launch with the daemon's own reason instead of an App startup timeout. */
export function assertDaemonSocketFits(userData) {
  const longest = join(daemonStateDirectory(userData), 'enroll.sock')
  if (Buffer.byteLength(longest) > DAEMON_SOCKET_PATH_LIMIT) {
    throw new Error(`daemon_socket_path_too_long: ${longest} (${Buffer.byteLength(longest)} > ${DAEMON_SOCKET_PATH_LIMIT} bytes)`)
  }
  return longest
}

/**
 * Where each daemon-mode proof comes from. The in-process sources stay the gate's; in
 * daemon mode the history read runs in the daemon, which keeps no performance sink and
 * whose stdout the supervisor sends to a log file, so the App main's trusted-IPC trace
 * (same renderer call, one per IPC) is the per-open evidence instead.
 */
export function benchEvidenceSources(mode) {
  if (mode === 'daemon') {
    return {
      historyLoadTrace: 'ipc.agent:loadSession',
      historyLoadCounters: { status: 'unavailable', reason: 'session_history.load runs in the daemon, which has no performance recording sink and no forwarded SCRY_PERF_LOG' },
      rejectedHistoryTrace: 'ipc.agent:loadSession'
    }
  }
  return { historyLoadTrace: 'session_history.load', historyLoadCounters: { status: 'available' }, rejectedHistoryTrace: 'session_history.load' }
}
