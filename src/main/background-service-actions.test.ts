import { describe, expect, it } from 'vitest'
import type { BackgroundServiceConnection } from '../shared/background-service'
import type { DaemonLockRecord } from '../daemon/ledger-lock'
import type { PreparedStop, StopOutcome } from './background-service-stop'
import { quitWithBackgroundService, reconnectBackgroundService, restartBackgroundService, type BackgroundServiceActionDeps } from './background-service-actions'
import { confirmPrompt, reasonMessage } from './background-service-copy'

// Order and consent for the three actions: who is asked, when, and what may happen
// before and after the user answers. Every step is recorded so the sequence is checked.

const holder: DaemonLockRecord = { pid: 4242, startedAt: 's', identityKey: '4242:s', startedBy: 'supervisor:1' }

interface Script {
  daemonMode?: boolean
  connection?: BackgroundServiceConnection
  activeRuns?: number | undefined | 'throws'
  prepared?: PreparedStop
  stopped?: StopOutcome
  answer?: boolean
  after?: BackgroundServiceConnection
}

function harness(script: Script = {}) {
  const steps: string[] = []
  let holds = 0
  const deps: BackgroundServiceActionDeps = {
    daemonMode: script.daemonMode ?? true,
    connection: async () => { steps.push('connection'); return script.connection ?? { state: 'ready' } },
    activeRuns: async () => {
      steps.push('activeRuns')
      if (script.activeRuns === 'throws') throw new Error('daemon_not_running')
      return 'activeRuns' in script ? script.activeRuns as number | undefined : 0
    },
    prepareStop: async () => { steps.push('prepare'); return script.prepared ?? { status: 'running', holder } },
    stop: async (record) => { steps.push(`stop:${record.pid}:held=${holds}`); return script.stopped ?? { status: 'stopped', holder, leftovers: [] } },
    confirm: async (action, runs) => { steps.push(`confirm:${action}:${runs}`); return script.answer ?? true },
    holdLaunches: () => { holds += 1; steps.push('hold'); return () => { holds -= 1; steps.push('release') } },
    reconnect: async () => { steps.push('reconnect'); return script.after ?? { state: 'ready' } },
    discardLocalCredential: async () => { steps.push('discard') },
    requestLocalEnrollment: async () => { steps.push('request') },
    reportLeftovers: async (left) => { steps.push(`leftovers:${left.join(',')}`) },
    quitApp: () => { steps.push('quit') }
  }
  return { deps, steps, holds: () => holds }
}

describe('restart background service', () => {
  it('stops the verified holder without asking when the daemon reports no active run, then reconnects', async () => {
    const { deps, steps, holds } = harness({ activeRuns: 0 })
    await expect(restartBackgroundService(deps)).resolves.toEqual({ status: 'done' })
    expect(steps).toEqual(['prepare', 'activeRuns', 'hold', 'stop:4242:held=1', 'release', 'reconnect'])
    expect(holds()).toBe(0)
  })

  it('asks a second time when runs are active, naming the count, and stops nothing on cancel', async () => {
    const { deps, steps } = harness({ activeRuns: 2, answer: false })
    await expect(restartBackgroundService(deps)).resolves.toEqual({ status: 'cancelled' })
    expect(steps).toEqual(['prepare', 'activeRuns', 'confirm:restart:2'])
  })

  it('asks when the daemon cannot say whether runs are active (version mismatch, refused grant)', async () => {
    for (const activeRuns of [undefined, 'throws'] as const) {
      const { deps, steps } = harness({ activeRuns, answer: false })
      await expect(restartBackgroundService(deps)).resolves.toEqual({ status: 'cancelled' })
      expect(steps).toContain('confirm:restart:null')
      expect(steps.some((step) => step.startsWith('stop'))).toBe(false)
    }
  })

  it('fails closed on a stop refusal: no launch, launches released, a readable reason', async () => {
    const { deps, steps, holds } = harness({ stopped: { status: 'refused', reason: 'stop-timeout' } })
    const result = await restartBackgroundService(deps)
    expect(result).toMatchObject({ status: 'failed', reason: 'stop-timeout' })
    expect((result as { message: string }).message).toContain('没有再次发送信号')
    expect(steps).not.toContain('reconnect')
    expect(holds()).toBe(0)
  })

  it('names the system keyring when the restarted service still has no local credential (B4-S F2)', async () => {
    const reason = 'daemon_credential_unavailable:unsafe_credential_storage'
    const { deps } = harness({ after: { state: 'unavailable', reason } })
    const result = await restartBackgroundService(deps)
    expect(result).toMatchObject({ status: 'failed', reason })
    expect((result as { message: string }).message).toContain('系统密钥环不可用')
    expect(reasonMessage(reason, 'linux')).toContain('Secret Service 密钥环（例如 gnome-keyring）')
    expect(reasonMessage(reason, 'darwin')).not.toContain('gnome-keyring')
    expect(reasonMessage('daemon_credential_unavailable', 'darwin')).toContain('（daemon_credential_unavailable）')
  })

  it('refuses before asking when the holder cannot be identified', async () => {
    const { deps, steps } = harness({ prepared: { status: 'refused', reason: 'identity-unreadable' } })
    await expect(restartBackgroundService(deps)).resolves.toMatchObject({ status: 'failed', reason: 'identity-unreadable' })
    expect(steps).toEqual(['prepare'])
  })

  it('starts the service when none is running, and reports a daemon that still mismatches', async () => {
    const { deps, steps } = harness({ prepared: { status: 'not-running' }, after: { state: 'version-mismatch', running: '1.0.0', expected: '2.0.0' } })
    await expect(restartBackgroundService(deps)).resolves.toMatchObject({ status: 'failed', reason: 'daemon_version_mismatch' })
    expect(steps).toEqual(['prepare', 'reconnect'])
  })

  it('is unavailable with the switch off', async () => {
    const { deps, steps } = harness({ daemonMode: false })
    await expect(restartBackgroundService(deps)).resolves.toMatchObject({ status: 'failed', reason: 'daemon_mode_disabled' })
    expect(steps).toEqual([])
  })
})

describe('quit Scry and background service', () => {
  it('stops the service and quits; launches stay held so nothing starts it again', async () => {
    const { deps, steps, holds } = harness({ activeRuns: 0 })
    await expect(quitWithBackgroundService(deps)).resolves.toEqual({ status: 'done' })
    expect(steps).toEqual(['prepare', 'activeRuns', 'hold', 'stop:4242:held=1', 'quit'])
    expect(holds()).toBe(1)
  })

  it('asks a second time when runs are active and keeps the App on cancel', async () => {
    const { deps, steps } = harness({ activeRuns: 1, answer: false })
    await expect(quitWithBackgroundService(deps)).resolves.toEqual({ status: 'cancelled' })
    expect(steps).toEqual(['prepare', 'activeRuns', 'confirm:quit:1'])
  })

  it('keeps the App open when the service did not stop', async () => {
    const { deps, steps, holds } = harness({ stopped: { status: 'refused', reason: 'stop-timeout' } })
    await expect(quitWithBackgroundService(deps)).resolves.toMatchObject({ status: 'failed', reason: 'stop-timeout' })
    expect(steps).not.toContain('quit')
    expect(holds()).toBe(0)
  })

  it('names leftovers before quitting', async () => {
    const { deps, steps } = harness({ stopped: { status: 'stopped', holder, leftovers: ['daemon.lock', 'supervisor:1'] } })
    await quitWithBackgroundService(deps)
    expect(steps.slice(-2)).toEqual(['leftovers:daemon.lock,supervisor:1', 'quit'])
  })
})

describe('reconnect after revocation', () => {
  it('runs the §13.2 chain only after a second confirmation: verify, stop, drop the refused credential, ask for a secret, enroll', async () => {
    const { deps, steps, holds } = harness({ connection: { state: 'device-not-authorized' } })
    await expect(reconnectBackgroundService(deps)).resolves.toEqual({ status: 'done' })
    // The enrollment request is written while the daemon is stopped and launches are held,
    // so the daemon that reads it is the one this reconnect starts (A6).
    expect(steps).toEqual(['connection', 'prepare', 'confirm:reconnect:null', 'hold', 'stop:4242:held=1', 'discard', 'request', 'release', 'reconnect'])
    expect(holds()).toBe(0)
  })

  it('asks for a secret also when no daemon was running to stop', async () => {
    const { deps, steps } = harness({ connection: { state: 'device-not-authorized' }, prepared: { status: 'not-running' } })
    await expect(reconnectBackgroundService(deps)).resolves.toEqual({ status: 'done' })
    expect(steps).toEqual(['connection', 'prepare', 'confirm:reconnect:null', 'hold', 'discard', 'request', 'release', 'reconnect'])
  })

  it('does nothing without consent and keeps the stored credential', async () => {
    const { deps, steps } = harness({ connection: { state: 'device-not-authorized' }, answer: false })
    await expect(reconnectBackgroundService(deps)).resolves.toEqual({ status: 'cancelled' })
    // Nothing was stopped, discarded or requested.
    expect(steps).toEqual(['connection', 'prepare', 'confirm:reconnect:null'])
  })

  it('is never offered while the grant is valid', async () => {
    const { deps, steps } = harness({ connection: { state: 'ready' } })
    await expect(reconnectBackgroundService(deps)).resolves.toMatchObject({ status: 'failed', reason: 'daemon_device_authorized' })
    expect(steps).toEqual(['connection'])
  })

  it('keeps the credential when the stop is refused', async () => {
    const { deps, steps, holds } = harness({ connection: { state: 'device-not-authorized' }, stopped: { status: 'refused', reason: 'identity-changed' } })
    await expect(reconnectBackgroundService(deps)).resolves.toMatchObject({ status: 'failed', reason: 'identity-changed' })
    expect(steps).not.toContain('discard')
    expect(steps).not.toContain('request')
    expect(steps).not.toContain('reconnect')
    expect(holds()).toBe(0)
  })
})

describe('confirmation copy', () => {
  it('names the consequence for active and unknown runs', () => {
    expect(confirmPrompt('restart', 2).detail).toContain('2 个正在运行的任务')
    for (const action of ['restart', 'quit', 'reconnect'] as const) {
      const prompt = confirmPrompt(action, null)
      expect(prompt.detail).toContain('failed(host_restarted)')
      expect(prompt.detail).toContain('无法确认')
      // The safe answer is the default: Enter or Escape cancels.
      expect(prompt.defaultId).toBe(prompt.cancelId)
      expect(prompt.buttons[prompt.cancelId]).toBe('取消')
    }
  })
})
