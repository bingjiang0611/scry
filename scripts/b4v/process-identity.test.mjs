import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyDaemonCommand, descendants, envValueFromPsCommand, linuxRow, parseEnviron, parsePsRows, readIdentity,
  signalVerified, supervisorPidFromLock, verifyHolder, waitGone
} from './process-identity.mjs'

describe('b4v process identity (pure)', () => {
  it('parses ps rows with LC_ALL=C lstart, including a space-padded day', () => {
    const rows = parsePsRows([
      '  101     1 Ss   Thu Nov  5 09:01:02 2026     /Applications/Scry.app/Contents/MacOS/Scry --type=renderer',
      '  202   101 S    Thu Nov 12 10:00:00 2026     /x/Electron /x/out/main/daemon.js',
      'garbage'
    ].join('\n'))
    expect(rows.get(101)).toMatchObject({ ppid: 1, startedAt: 'Thu Nov  5 09:01:02 2026', identityKey: '101:Thu Nov  5 09:01:02 2026' })
    expect(rows.get(202).command).toBe('/x/Electron /x/out/main/daemon.js')
    expect(rows.size).toBe(2)
  })

  it('builds the exact Linux key the product writes', () => {
    const files = {
      '/proc/77/stat': '77 (Electron Helper) S 5 77 77 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 123456 0 0',
      '/proc/sys/kernel/random/boot_id': 'boot-1\n',
      '/proc/77/cmdline': '/x/electron\0/x/out/main/daemon.js\0'
    }
    const row = linuxRow(77, (path) => { if (!(path in files)) throw new Error('ENOENT'); return files[path] })
    expect(row).toMatchObject({ pid: 77, ppid: 5, identityKey: '77:linux:boot-1:123456', command: '/x/electron /x/out/main/daemon.js' })
    expect(linuxRow(78, () => { throw new Error('ENOENT') })).toBeUndefined()
  })

  it('only a matching live identity is verified', () => {
    const record = { pid: 5, identityKey: '5:linux:b:1' }
    expect(verifyHolder(record, { pid: 5, status: 'S', identityKey: '5:linux:b:1' })).toBe('verified')
    expect(verifyHolder(record, { pid: 5, status: 'S', identityKey: '5:linux:b:2' })).toBe('pid-reused')
    expect(verifyHolder(record, { pid: 5, status: 'Z', identityKey: '5:linux:b:1' })).toBe('zombie')
    expect(verifyHolder(record, undefined)).toBe('gone')
    expect(verifyHolder({ pid: 5 }, { pid: 5, status: 'S', identityKey: 'x' })).toBe('unrecorded')
    expect(verifyHolder(null, undefined)).toBe('unrecorded')
  })

  it('reads environment values without guessing', () => {
    expect(parseEnviron('A=1\0SCRY_DAEMON_STATE_DIR=/tmp/x/userData/daemon\0B=')).toEqual({ A: '1', SCRY_DAEMON_STATE_DIR: '/tmp/x/userData/daemon', B: '' })
    const ps = '/x/Electron /x/out/main/daemon.js PATH=/usr/bin SCRY_DAEMON_STATE_DIR=/tmp/a/userData/daemon HOME=/tmp/a/home'
    expect(envValueFromPsCommand(ps, 'SCRY_DAEMON_STATE_DIR')).toBe('/tmp/a/userData/daemon')
    expect(envValueFromPsCommand('X_SCRY_DAEMON_STATE_DIR=/no', 'SCRY_DAEMON_STATE_DIR')).toBeUndefined()
    expect(() => envValueFromPsCommand(ps, 'A.*')).toThrow(/invalid env key/)
  })

  it('classifies daemon tree commands and reads the supervisor nomination', () => {
    expect(classifyDaemonCommand('/x/Electron /x/out/main/daemon-supervisor.js')).toBe('supervisor')
    expect(classifyDaemonCommand('/x/Electron /x/out/main/daemon.js')).toBe('daemon')
    expect(classifyDaemonCommand('/x/Electron /x/root --remote-debugging-port=1')).toBe('other')
    expect(classifyDaemonCommand('/x/my-daemon.json')).toBe('other')
    expect(supervisorPidFromLock({ startedBy: 'supervisor:123' })).toBe(123)
    expect(supervisorPidFromLock({ startedBy: 'app:123' })).toBeUndefined()
  })

  it('walks descendants', () => {
    const rows = [{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 3 }, { pid: 5, ppid: 1 }]
    expect(descendants(rows, 2).map((row) => row.pid)).toEqual([3, 4])
  })
})

describe('b4v process identity (real processes)', () => {
  const children = []
  afterEach(() => {
    // Only the children this test spawned, through their own handles.
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })

  const sleeper = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.push(child)
    return child
  }
  const identityOf = async (pid) => {
    for (let index = 0; index < 100; index++) {
      const identity = readIdentity(pid)
      if (identity) return identity
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`no identity for ${pid}`)
  }

  it('never signals a pid whose identity differs from the record', async () => {
    const child = sleeper()
    const identity = await identityOf(child.pid)
    const forged = { pid: child.pid, identityKey: `${identity.identityKey}-other-start` }
    expect(signalVerified(forged, 'SIGKILL')).toEqual({ signalled: false, verdict: 'pid-reused' })
    expect(verifyHolder(identity, readIdentity(child.pid))).toBe('verified')
  }, 20_000)

  it('signals the verified identity and observes it gone', async () => {
    const child = sleeper()
    const identity = await identityOf(child.pid)
    expect(signalVerified(identity, 'SIGTERM')).toEqual({ signalled: true, verdict: 'verified' })
    expect(await waitGone([identity], 10_000)).toEqual([])
    expect(signalVerified(identity, 'SIGTERM').signalled).toBe(false)
  }, 20_000)
})
