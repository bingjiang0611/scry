import { afterEach, expect, it, vi } from 'vitest'
const effects = vi.hoisted(() => ({ current: undefined as (() => void | (() => void)) | undefined }))
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void)) => { effects.current = effect } }))
import { useLegacyDiffPreviewDemand } from './useLegacyDiffPreviewDemand'
afterEach(() => { vi.unstubAllGlobals(); effects.current = undefined })
it('notifies demand on visibility and releases the exact run on cleanup, without focusing or adopting it', async () => {
  let visibility = 'visible'
  const document = new EventTarget()
  Object.defineProperty(document, 'visibilityState', { get: () => visibility })
  const send = vi.fn(async (_runId: string, _demanded: boolean) => true)
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', { scry: { setLegacyDiffPreviewDemand: send } })
  useLegacyDiffPreviewDemand('run-first', true)
  const cleanup = effects.current!()
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  cleanup?.()
  document.dispatchEvent(new Event('visibilitychange'))
  await Promise.resolve()
  expect(send.mock.calls).toEqual([['run-first', true], ['run-first', false], ['run-first', true], ['run-first', false]])
})
it('does not demand a mounted but hidden pane or a historical turn without a live run', () => {
  useLegacyDiffPreviewDemand('run-hidden', false)
  expect(effects.current!()).toBeUndefined()
  useLegacyDiffPreviewDemand(null, true)
  expect(effects.current!()).toBeUndefined()
})
