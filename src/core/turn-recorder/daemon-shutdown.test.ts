import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { listenRecorderDaemon, sendRecorderDaemonHook } from './daemon'
import * as recorder from './recorder'
import * as store from './store'

it('close waits for the background summary warmup before releasing the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-daemon-warmup-'))
  const env = { SCRY_RECORDER_SOCKET: join(tmpdir(), `${basename(root)}.sock`) }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'warmup-fixture', capture: { diff: false }
  }))
  let releaseWarmup!: () => void
  const warmup = new Promise<void>(resolve => { releaseWarmup = resolve })
  const summaries = vi.spyOn(store, 'listRecordSummaries').mockImplementation(async () => {
    await warmup
    return []
  })
  const daemon = await listenRecorderDaemon({ workspace: root, env, idleMs: 5_000 })
  try {
    expect(summaries).toHaveBeenCalledOnce()
    let closeFinished = false
    const closing = daemon.close().then(() => { closeFinished = true })
    await daemon.closed
    await expect(vi.waitFor(() => { expect(closeFinished).toBe(true) }, { timeout: 100, interval: 10 }))
      .rejects.toThrow()
    releaseWarmup()
    await closing
    expect(closeFinished).toBe(true)
  } finally {
    releaseWarmup()
    await daemon.close()
    summaries.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('close waits for background hook delivery before releasing the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-daemon-stop-'))
  const env = { SCRY_RECORDER_SOCKET: join(tmpdir(), `${basename(root)}.sock`) }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'shutdown-fixture', capture: { diff: false }
  }))
  let releaseDelivery!: () => void
  let deliveryStarted!: () => void
  const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve })
  const started = new Promise<void>(resolve => { deliveryStarted = resolve })
  let deliveryFinished = false
  vi.spyOn(recorder, 'drainRecorderDelivery').mockImplementation(async () => {
    deliveryStarted()
    await deliveryGate
    deliveryFinished = true
  })
  const daemon = await listenRecorderDaemon({ workspace: root, env, idleMs: 5_000 })
  try {
    await sendRecorderDaemonHook({ workspace: root, provider: 'pi', event: 'UserPromptSubmit',
      payload: { session_id: 'shutdown', prompt: 'fixture' }, env })
    await started
    let closeFinished = false
    const closing = daemon.close().then(() => { closeFinished = true })
    await daemon.closed
    // The socket is closed, but the explicitly held delivery must still own the workspace.
    await expect(vi.waitFor(() => { expect(closeFinished).toBe(true) }, { timeout: 100, interval: 10 }))
      .rejects.toThrow()
    expect(deliveryFinished).toBe(false)
    releaseDelivery()
    await closing
    expect(deliveryFinished).toBe(true)
  } finally {
    releaseDelivery()
    await daemon.close()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
