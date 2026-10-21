import { describe, expect, it, vi } from 'vitest'
import { createInFlightDeduper } from './provider-discovery'

describe('selected Provider discovery', () => {
  it('deduplicates the same context while allowing independent contexts', async () => {
    const deduper = createInFlightDeduper<string>()
    let resolve!: (value: string) => void
    const operation = vi.fn(() => new Promise<string>((done) => { resolve = done }))
    const first = deduper.load('claude\0/workspace', operation)
    const second = deduper.load('claude\0/workspace', operation)
    expect(first).toBe(second)
    expect(operation).toHaveBeenCalledOnce()
    expect(deduper.size()).toBe(1)
    const other = deduper.load('codex\0/workspace', async () => 'codex')
    await expect(other).resolves.toBe('codex')
    resolve('claude')
    await expect(first).resolves.toBe('claude')
    expect(deduper.size()).toBe(0)
  })

  it('does not retain failed or completed capabilities as a cache', async () => {
    const deduper = createInFlightDeduper<string>()
    await expect(deduper.load('pi\0/profile\0/workspace', async () => { throw new Error('probe failed') })).rejects.toThrow('probe failed')
    expect(deduper.size()).toBe(0)
    await expect(deduper.load('pi\0/profile\0/workspace', async () => 'reloaded')).resolves.toBe('reloaded')
  })
})
