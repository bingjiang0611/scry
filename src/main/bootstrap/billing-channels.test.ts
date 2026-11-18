import { describe, expect, it, vi } from 'vitest'
import { billingChannelHandlers } from './billing-channels'

// The billing table main registers and the daemon serves. The billing functions are
// injected here: no test may reach a real admin API.

describe('billing channels', () => {
  it('warms the shell environment, where the admin keys come from, before each call', async () => {
    const order: string[] = []
    const deps = {
      warmShellEnv: vi.fn(async () => { order.push('env') }),
      billingStateQuery: vi.fn(() => { order.push('state'); return { state: 1 } }),
      syncBillingAdmin: vi.fn(async () => { order.push('sync'); return { ok: true } }),
      importBillingFixture: vi.fn(() => { order.push('fixture'); return { ok: true, fixture: 'f' } })
    }
    const table = billingChannelHandlers(deps)
    await expect(table['agent:billingState']()).resolves.toEqual({ state: 1 })
    await expect(table['agent:syncBillingAdmin']()).resolves.toEqual({ ok: true })
    await expect(table['agent:importBillingFixture']()).resolves.toEqual({ ok: true, fixture: 'f' })
    expect(order).toEqual(['env', 'state', 'env', 'sync', 'env', 'fixture'])
  })
})
