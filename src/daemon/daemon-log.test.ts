import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLogPath, precreateDaemonLog, rotateDaemonLog } from './daemon-log'

const roots: string[] = []
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'scry-daemon-log-')); roots.push(value); return value }
afterEach(() => { roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })) })

describe('daemon log', () => {
  it('pre-creates an owner-only directory and file under the user data directory', () => {
    const userData = join(root(), 'Scry 中文')
    const path = precreateDaemonLog(userData)
    expect(path).toBe(join(userData, 'logs', 'daemon.log'))
    expect(statSync(join(userData, 'logs')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('keeps what is already logged', () => {
    const userData = root()
    precreateDaemonLog(userData)
    writeFileSync(daemonLogPath(userData), 'earlier line\n', { flag: 'a' })
    precreateDaemonLog(userData)
    expect(readFileSync(daemonLogPath(userData), 'utf8')).toBe('earlier line\n')
  })

  it('rotates an oversized log into numbered copies and keeps at most three', () => {
    const userData = root()
    const path = precreateDaemonLog(userData)
    for (let round = 1; round <= 5; round++) {
      writeFileSync(path, `round ${round}\n`.repeat(4))
      expect(rotateDaemonLog(userData, 10, 3)).toBe(true)
      precreateDaemonLog(userData)
    }
    expect(readFileSync(path, 'utf8')).toBe('')
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('round 5')
    expect(readFileSync(`${path}.2`, 'utf8')).toContain('round 4')
    expect(readFileSync(`${path}.3`, 'utf8')).toContain('round 3')
    expect(existsSync(`${path}.4`)).toBe(false)
  })

  it('leaves a log under the limit alone', () => {
    const userData = root()
    const path = precreateDaemonLog(userData)
    writeFileSync(path, 'small\n')
    expect(rotateDaemonLog(userData, 1024, 3)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('small\n')
    expect(existsSync(`${path}.1`)).toBe(false)
  })
})
