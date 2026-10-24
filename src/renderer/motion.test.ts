import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MOTION, prefersReducedMotion, subscribeReducedMotion } from './motion'

const css = readFileSync(fileURLToPath(new URL('./motion.css', import.meta.url)), 'utf8')

function cssValue(name: string): string {
  return css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? ''
}

describe('motion tokens', () => {
  it('keeps CSS and TypeScript token values aligned', () => {
    expect(MOTION).toEqual({
      durMicro: 100,
      durFast: 160,
      durBase: 220,
      durSlow: 300,
      easeOut: 'cubic-bezier(0.23, 1, 0.32, 1)',
      easeStruct: 'cubic-bezier(0.32, 0.72, 0, 1)',
      easeExit: 'cubic-bezier(0.4, 0, 1, 1)'
    })
    expect(cssValue('--dur-micro')).toBe(`${MOTION.durMicro}ms`)
    expect(cssValue('--dur-fast')).toBe(`${MOTION.durFast}ms`)
    expect(cssValue('--dur-base')).toBe(`${MOTION.durBase}ms`)
    expect(cssValue('--dur-slow')).toBe(`${MOTION.durSlow}ms`)
    expect(cssValue('--ease-out')).toBe(MOTION.easeOut)
    expect(cssValue('--ease-struct')).toBe(MOTION.easeStruct)
    expect(cssValue('--ease-exit')).toBe(MOTION.easeExit)
  })

  it('tracks live reduced-motion media changes and unsubscribes', () => {
    let matches = false
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    const media = {
      get matches() { return matches },
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { listener = callback },
      removeEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { if (listener === callback) listener = undefined }
    } as unknown as MediaQueryList
    vi.stubGlobal('window', { matchMedia: vi.fn(() => media) })
    try {
      expect(prefersReducedMotion()).toBe(false)
      const changed = vi.fn()
      const unsubscribe = subscribeReducedMotion(changed)
      matches = true
      listener?.({ matches: true, media: media.media } as MediaQueryListEvent)
      expect(prefersReducedMotion()).toBe(true)
      expect(changed).toHaveBeenCalledExactlyOnceWith(true)
      unsubscribe()
      matches = false
      listener?.({ matches: false, media: media.media } as MediaQueryListEvent)
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
