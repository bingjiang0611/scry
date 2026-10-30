import { afterEach, expect, it, vi } from 'vitest'
import { RunDiffPreviewer } from './run-diff-previewer'
import type { GitTurnDiffCapture } from './git'
import type { TurnDiffSnapshot } from '../shared/trace'

const capture: GitTurnDiffCapture = { status: 'ready', beforeAt: 'before', captureMs: 0, beforeTree: 'tree', repoRoot: '/repo', scope: '.', tempDir: '/scratch', objectDir: '/scratch/objects' }
const snapshot = (afterAt = 'fresh'): TurnDiffSnapshot => ({ version: 1, status: 'captured', beforeAt: 'before', afterAt, files: [], captureMs: 1, cleanup: 'ok' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(before = Promise.resolve(capture), read = vi.fn(async () => snapshot())) {
  const emit = vi.fn()
  const previewer = new RunDiffPreviewer({ runId: 'run', turnCapture: before, sessionCapture: null, hints: () => ({}), preview: read, emit })
  return { previewer, read, emit }
}
afterEach(() => vi.useRealTimers())

it('does no background previews, then refreshes observed changes on demand without another write', async () => {
  const f = fixture()
  await f.previewer.setDemanded(false)
  await f.previewer.notifyChange()
  await f.previewer.notifyChange()
  expect(f.read).not.toHaveBeenCalled()
  await f.previewer.setDemanded(true)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.emit.mock.calls[0][0].snapshot.afterAt).toBe('fresh')
  await f.previewer.setDemanded(true)
  expect(f.read).toHaveBeenCalledTimes(1)
  f.previewer.sealAll()
  await f.previewer.idle()
})

it('does not create an empty read just because the first viewer attaches before any write', async () => {
  const f = fixture()
  await f.previewer.setDemanded(false)
  await f.previewer.setDemanded(true)
  expect(f.read).not.toHaveBeenCalled()
  await f.previewer.notifyChange()
  expect(f.read).toHaveBeenCalledTimes(1)
})

it('cancels a throttled trailing read while hidden and bypasses its old interval on return', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.previewer.notifyChange()
  await f.previewer.notifyChange()
  expect(vi.getTimerCount()).toBe(1)
  await f.previewer.setDemanded(false)
  expect(vi.getTimerCount()).toBe(0)
  await f.previewer.idle()
  await f.previewer.setDemanded(true)
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start Git after a paused baseline promise resolves', async () => {
  const before = deferred<GitTurnDiffCapture>()
  const f = fixture(before.promise)
  const pending = f.previewer.notifyChange()
  await f.previewer.setDemanded(false)
  before.resolve(capture)
  await pending
  expect(f.read).not.toHaveBeenCalled()
})

it('finishes owned in-flight work but discards its old epoch and serially refreshes on return', async () => {
  vi.useFakeTimers()
  const old = deferred<TurnDiffSnapshot>()
  const read = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(snapshot())
  const f = fixture(Promise.resolve(capture), read)
  const first = f.previewer.notifyChange()
  await Promise.resolve()
  await Promise.resolve()
  expect(read).toHaveBeenCalledTimes(1)
  await f.previewer.setDemanded(false)
  const returned = f.previewer.setDemanded(true)
  expect(read).toHaveBeenCalledTimes(1)
  old.resolve(snapshot('obsolete'))
  await Promise.all([first, returned])
  expect(read).toHaveBeenCalledTimes(2)
  expect(f.emit.mock.calls.map(([event]) => event.snapshot.afterAt)).toEqual(['fresh'])
  expect(vi.getTimerCount()).toBe(0)
})

it('cannot restart a terminally sealed scope on a late view attachment', async () => {
  const f = fixture()
  await f.previewer.setDemanded(false)
  await f.previewer.notifyChange()
  f.previewer.sealAll()
  await f.previewer.setDemanded(true)
  await f.previewer.idle()
  expect(f.read).not.toHaveBeenCalled()
  expect(f.emit).not.toHaveBeenCalled()
})
