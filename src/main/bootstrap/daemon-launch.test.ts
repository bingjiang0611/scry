import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLaunchTarget, spawnDaemonSupervisor } from './daemon-launch'

const roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-launch-'))
  roots.push(dir)
  return dir
}
afterAll(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })


describe('daemon launch', () => {
  it('resolves the supervisor entry inside the app path for both shapes', () => {
    expect(daemonLaunchTarget({ isPackaged: true, appPath: '/Applications/Scry.app/Contents/Resources/app.asar', execPath: '/Applications/Scry.app/Contents/MacOS/Scry' })).toEqual({
      executable: '/Applications/Scry.app/Contents/MacOS/Scry',
      supervisorEntry: '/Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon-supervisor.js'
    })
    expect(daemonLaunchTarget({ isPackaged: false, appPath: '/repo', execPath: '/usr/local/bin/electron' })).toEqual({
      executable: '/usr/local/bin/electron',
      supervisorEntry: '/repo/out/main/daemon-supervisor.js'
    })
  })

  it('reports a missing entry as a launch failure instead of a started daemon', () => {
    const root = tempDir()
    const result = spawnDaemonSupervisor({
      target: { executable: join(root, 'no-such-binary'), supervisorEntry: join(root, 'no-such-entry.js') },
      stateDirectory: join(root, 'state'), userDataDir: join(root, 'user-data'),
      appPath: root, resourcesPath: root, appVersion: '1.0.0', isPackaged: false
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('daemon_launch_target_missing:executable')
    // Nothing was spawned, so no log file is invented for a process that never ran.
    expect(existsSync(join(root, 'user-data', 'logs', 'daemon.log'))).toBe(false)
  })

  it('keeps the supervisor log owner-only and never through an App-owned pipe', () => {
    const root = tempDir()
    const entry = join(root, 'entry.sh')
    writeFileSync(entry, 'exit 0\n')
    const result = spawnDaemonSupervisor({
      target: { executable: '/bin/sh', supervisorEntry: entry },
      stateDirectory: join(root, 'state'), userDataDir: join(root, 'user-data'),
      appPath: root, resourcesPath: root, appVersion: '1.0.0', isPackaged: false
    })
    expect(result.status).toBe('started')
    expect(statSync(join(root, 'user-data', 'logs', 'daemon.log')).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'user-data', 'logs')).mode & 0o777).toBe(0o700)
  })

  it('tells the supervisor it was launched by the App, whatever the App inherited', async () => {
    const root = tempDir()
    const entry = join(root, 'entry.sh')
    const seen = join(root, 'seen')
    writeFileSync(entry, `printf '%s' "$SCRY_DAEMON_LAUNCHED_BY" > '${seen}.tmp' && mv '${seen}.tmp' '${seen}'\n`)
    const result = spawnDaemonSupervisor({
      target: { executable: '/bin/sh', supervisorEntry: entry },
      stateDirectory: join(root, 'state'), userDataDir: join(root, 'user-data'),
      appPath: root, resourcesPath: root, appVersion: '1.0.0', isPackaged: false,
      env: { PATH: '/usr/bin:/bin', SCRY_DAEMON_LAUNCHED_BY: 'service' }
    })
    expect(result.status).toBe('started')
    const deadline = Date.now() + 5_000
    while (!existsSync(seen) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(readFileSync(seen, 'utf8')).toBe('app')
  })
})
