import { describe, expect, it } from 'vitest'
import { isLocalFullRead } from './daemon-client'

describe('App full-document reads on its own daemon', () => {
  it('takes the local history lane for history pages and a conversation own reads', () => {
    expect(isLocalFullRead({ op: 'sessionHistory' })).toBe(true)
    for (const method of ['read', 'readItem', 'readSideChatSnapshot', 'preview', 'previewSideChat'])
      expect(isLocalFullRead({ op: 'conversation', method, args: [] })).toBe(true)
  })

  it('keeps conversation writes and every other op on their bounded lanes', () => {
    for (const method of ['send', 'create', 'update', 'delete', 'list'])
      expect(isLocalFullRead({ op: 'conversation', method })).toBe(false)
    expect(isLocalFullRead({ op: 'desktop', query: { kind: 'history' } })).toBe(false)
    expect(isLocalFullRead(null)).toBe(false)
  })
})
