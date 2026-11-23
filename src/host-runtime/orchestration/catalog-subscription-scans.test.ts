import { afterEach, expect, it, vi } from 'vitest'
import { CatalogSubscriptionScans } from './catalog-subscription-scans'

afterEach(() => vi.useRealTimers())

it('scans when sessions open or reconnect and carries the 30-second deadline across polls', async () => {
  vi.useFakeTimers()
  const scanCatalog = vi.fn(async () => {})
  const scanDetail = vi.fn(async () => {})
  const scans = new CatalogSubscriptionScans({ scanCatalog, scanDetail, onError: (error) => { throw error } })

  const closeInitial = scans.sessions(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(scanCatalog).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(25_000)
  expect(scanCatalog).toHaveBeenCalledTimes(1)
  closeInitial()

  const closePoll = scans.sessions(false)
  await vi.advanceTimersByTimeAsync(4_999)
  expect(scanCatalog).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(scanCatalog).toHaveBeenCalledTimes(2)
  closePoll()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(scanCatalog).toHaveBeenCalledTimes(2)

  const closeReconnect = scans.sessions(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(scanCatalog).toHaveBeenCalledTimes(3)
  expect(scanDetail).not.toHaveBeenCalled()
  closeReconnect()
})

it('scans the requested detail on open and ticks only subscribed keys', async () => {
  vi.useFakeTimers()
  const scanCatalog = vi.fn(async () => {})
  const scanDetail = vi.fn(async (_key: string, _opening: boolean) => {})
  const scans = new CatalogSubscriptionScans({ scanCatalog, scanDetail, onError: (error) => { throw error } })

  const close = scans.detail('会话 A', true)
  await vi.advanceTimersByTimeAsync(0)
  expect(scanDetail.mock.calls).toEqual([['会话 A', true]])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(scanDetail.mock.calls).toEqual([['会话 A', true], ['会话 A', false]])

  const closeSecond = scans.detail('会话 B', true)
  await vi.advanceTimersByTimeAsync(0)
  expect(scanDetail.mock.calls.at(-1)).toEqual(['会话 B', true])
  close()
  await vi.advanceTimersByTimeAsync(4_000)
  expect(scanDetail.mock.calls.slice(3)).toEqual([['会话 B', false], ['会话 B', false]])
  closeSecond()
  await vi.advanceTimersByTimeAsync(4_000)
  expect(scanDetail).toHaveBeenCalledTimes(5)
  expect(scanCatalog).not.toHaveBeenCalled()
})

it('keeps the detail deadline across replies that finish before the next scan', async () => {
  vi.useFakeTimers()
  const scanDetail = vi.fn(async (_key: string, _opening: boolean) => {})
  const scans = new CatalogSubscriptionScans({
    scanCatalog: async () => {}, scanDetail, onError: (error) => { throw error }
  })
  const closeOpening = scans.detail('session', true)
  await vi.advanceTimersByTimeAsync(1_500)
  closeOpening()
  const closePoll = scans.detail('session', false)
  await vi.advanceTimersByTimeAsync(500)
  expect(scanDetail.mock.calls).toEqual([['session', true], ['session', false]])
  closePoll()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(scanDetail).toHaveBeenCalledTimes(2)
})
