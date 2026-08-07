import { describe, expect, it } from 'vitest'
import { ProviderOperationGate } from './provider-operation-gate'

describe('ProviderOperationGate', () => {
  it('serializes MCP authentication globally for one Provider', () => {
    const gate = new ProviderOperationGate()
    const first = gate.acquireAuthentication('opencode')
    expect(first.ok).toBe(true)
    expect(gate.acquireAuthentication('opencode')).toEqual({
      ok: false,
      blockedBy: 'authentication'
    })
    if (first.ok) first.release()
    expect(gate.acquireAuthentication('opencode').ok).toBe(true)
  })

  it('blocks run start during authentication and authentication during every queued start', () => {
    const gate = new ProviderOperationGate()
    const auth = gate.acquireAuthentication('qoder')
    expect(auth.ok).toBe(true)
    expect(gate.acquireOperation('qoder')).toEqual({ ok: false, blockedBy: 'authentication' })
    if (auth.ok) auth.release()

    const firstStart = gate.acquireOperation('qoder')
    const secondStart = gate.acquireOperation('qoder')
    expect(firstStart.ok).toBe(true)
    expect(secondStart.ok).toBe(true)
    expect(gate.acquireAuthentication('qoder')).toEqual({ ok: false, blockedBy: 'operation' })
    if (firstStart.ok) firstStart.release()
    expect(gate.acquireAuthentication('qoder')).toEqual({ ok: false, blockedBy: 'operation' })
    if (secondStart.ok) secondStart.release()
    expect(gate.acquireAuthentication('qoder').ok).toBe(true)
  })
})
