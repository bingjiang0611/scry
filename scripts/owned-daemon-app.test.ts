import { expect, it, vi } from 'vitest'
import { stopOwnedDaemonApp } from './owned-daemon-app.mjs'

it('leaves verified daemon processes to their supervisor and waits for both cleanups', async () => {
  const userData = '/tmp/isolated/userData'
  const child = { pid: 100 }
  const tree = [{ pid: 101 }, { pid: 102 }]
  const scan = vi.fn(() => tree)
  const closeApp = vi.fn(async () => ({ tracked: 1 }))
  const closeDaemon = vi.fn(async () => ({ remaining: [] }))
  await expect(stopOwnedDaemonApp(child, userData, { scan, closeApp, closeDaemon }))
    .resolves.toEqual({ tracked: 1, daemon: { remaining: [] } })
  expect(closeApp).toHaveBeenCalledWith(child, { exclude: [101, 102] })
  expect(closeDaemon).toHaveBeenCalledWith(userData, tree)
  expect(closeApp.mock.invocationCallOrder[0]).toBeLessThan(closeDaemon.mock.invocationCallOrder[0])
})

it('attempts both owned cleanups and retains their failures if scanning also failed', async () => {
  const scanError = new Error('daemon process listing unavailable')
  const appError = new Error('App stop unavailable')
  const daemonError = new Error('daemon stop unavailable')
  const scan = vi.fn(() => { throw scanError })
  const closeApp = vi.fn(async () => { throw appError })
  const closeDaemon = vi.fn(async () => { throw daemonError })
  await expect(stopOwnedDaemonApp({ pid: 100 }, '/tmp/isolated/userData', { scan, closeApp, closeDaemon }))
    .rejects.toMatchObject({ errors: [scanError, appError, daemonError] })
  expect(closeApp).toHaveBeenCalledTimes(1)
  expect(closeDaemon).toHaveBeenCalledTimes(1)
})
