import { describe, expect, it } from 'vitest'
import { parseSubscribeFrame } from './subscribe-frame'

const request = (extra: Record<string, unknown>) => ({
  op: 'subscribe',
  views: ['detail'],
  session: { sessionKey: 'native-1' },
  waitMs: 0,
  ...extra
})

// D6: the cursor continues a bounded detail page. It must reach the host, and a malformed or
// out-of-place cursor must be rejected rather than silently dropped (which would repeat page one).

describe('D6: detail cursor on the subscribe frame', () => {
  it('passes a well-formed cursor through', () => {
    expect(parseSubscribeFrame(request({ detailCursor: 'd6:42' }), 'network')).toMatchObject({ detailCursor: 'd6:42' })
  })

  it('rejects a cursor the host could not have issued', () => {
    expect(parseSubscribeFrame(request({ detailCursor: '42' }), 'network')).toBeUndefined()
    expect(parseSubscribeFrame(request({ detailCursor: 'd6:-1' }), 'network')).toBeUndefined()
    expect(parseSubscribeFrame(request({ detailCursor: 'd6:1e9' }), 'network')).toBeUndefined()
  })

  it('rejects a cursor sent without a detail view', () => {
    const base = { op: 'subscribe', views: ['sessions'], known: { hostId: 'h', logId: 'l', seq: 1 }, waitMs: 0 }
    expect(parseSubscribeFrame({ ...base, detailCursor: 'd6:1' }, 'network')).toBeUndefined()
  })
})
