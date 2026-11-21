import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLogPath, precreateDaemonLog } from './daemon-log'

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
})
