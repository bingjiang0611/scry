import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// A6: the one way to get an enrollment secret from a daemon that still holds a live local
// grant. The daemon writes a secret only while no local grant is live (local-enrollment.ts),
// so an App that lost its stored credential, or whose grant another Scry instance holds,
// cannot enroll again, and restarting the daemon does not change that.
//
// The confirmed 「重新连接本机后台服务」 (background-service-actions.ts) writes this request
// after it stopped the verified daemon and before it starts one; the daemon that starts
// next reads it once, deletes it, and writes a secret. The enrollment that spends the
// secret revokes the previous local grant (pairing.ts: one local grant at a time), which
// is what the confirmation says will happen to another instance.
//
// The request carries no secret and grants nothing by itself: whoever can write it in the
// 0700 state directory can already read a secret there. A request older than the TTL, from
// the future, malformed, not 0600 or not a regular file is ignored and still removed, so a
// reconnect that failed half way does not take a grant away at some later start.

export const LOCAL_ENROLLMENT_REQUEST_NAME = 'local-enrollment-request.json'
export const LOCAL_ENROLLMENT_REQUEST_TTL_MS = 10 * 60_000
const FUTURE_SLACK_MS = 60_000

/** App side, after the user confirmed and the daemon was stopped. Asynchronous: it runs behind IPC. */
export async function requestLocalEnrollment(stateDirectory: string, now = Date.now()): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const path = join(stateDirectory, LOCAL_ENROLLMENT_REQUEST_NAME)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ version: 1, requestedAt: now }), { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/** Daemon side, once at start: whether a valid request was there. It is removed either way. */
export function takeLocalEnrollmentRequest(stateDirectory: string, now: number): boolean {
  const path = join(stateDirectory, LOCAL_ENROLLMENT_REQUEST_NAME)
  let valid = false
  try {
    const stat = lstatSync(path)
    if (stat.isFile() && (stat.mode & 0o777) === 0o600) {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; requestedAt?: unknown } | null
      const at = value?.requestedAt
      valid = value?.version === 1 && typeof at === 'number' && Number.isFinite(at) &&
        at <= now + FUTURE_SLACK_MS && now - at <= LOCAL_ENROLLMENT_REQUEST_TTL_MS
    }
  } catch {
    // Absent, unreadable or not JSON: no request.
    valid = false
  }
  rmSync(path, { force: true })
  return valid
}
