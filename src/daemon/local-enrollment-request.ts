import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'


export const LOCAL_ENROLLMENT_REQUEST_NAME = 'local-enrollment-request.json'
export const LOCAL_ENROLLMENT_REQUEST_TTL_MS = 10 * 60_000
const FUTURE_SLACK_MS = 60_000

export async function requestLocalEnrollment(stateDirectory: string, now = Date.now()): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const path = join(stateDirectory, LOCAL_ENROLLMENT_REQUEST_NAME)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ version: 1, requestedAt: now }), { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

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
    valid = false
  }
  rmSync(path, { force: true })
  return valid
}
