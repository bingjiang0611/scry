import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { processIdentityKey, readProcessIdentitySync } from './process-diagnostics'
import { prepareBackgroundServiceStop, stopBackgroundService } from './background-service-stop'

// The stop chain against real processes, in a temporary userData: the identity the lock
// module writes synchronously is the one the asynchronous IPC-path reader verifies, and
// a process whose identity does not match is left running.

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function stand(): Promise<{ child: ChildProcess; stateDirectory: string; userDataDir: string }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-bg-stop-'))
  roots.push(userDataDir)
  const stateDirectory = join(userDataDir, 'daemon')
  mkdirSync(stateDirectory, { mode: 0o700 })
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))
  return { child, stateDirectory, userDataDir }
}

function writeLock(stateDirectory: string, record: Record<string, unknown>): void {
  writeFileSync(join(stateDirectory, 'daemon.lock'), `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

describe('background service stop with real processes', () => {
  it('stops the process daemon.lock names when its identity verifies', async () => {
    const { child, stateDirectory, userDataDir } = await stand()
    const row = readProcessIdentitySync(child.pid!)!
    const record = { pid: child.pid!, startedAt: row.startedAt, identityKey: processIdentityKey(row), startedBy: 'test' }
    writeLock(stateDirectory, record)
    const deps = { paths: { stateDirectory, userDataDir }, stopTimeoutMs: 5_000 }
    const prepared = await prepareBackgroundServiceStop(deps)
    expect(prepared).toEqual({ status: 'running', holder: record })
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    const outcome = await stopBackgroundService(record, deps)
    expect(await exited).toEqual({ code: 0, signal: null })
    // This stand-in does not remove its lock on exit; a real daemon does (lifecycle.ts).
    expect(outcome).toEqual({ status: 'stopped', holder: record, leftovers: ['daemon.lock'] })
  }, 15_000)

  it('leaves a process alone when the recorded identity is not its own', async () => {
    const { child, stateDirectory, userDataDir } = await stand()
    const row = readProcessIdentitySync(child.pid!)!
    // Same pid, another start: what a reused pid looks like from the lock's side.
    // Linux keys end in the proc start time, macOS keys in the start year: both stay comparable.
    const other = processIdentityKey(row).replace(/(\d+)$/, (value) => String(Number(value) + 1))
    const record = { pid: child.pid!, startedAt: 'other', identityKey: other, startedBy: 'test' }
    writeLock(stateDirectory, record)
    const deps = { paths: { stateDirectory, userDataDir }, stopTimeoutMs: 1_000 }
    expect(await prepareBackgroundServiceStop(deps)).toEqual({ status: 'not-running' })
    expect(await stopBackgroundService(record, deps)).toEqual({ status: 'refused', reason: 'identity-changed' })
    expect(child.exitCode).toBeNull()
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  }, 15_000)
})
