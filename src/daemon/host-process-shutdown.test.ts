import 'reflect-metadata'
import { connect } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { createLazyDaemonRunSurface } from '../main/bootstrap/daemon-run-lazy'


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
    const lazy = createLazyDaemonRunSurface({
      userDataDir: daemon.userDataDir,
      daemonStateDirectory: stateDirectory,
      appVersion: 'test',
      credentialCipher: () => ({ ok: true, encrypt, decrypt }),
      send: () => undefined,
      currentCwd: () => daemon.workspace
    })
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
