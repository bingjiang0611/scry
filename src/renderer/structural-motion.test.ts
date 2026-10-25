import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelStructuralMotion, runStructuralTransition } from './structural-motion'

const flush = vi.hoisted(() => ({ active: false }))
vi.mock('react-dom', () => ({ flushSync: vi.fn((commit: () => void) => {
  flush.active = true
  try { commit() } finally { flush.active = false }
}) }))

function fixture(reduced = false) {
  const frames: Keyframe[][] = []
  const timings: KeyframeAnimationOptions[] = []
  const animations: Array<{ id: string; cancel: ReturnType<typeof vi.fn>; finished: Promise<void>; finish: () => void }> = []
  const media = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const page = {
    getClientRects: () => [{}],
    animate: (keyframes: Keyframe[], timing: KeyframeAnimationOptions) => {
      let finish!: () => void
      const animation = { id: '', finished: new Promise<void>(resolve => { finish = resolve }), cancel: vi.fn(), finish: () => finish() }
      frames.push(keyframes); timings.push(timing); animations.push(animation)
      return animation
    }
  }
  vi.stubGlobal('Element', class { animate() {} })
  vi.stubGlobal('document', { hidden: false, querySelectorAll: () => [page] })
  vi.stubGlobal('window', { matchMedia: () => media })
  return { frames, timings, animations, media }
}

afterEach(() => { cancelStructuralMotion(); vi.unstubAllGlobals() })

describe('live structural motion', () => {
  it.each(['no document', 'hidden', 'no animate'])('commits inside flushSync with %s and does not animate', mode => {
    const f = fixture()
    if (mode === 'no document') vi.stubGlobal('document', undefined)
    if (mode === 'hidden') vi.stubGlobal('document', { hidden: true })
    if (mode === 'no animate') vi.stubGlobal('Element', class {})
    const commit = vi.fn(() => { expect(flush.active).toBe(true) })
    runStructuralTransition('page', commit)
    expect(commit).toHaveBeenCalledOnce()
    expect(f.animations).toHaveLength(0)
  })
  it('commits before animating live content and propagates the exact error synchronously', () => {
    const f = fixture()
    const error = new Error('commit failure')
    expect(() => runStructuralTransition('page', () => { throw error })).toThrow(error)
    expect(f.animations).toHaveLength(0)
    let committed = false
    runStructuralTransition('page', () => { expect(flush.active).toBe(true); committed = true })
    expect(committed).toBe(true)
    expect(f.timings[0].duration).toBe(240)
    expect(f.frames[0][0].transform).toBe('translateY(6px)')
  })
  it('cancels the previous animation without undoing either commit; theme is immediate', () => {
    const f = fixture()
    const commits: string[] = []
    runStructuralTransition('page', () => { commits.push('page') })
    runStructuralTransition('session', () => { commits.push('session') })
    expect(f.animations[0].cancel).toHaveBeenCalledOnce()
    expect(f.media.removeEventListener).toHaveBeenCalledOnce()
    expect(f.timings[1].duration).toBe(180)
    expect(f.frames[1]).toEqual([{ opacity: 0 }, { opacity: 1 }])
    runStructuralTransition('theme', () => { commits.push('theme') })
    expect(f.animations).toHaveLength(2)
    expect(commits).toEqual(['page', 'session', 'theme'])
  })
  it('cancels immediately when the system switches to reduced motion', () => {
    const f = fixture()
    runStructuralTransition('page', () => {})
    f.media.matches = true
    const change = f.media.addEventListener.mock.calls[0][1]
    change()
    expect(f.animations[0].cancel).toHaveBeenCalledOnce()
    expect(f.media.removeEventListener).toHaveBeenCalledOnce()
  })
  it('uses only 120ms linear opacity under reduced motion and cleans up after finish', async () => {
    const f = fixture(true)
    runStructuralTransition('page', () => {})
    expect(f.frames[0]).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(f.timings[0]).toEqual({ duration: 120, easing: 'linear' })
    f.animations[0].finish()
    await f.animations[0].finished
    expect(f.media.removeEventListener).toHaveBeenCalledOnce()
    cancelStructuralMotion()
    expect(f.animations[0].cancel).not.toHaveBeenCalled()
  })
})
