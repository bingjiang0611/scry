import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from './lifecycle'
import { DAEMON_LOCK_NAME } from './ledger-lock'
import { USERDATA_LOCK_NAME } from './userdata-lock'
import { classifyDaemonStartupFailure, EXIT_DETERMINISTIC_STARTUP } from './startup-failure'

// Real process identity, temporary directories only: the two "daemons" are this test
// process, which is exactly a live holder that verifies.
const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('daemon startup owns userData', () => {
  it('takes the userData lock before building the host and releases it on dispose', async () => {
    const userDataDir = tempDir('scry-life-ud-')
    const stateDirectory = join(userDataDir, 'daemon')
    const seen: boolean[] = []
    const result = await startDaemon({
      stateDirectory, userDataDir, startedBy: 'app', log: () => {},
      startHost: async () => {
        seen.push(existsSync(join(userDataDir, USERDATA_LOCK_NAME)))
        return { dispose: async () => { seen.push(existsSync(join(userDataDir, USERDATA_LOCK_NAME))) } }
      }
    })
    if (result.status !== 'started') throw new Error('expected started')
    expect(JSON.parse(readFileSync(join(userDataDir, USERDATA_LOCK_NAME), 'utf8'))).toMatchObject({ pid: process.pid, role: 'daemon' })
    await result.dispose()
    // The host was built and torn down while this process owned userData.
    expect(seen).toEqual([true, true])
    expect(existsSync(join(userDataDir, USERDATA_LOCK_NAME))).toBe(false)
    expect(existsSync(join(stateDirectory, DAEMON_LOCK_NAME))).toBe(false)
  })

  it('stops a second daemon with another state directory on the same userData, by name', async () => {
    const userDataDir = tempDir('scry-life-ud-')
    const otherState = tempDir('scry-life-state-')
    const first = await startDaemon({ stateDirectory: join(userDataDir, 'daemon'), userDataDir, startedBy: 'app', log: () => {} })
    expect(first.status).toBe('started')
    const before = readFileSync(join(userDataDir, USERDATA_LOCK_NAME), 'utf8')
    const lines: string[] = []
    let hostBuilt = false
    const second = startDaemon({
      stateDirectory: otherState, userDataDir, startedBy: 'manual', log: (line) => lines.push(line),
      startHost: async () => { hostBuilt = true; return { dispose: async () => {} } }
    })
    const error = await second.then(() => undefined, (reason: unknown) => reason)
    expect((error as Error | undefined)?.message).toBe('daemon_userdata_owned')
    // The supervisor stops on this code instead of restarting into the same refusal.
    expect(classifyDaemonStartupFailure(error)).toEqual({ code: EXIT_DETERMINISTIC_STARTUP, reason: 'daemon_userdata_owned' })
    expect(hostBuilt).toBe(false)
    expect(readFileSync(join(userDataDir, USERDATA_LOCK_NAME), 'utf8')).toBe(before)
    // Its own state-directory lock is given back, so it does not block a later daemon there.
    expect(existsSync(join(otherState, DAEMON_LOCK_NAME))).toBe(false)
    expect(lines.some((line) => line.startsWith(`daemon.userdata-owned holderPid=${process.pid} holderRole=daemon`))).toBe(true)
    if (first.status === 'started') await first.dispose()
  })

  it('leaves a daemon on another userData alone', async () => {
    const appUserData = tempDir('scry-life-ud-')
    const testUserData = tempDir('scry-life-ud-test-')
    const app = await startDaemon({ stateDirectory: join(appUserData, 'daemon'), userDataDir: appUserData, startedBy: 'app', log: () => {} })
    const test = await startDaemon({ stateDirectory: join(testUserData, 'daemon'), userDataDir: testUserData, startedBy: 'test', log: () => {} })
    expect(app.status).toBe('started')
    expect(test.status).toBe('started')
    if (test.status === 'started') await test.dispose()
    if (app.status === 'started') await app.dispose()
  })

  it('does not touch the userData lock when another daemon already owns the state directory', async () => {
    const userDataDir = tempDir('scry-life-ud-')
    const stateDirectory = join(userDataDir, 'daemon')
    const first = await startDaemon({ stateDirectory, userDataDir, startedBy: 'app', log: () => {} })
    const before = readFileSync(join(userDataDir, USERDATA_LOCK_NAME), 'utf8')
    const second = await startDaemon({ stateDirectory, userDataDir, startedBy: 'app', log: () => {} })
    expect(second.status).toBe('already-running')
    expect(readFileSync(join(userDataDir, USERDATA_LOCK_NAME), 'utf8')).toBe(before)
    if (first.status === 'started') await first.dispose()
  })
})
