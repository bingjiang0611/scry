import { describe, expect, it } from 'vitest'
import type { BackgroundServiceActionResult, BackgroundServiceConnection } from '../shared/background-service'
import { createVersionMismatchPrompt, daemonCommandBelongsToCheckout, type VersionMismatchPromptDeps } from './background-service-mismatch-prompt'
import { MISMATCH_LATER_BUTTON, MISMATCH_RESTART_BUTTON, reasonMessage, versionMismatchPrompt, type BackgroundServicePrompt } from './background-service-copy'

// The startup prompt for a daemon of another version (approved 2026-11-12): shown at most
// once per App process, 「稍后」 does nothing, 「重启后台服务」 is the settings section's own
// restart action, and a failed restart is reported once, never retried.

const mismatch: BackgroundServiceConnection = { state: 'version-mismatch', running: '1.0.0', expected: '2.0.0' }

interface Script {
  daemonMode?: boolean
  autoRestartIdle?: boolean
  canAutoRestartTarget?: boolean | 'throws' | 'omit'
  recheckActiveRuns?: number | undefined | 'throws' | 'omit'
  answers?: number[]
  restart?: BackgroundServiceActionResult | 'throws'
  busy?: boolean
}

function harness(script: Script = {}) {
  const asked: BackgroundServicePrompt[] = []
  const failures: BackgroundServicePrompt[] = []
  let restarts = 0
  let idleRestarts = 0
  let targetChecks = 0
  let runRechecks = 0
  const answers = [...(script.answers ?? [MISMATCH_RESTART_BUTTON])]
  const runRestart = async () => {
    if (script.restart === 'throws') throw new Error('boom')
    return script.restart ?? { status: 'done' }
  }
  const deps: VersionMismatchPromptDeps = {
    daemonMode: script.daemonMode ?? true,
    ...(script.autoRestartIdle ? { autoRestartIdle: true } : {}),
    ...(script.canAutoRestartTarget === 'omit' ? {} : {
      canAutoRestartTarget: async () => {
        targetChecks += 1
        if (script.canAutoRestartTarget === 'throws') throw new Error('probe failed')
        return script.canAutoRestartTarget === false ? false : true
      }
    }),
    ...(script.recheckActiveRuns === 'omit' ? {} : {
      recheckActiveRuns: async () => {
        runRechecks += 1
        if (script.recheckActiveRuns === 'throws') throw new Error('recheck failed')
        return 'recheckActiveRuns' in script ? (script.recheckActiveRuns as number | undefined) : 0
      }
    }),
    ask: async (prompt) => { asked.push(prompt); return answers.shift() ?? MISMATCH_LATER_BUTTON },
    restart: async () => { restarts += 1; return await runRestart() },
    restartIdle: async () => { idleRestarts += 1; return await runRestart() },
    reportFailure: async (prompt) => { failures.push(prompt) },
    actionInProgress: () => script.busy ?? false
  }
  return {
    prompt: createVersionMismatchPrompt(deps),
    asked,
    failures,
    restarts: () => restarts,
    idleRestarts: () => idleRestarts,
    targetChecks: () => targetChecks,
    runRechecks: () => runRechecks
  }
}

describe('version mismatch prompt', () => {
  it('asks once and runs the restart action when the user picks 重启后台服务', async () => {
    const { prompt, asked, failures, restarts } = harness()
    await expect(prompt(mismatch)).resolves.toEqual({ status: 'restart', result: { status: 'done' } })
    expect(asked).toEqual([versionMismatchPrompt('1.0.0', '2.0.0')])
    expect(restarts()).toBe(1)
    expect(failures).toEqual([])
  })

  it('does nothing for 稍后, and never asks again in this process', async () => {
    const { prompt, asked, restarts } = harness({ answers: [MISMATCH_LATER_BUTTON, MISMATCH_RESTART_BUTTON] })
    await expect(prompt(mismatch)).resolves.toEqual({ status: 'later' })
    await expect(prompt(mismatch)).resolves.toEqual({ status: 'not-shown', reason: 'already-shown' })
    expect(asked).toHaveLength(1)
    expect(restarts()).toBe(0)
  })

  it('asks once even when two detections arrive before the first answer', async () => {
    const { prompt, asked, restarts } = harness()
    const [first, second] = await Promise.all([prompt(mismatch), prompt(mismatch)])
    expect(first.status).toBe('restart')
    expect(second).toEqual({ status: 'not-shown', reason: 'already-shown' })
    expect(asked).toHaveLength(1)
    expect(restarts()).toBe(1)
  })

  it('reports a failed restart with the existing failure copy and does not retry or ask again', async () => {
    const failed: BackgroundServiceActionResult = { status: 'failed', reason: 'identity-changed', message: reasonMessage('identity-changed') }
    const { prompt, failures, restarts, asked } = harness({ restart: failed })
    await expect(prompt(mismatch)).resolves.toEqual({ status: 'restart', result: failed })
    expect(failures).toHaveLength(1)
    expect(failures[0].detail).toContain(reasonMessage('identity-changed'))
    await expect(prompt(mismatch)).resolves.toEqual({ status: 'not-shown', reason: 'already-shown' })
    expect(restarts()).toBe(1)
    expect(asked).toHaveLength(1)
  })

  it('reports a restart that threw as a failure instead of losing it', async () => {
    const { prompt, failures, restarts } = harness({ restart: 'throws' })
    const outcome = await prompt(mismatch)
    expect(outcome).toMatchObject({ status: 'restart', result: { status: 'failed', reason: 'background_service_restart_error' } })
    expect(failures).toHaveLength(1)
    expect(restarts()).toBe(1)
  })

  it('stays quiet when the user cancels the restart confirmation', async () => {
    const { prompt, failures } = harness({ restart: { status: 'cancelled' } })
    await expect(prompt(mismatch)).resolves.toEqual({ status: 'restart', result: { status: 'cancelled' } })
    expect(failures).toEqual([])
  })

  it('shows nothing for any other connection, nor with the switch off, and keeps its one prompt for a mismatch', async () => {
    const { prompt, asked } = harness({ answers: [MISMATCH_LATER_BUTTON] })
    for (const connection of [
      { state: 'ready' },
      { state: 'device-not-authorized' },
      { state: 'unavailable', reason: 'daemon_ready_timeout' }
    ] as BackgroundServiceConnection[]) {
      await expect(prompt(connection)).resolves.toEqual({ status: 'not-shown', reason: 'not-mismatch' })
    }
    expect(asked).toEqual([])
    await expect(prompt(mismatch)).resolves.toEqual({ status: 'later' })

    const off = harness({ daemonMode: false })
    await expect(off.prompt(mismatch)).resolves.toEqual({ status: 'not-shown', reason: 'daemon-mode-disabled' })
    expect(off.asked).toEqual([])
  })

  it('does not interrupt a background-service action already in progress, and spends its one prompt', async () => {
    const busy = harness({ busy: true })
    await expect(busy.prompt(mismatch)).resolves.toEqual({ status: 'not-shown', reason: 'action-in-progress' })
    await expect(busy.prompt(mismatch)).resolves.toEqual({ status: 'not-shown', reason: 'already-shown' })
    expect(busy.asked).toEqual([])
    expect(busy.restarts()).toBe(0)
  })

  it('auto-restarts without blocking dialog ONLY when dev build proves target ownership (S2) and live activeRuns === 0 (S1)', async () => {
    // Dev build + allowed target + live recheck strictly 0 -> auto-restarts silently via restartIdle.
    const devIdle = harness({ autoRestartIdle: true, canAutoRestartTarget: true, recheckActiveRuns: 0 })
    await expect(devIdle.prompt(mismatch, { activeRuns: 0, isPackaged: false })).resolves.toEqual({ status: 'restart', result: { status: 'done' } })
    expect(devIdle.asked).toEqual([])
    expect(devIdle.targetChecks()).toBe(1)
    expect(devIdle.runRechecks()).toBe(1)
    expect(devIdle.idleRestarts()).toBe(1)
    expect(devIdle.restarts()).toBe(0)

    // S2: target is packaged or foreign daemon -> MUST prompt, never call restartIdle or recheck.
    const foreignTarget = harness({ autoRestartIdle: true, canAutoRestartTarget: false, answers: [MISMATCH_LATER_BUTTON] })
    await expect(foreignTarget.prompt(mismatch, { activeRuns: 0, isPackaged: true })).resolves.toEqual({ status: 'later' })
    expect(foreignTarget.asked).toHaveLength(1)
    expect(foreignTarget.runRechecks()).toBe(0)
    expect(foreignTarget.idleRestarts()).toBe(0)

    // S2 fail-closed: missing or throwing target check -> MUST prompt.
    const omitTarget = harness({ autoRestartIdle: true, canAutoRestartTarget: 'omit', answers: [MISMATCH_LATER_BUTTON] })
    await expect(omitTarget.prompt(mismatch, { activeRuns: 0 })).resolves.toEqual({ status: 'later' })
    expect(omitTarget.asked).toHaveLength(1)
    expect(omitTarget.idleRestarts()).toBe(0)

    const throwTarget = harness({ autoRestartIdle: true, canAutoRestartTarget: 'throws', answers: [MISMATCH_LATER_BUTTON] })
    await expect(throwTarget.prompt(mismatch, { activeRuns: 0 })).resolves.toEqual({ status: 'later' })
    expect(throwTarget.asked).toHaveLength(1)
    expect(throwTarget.idleRestarts()).toBe(0)

    // S1: initial activeRuns was 0, but live recheck right before restart returns 1 or undefined or throws -> MUST prompt.
    for (const live of [1, undefined, 'throws'] as const) {
      const raced = harness({ autoRestartIdle: true, canAutoRestartTarget: true, recheckActiveRuns: live, answers: [MISMATCH_LATER_BUTTON] })
      await expect(raced.prompt(mismatch, { activeRuns: 0, isPackaged: false })).resolves.toEqual({ status: 'later' })
      expect(raced.asked).toHaveLength(1)
      expect(raced.idleRestarts()).toBe(0)
    }

    // Dev build + active runs > 0 -> must still prompt, never kill active runs silently.
    const devBusy = harness({ autoRestartIdle: true, answers: [MISMATCH_LATER_BUTTON] })
    await expect(devBusy.prompt(mismatch, { activeRuns: 2 })).resolves.toEqual({ status: 'later' })
    expect(devBusy.asked).toHaveLength(1)
    expect(devBusy.idleRestarts()).toBe(0)

    // Dev build + unknown activeRuns (older daemon) -> fail closed, still prompt.
    const devUnknown = harness({ autoRestartIdle: true, answers: [MISMATCH_LATER_BUTTON] })
    await expect(devUnknown.prompt(mismatch)).resolves.toEqual({ status: 'later' })
    expect(devUnknown.asked).toHaveLength(1)
    expect(devUnknown.idleRestarts()).toBe(0)

    // Packaged build (autoRestartIdle false/omitted) + 0 active runs -> NEVER auto-restarts silently.
    const packagedIdle = harness({ autoRestartIdle: false, answers: [MISMATCH_LATER_BUTTON] })
    await expect(packagedIdle.prompt(mismatch, { activeRuns: 0, isPackaged: false })).resolves.toEqual({ status: 'later' })
    expect(packagedIdle.asked).toHaveLength(1)
    expect(packagedIdle.idleRestarts()).toBe(0)
  })

  it('matches only this checkout daemon entry in daemonCommandBelongsToCheckout (S2)', () => {
    expect(daemonCommandBelongsToCheckout('/path/Electron /Users/dev/work/scry-B/out/main/daemon.js', '/Users/dev/work/scry-B', 'darwin')).toBe(true)
    expect(daemonCommandBelongsToCheckout('/Applications/Scry.app/Contents/MacOS/Scry /Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon.js', '/Users/dev/work/scry-B', 'darwin')).toBe(false)
    expect(daemonCommandBelongsToCheckout('/path/Electron /Users/dev/work/scry-B2/out/main/daemon.js', '/Users/dev/work/scry-B', 'darwin')).toBe(false)
    expect(daemonCommandBelongsToCheckout('/path/Electron /Users/dev/work/scry-B/out/main/daemon.js.bak', '/Users/dev/work/scry-B', 'darwin')).toBe(false)
    expect(daemonCommandBelongsToCheckout('', '/Users/dev/work/scry-B', 'darwin')).toBe(false)
  })
})

describe('version mismatch copy', () => {
  it('names both versions, defaults to restart and cancels to 稍后', () => {
    const prompt = versionMismatchPrompt('1.0.0', '2.0.0')
    expect(prompt.buttons).toEqual(['重启后台服务', '稍后'])
    expect(prompt.defaultId).toBe(MISMATCH_RESTART_BUTTON)
    expect(prompt.cancelId).toBe(MISMATCH_LATER_BUTTON)
    expect(prompt.detail).toContain('1.0.0')
    expect(prompt.detail).toContain('2.0.0')
    expect(prompt.detail).toContain('终端')
  })

  it('says the running version is unknown instead of guessing one', () => {
    const prompt = versionMismatchPrompt(null, '2.0.0')
    expect(prompt.detail).toContain('未知')
    expect(prompt.detail).toContain('2.0.0')
    expect(prompt.detail).not.toContain('null')
  })
})
