import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDaemon } from './daemon-supervisor'
import { readDaemonLaunchFailure } from './daemon-launch-failure'

const VERSION = '0.2.237'
const dirs: string[] = []
function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-launch-failure-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeFailure(directory: string, value: unknown): void {
  writeFileSync(join(directory, 'supervisor-failure.json'), typeof value === 'string' ? value : JSON.stringify(value))
}

describe('a daemon that refused to start is reported by name', () => {
  it('reads the machine code the supervisor recorded after this launch', async () => {
    const directory = tempState()
    writeFailure(directory, { version: 1, failedAt: 2_000, attempts: 1, lastExit: { code: 4, signal: null }, reason: 'daemon_userdata_owned' })
    expect(await readDaemonLaunchFailure(directory, 1_000)).toBe('daemon_userdata_owned')
  })

  it('ignores a failure left by an earlier launch, free text, and missing or broken files', async () => {
    const directory = tempState()
    expect(await readDaemonLaunchFailure(directory, 1_000)).toBeUndefined()
    writeFailure(directory, { failedAt: 500, reason: 'daemon_userdata_owned' })
    expect(await readDaemonLaunchFailure(directory, 1_000)).toBeUndefined()
    writeFailure(directory, { failedAt: 2_000, reason: 'Error: /Users/someone/secret path' })
    expect(await readDaemonLaunchFailure(directory, 1_000)).toBeUndefined()
    writeFailure(directory, '{not json')
    expect(await readDaemonLaunchFailure(directory, 1_000)).toBeUndefined()
  })

  it('stops waiting as soon as the launch reports a refusal instead of timing out', async () => {
    let clock = 0
    let polls = 0
    const result = await ensureDaemon({
      probe: async () => undefined,
      launch: async () => ({ status: 'started' }),
      appVersion: VERSION,
      readyTimeoutMs: 10_000,
      pollMs: 250,
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      // The refusal lands on the third poll, as the supervisor writes it after the exit.
      launchFailure: async () => (++polls >= 3 ? 'daemon_userdata_owned' : undefined)
    })
    expect(result).toEqual({ status: 'unavailable', reason: 'daemon_userdata_owned' })
    expect(clock).toBeLessThan(10_000)
  })

  it('still adopts a daemon that answers, whatever an older failure file says', async () => {
    const launchFailure = vi.fn(async () => 'daemon_userdata_owned')
    const result = await ensureDaemon({
      probe: async () => ({ version: VERSION }), launch: async () => ({ status: 'started' }), appVersion: VERSION, launchFailure
    })
    expect(result).toEqual({ status: 'adopted', version: VERSION })
    expect(launchFailure).not.toHaveBeenCalled()
  })
})
