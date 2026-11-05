import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, exitCodeForStartup } from './lifecycle'
import { DAEMON_LOCK_NAME } from './ledger-lock'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-life-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('daemon startup', () => {
  it('reports started and a second start exits without touching the lock', async () => {
    const stateDirectory = tempDir()
    const lines: string[] = []
    const first = await startDaemon({ stateDirectory, startedBy: 'app', log: (line) => lines.push(line) })
    expect(first.status).toBe('started')
    const before = readFileSync(join(stateDirectory, DAEMON_LOCK_NAME), 'utf8')
    const second = await startDaemon({ stateDirectory, startedBy: 'app', log: (line) => lines.push(line) })
    expect(second.status).toBe('already-running')
    expect(exitCodeForStartup(second)).toBe(3)
    expect(readFileSync(join(stateDirectory, DAEMON_LOCK_NAME), 'utf8')).toBe(before)
    expect(lines.some((line) => line.startsWith('daemon.already-running'))).toBe(true)
  })

  it('gives a started daemon exit code 0 and a release that removes its own lock', async () => {
    const stateDirectory = tempDir()
    const result = await startDaemon({ stateDirectory, startedBy: 'app', log: () => {} })
    expect(exitCodeForStartup(result)).toBe(0)
    if (result.status !== 'started') return
    result.release()
    expect(() => readFileSync(join(stateDirectory, DAEMON_LOCK_NAME), 'utf8')).toThrow()
  })
})
