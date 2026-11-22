import { expect, it } from 'vitest'
import { SubscribeHub } from './subscribe-hub'

it('bounds each device cursor family independently and keeps the local App cursor', () => {
  const hub = new SubscribeHub()
  const local = 'a'.repeat(64)
  const quietDevice = 'b'.repeat(64)
  const forwardingDevice = 'c'.repeat(64)
  const cursor = (index: number) => `${forwardingDevice}:${index.toString(16).padStart(32, '0')}`
  const notice = { id: 'earlier-notice', kind: 'cli_approval_enabled' as const, ts: 1 }
  try {
    hub.emitHostNotice(notice)
    expect(hub.drainHints(local, false, false, true)).toEqual([{ kind: 'hostNotice', notice }])
    expect(hub.drainHints(quietDevice, false)).toEqual([{ kind: 'hostNotice', notice }])
    for (let index = 0; index <= 512; index++) hub.drainHints(cursor(index), false)
    expect.soft(hub.hasPendingHints(local, true)).toBe(false)
    expect.soft(hub.hasPendingHints(quietDevice)).toBe(false)
    expect.soft(hub.hasPendingHints(cursor(0))).toBe(true)
    expect(hub.hasPendingHints(cursor(1))).toBe(false)
  } finally {
    hub.close()
  }
})
