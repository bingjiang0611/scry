import { describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from './clipboard-text'

describe('text-only clipboard operation', () => {
  it('writes exact text once and confirms only after the write', () => {
    const clipboard = { writeText: vi.fn() }
    const text = '  literal <script>\n\n中文\n'
    expect(writeClipboardText(text, clipboard)).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(text)
  })

  it.each([
    { label: 'null', text: null },
    { label: 'object', text: {} },
    { label: 'number', text: 1 },
    { label: 'empty', text: '' },
    { label: 'oversized', text: 'a'.repeat(1_000_001) }
  ])('rejects $label payloads before writing', ({ text }) => {
    const clipboard = { writeText: vi.fn() }
    expect(() => writeClipboardText(text, clipboard)).toThrow('复制内容')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('does not turn a native write failure into success', () => {
    expect(() => writeClipboardText('text', { writeText: () => { throw new Error('native failure') } })).toThrow('native failure')
  })
})
