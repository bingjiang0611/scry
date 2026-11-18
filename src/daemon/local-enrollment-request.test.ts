import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLocalEnrollmentStore } from './local-enrollment'
import { LOCAL_ENROLLMENT_REQUEST_NAME, LOCAL_ENROLLMENT_REQUEST_TTL_MS, requestLocalEnrollment } from './local-enrollment-request'

// A6: the App lost its stored credential while the daemon still holds a live local grant
// for it, so the daemon writes no secret and the App cannot enroll again. The confirmed
// 「重新连接本机后台服务」 stops the daemon and leaves this one-time request; the daemon it
// then starts writes a secret although a grant is live. Nothing else makes it do so.

const directories: string[] = []
function stateDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'scry-enroll-request-'))
  directories.push(path)
  return path
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('local enrollment request (A6: reconnect after the App lost its credential)', () => {
  it('makes the next daemon start write a secret despite a live grant, once', async () => {
    const directory = stateDirectory()
    // Control: a live grant and no request means no secret, as before.
    const store = openLocalEnrollmentStore(directory, { clock: () => 5_000 })
    store.ensure(true)
    expect(store.present()).toBe(false)

    await requestLocalEnrollment(directory, 5_000)
    const request = join(directory, LOCAL_ENROLLMENT_REQUEST_NAME)
    expect(statSync(request).mode & 0o777).toBe(0o600)
    store.ensure(true)
    expect(store.present()).toBe(true)
    // Consumed by that start: the following one is back to the rule.
    expect(existsSync(request)).toBe(false)
    store.ensure(true)
    expect(store.present()).toBe(false)
  })

  it('ignores a request that is stale, from the future, malformed, not 0600 or not a regular file, and removes it', async () => {
    const directory = stateDirectory()
    const request = join(directory, LOCAL_ENROLLMENT_REQUEST_NAME)
    const now = 10 * LOCAL_ENROLLMENT_REQUEST_TTL_MS
    const store = openLocalEnrollmentStore(directory, { clock: () => now })
    const refused: Array<() => Promise<void> | void> = [
      () => requestLocalEnrollment(directory, now - LOCAL_ENROLLMENT_REQUEST_TTL_MS - 1),
      () => requestLocalEnrollment(directory, now + 60_001),
      () => { writeFileSync(request, '{"version":2,"requestedAt":0}', { mode: 0o600 }) },
      () => { writeFileSync(request, 'not json', { mode: 0o600 }) },
      async () => { await requestLocalEnrollment(directory, now); chmodSync(request, 0o644) },
      () => {
        const target = join(directory, 'elsewhere.json')
        writeFileSync(target, JSON.stringify({ version: 1, requestedAt: now }), { mode: 0o600 })
        symlinkSync(target, request)
      }
    ]
    for (const plant of refused) {
      await plant()
      store.ensure(true)
      expect(store.present()).toBe(false)
      expect(existsSync(request)).toBe(false)
    }
    // Control: the same request, fresh and well-formed, is honored.
    await requestLocalEnrollment(directory, now)
    store.ensure(true)
    expect(store.present()).toBe(true)
  })
})
