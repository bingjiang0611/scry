import 'reflect-metadata'
import { connect } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { createLazyDaemonRunSurface } from '../main/bootstrap/daemon-run-lazy'

// B4-S S0-1 verification (macOS): 「重启后台服务」 and 「退出 Scry 与后台服务」 timed out
// at 15 s whenever an App was connected, and the daemon exited within ~120 ms as soon as
// that App was killed. Stopping must not wait for the App to hang up: the App is the one
// waiting for the daemon to go away.

const encrypt = (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8')
const decrypt = (value: Buffer) => value.toString('utf8').split('').reverse().join('')

afterEach(() => {
  delete process.env.SCRY_HOST_DAEMON
  cleanupTempDirs()
})

const within = async <T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  await Promise.race([work, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms).unref())])

describe('daemon shutdown with an App connected', () => {
  it('finishes while the App keeps its connections open, and closes them', async () => {
    const daemon = await startTestDaemon()
    process.env.SCRY_HOST_DAEMON = '1'
    const stateDirectory = join(daemon.userDataDir, 'daemon')
    // The App as it runs: its lazy run surface connected, a long poll parked on the
    // event feed, and its lanes left open.
    const lazy = createLazyDaemonRunSurface({
      userDataDir: daemon.userDataDir,
      daemonStateDirectory: stateDirectory,
      appVersion: 'test',
      credentialCipher: () => ({ ok: true, encrypt, decrypt }),
      send: () => undefined,
      currentCwd: () => daemon.workspace
    })
    // Also a bare connection that never speaks, as a stalled peer would hold one.
    const idle = connect(daemon.host.channel.socketPath)
    await new Promise<void>((resolve, reject) => { idle.once('connect', () => resolve()); idle.once('error', reject) })
    const idleClosed = new Promise<void>((resolve) => idle.once('close', () => resolve()))
    idle.on('error', () => undefined)
    try {
      await expect(lazy.activeRuns()).resolves.toEqual([])
      const started = Date.now()
      expect(await within(daemon.dispose(), 5_000)).not.toBe('timeout')
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(await within(idleClosed, 1_000)).not.toBe('timeout')
      expect(existsSync(daemon.host.channel.socketPath)).toBe(false)
    } finally {
      lazy.dispose()
      idle.destroy()
      await daemon.dispose()
    }
  }, 30_000)
})
