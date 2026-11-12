import 'reflect-metadata'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon } from './host-process.harness'
import { cleanupTempDirs } from './host-process.fixtures'
import { createLazyDaemonRunSurface } from '../main/bootstrap/daemon-run-lazy'
import type { DaemonRunModeResult } from '../main/bootstrap/daemon-run-mode'
import { connectionFromMode } from '../main/background-service-status'
import { createVersionMismatchPrompt } from '../main/background-service-mismatch-prompt'
import { MISMATCH_LATER_BUTTON, type BackgroundServicePrompt } from '../main/background-service-copy'
import { DaemonClient, daemonClientPaths } from '../main/daemon-client'

// The startup prompt against a real daemon of another version (B4-S, approved
// 2026-11-12): the App's lazy run surface connects to it the way it does on first use,
// with the grant the previous build stored in the same userData, as after an upgrade;
// the daemon's answer is what reports the mismatch, and the prompt is shown once,
// however many run calls hit it. No launch: the daemon is already there.

const encrypt = (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8')
const decrypt = (value: Buffer) => value.toString('utf8').split('').reverse().join('')

afterEach(() => {
  delete process.env.SCRY_HOST_DAEMON
  cleanupTempDirs()
})

describe('version mismatch prompt against a real daemon', () => {
  it('prompts once when the first run call meets a daemon of another version, and 稍后 changes nothing', async () => {
    const daemon = await startTestDaemon()
    process.env.SCRY_HOST_DAEMON = '1'
    const stateDirectory = join(daemon.userDataDir, 'daemon')
    // The build the daemon came from (it reports 'test') enrolled and stored its grant.
    const previousBuild = () => new DaemonClient({ paths: daemonClientPaths(stateDirectory, daemon.userDataDir), appVersion: 'test', encrypt, decrypt })
    const enrolled = previousBuild()
    await expect(enrolled.connect()).resolves.toEqual({ version: 'test', enrolled: true })
    enrolled.close()
    const lazy = createLazyDaemonRunSurface({
      userDataDir: daemon.userDataDir,
      daemonStateDirectory: stateDirectory,
      // The upgraded App: same userData, another version.
      appVersion: '2.0.0',
      credentialCipher: () => ({ ok: true, encrypt, decrypt }),
      send: () => undefined,
      currentCwd: () => daemon.workspace
    })
    const asked: BackgroundServicePrompt[] = []
    const outcomes: DaemonRunModeResult[] = []
    let restarts = 0
    const prompt = createVersionMismatchPrompt({
      daemonMode: true,
      ask: async (value) => { asked.push(value); return MISMATCH_LATER_BUTTON },
      restart: async () => { restarts += 1; return { status: 'done' } },
      reportFailure: async () => undefined,
      actionInProgress: () => false
    })
    const answered: Array<Promise<unknown>> = []
    lazy.onOutcome((result) => {
      outcomes.push(result)
      answered.push(prompt(connectionFromMode(result, '2.0.0')))
    })
    try {
      await expect(lazy.activeRuns()).rejects.toThrow('daemon_version_mismatch')
      await expect(lazy.activeRuns()).rejects.toThrow('daemon_version_mismatch')
      await Promise.all(answered)
      expect(outcomes.map((result) => result.status)).toEqual(['version-mismatch'])
      expect(outcomes[0]).toMatchObject({ running: 'test', expected: '2.0.0' })
      expect(asked).toHaveLength(1)
      expect(asked[0].detail).toContain('正在运行的后台服务版本是 test，本 App 的版本是 2.0.0')
      expect(restarts).toBe(0)
      // 稍后 left the daemon and the stored grant as they were.
      const again = previousBuild()
      await expect(again.connect()).resolves.toEqual({ version: 'test', enrolled: false })
      again.close()
    } finally {
      lazy.dispose()
      await daemon.dispose()
    }
  }, 60_000)

  it('names the running version when a fresh userData meets an older daemon at enrollment', async () => {
    const daemon = await startTestDaemon()
    process.env.SCRY_HOST_DAEMON = '1'
    // No stored grant: the App enrolls, and the daemon's enrollment reply carries its
    // version. That reply is the only place the App learns it; it must not be dropped.
    const lazy = createLazyDaemonRunSurface({
      userDataDir: daemon.userDataDir,
      daemonStateDirectory: join(daemon.userDataDir, 'daemon'),
      appVersion: '2.0.0',
      credentialCipher: () => ({ ok: true, encrypt, decrypt }),
      send: () => undefined,
      currentCwd: () => daemon.workspace
    })
    const outcomes: DaemonRunModeResult[] = []
    lazy.onOutcome((result) => { outcomes.push(result) })
    try {
      await expect(lazy.activeRuns()).rejects.toThrow('daemon_version_mismatch')
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({ status: 'version-mismatch', running: 'test', expected: '2.0.0' })
      expect(connectionFromMode(outcomes[0]!, '2.0.0')).toEqual({ state: 'version-mismatch', running: 'test', expected: '2.0.0' })
    } finally {
      lazy.dispose()
      await daemon.dispose()
    }
  }, 60_000)
})
