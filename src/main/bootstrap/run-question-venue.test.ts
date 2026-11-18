import { describe, expect, it } from 'vitest'
import { questionsGoToWindow } from './run-startup'

// A Provider question has exactly one place to be answered, and it is decided by where
// the run executes - not by which grant submitted it. The App answers its own run in the
// window; the daemon has no window, so even a local-grant run asks through the ledger and
// the App that submitted answers from its daemon view.

describe('provider question venue', () => {
  it('asks in the App window when the App runs it', () => {
    expect(questionsGoToWindow({ appSemantics: true, windowCanReceive: true, hasLedgerInput: true })).toBe(true)
  })

  it('asks through the ledger when the run executes in a process with no window', () => {
    // The daemon: local grant, App semantics, no renderer, and a ledger input seam.
    expect(questionsGoToWindow({ appSemantics: true, windowCanReceive: false, hasLedgerInput: true })).toBe(false)
  })

  it('keeps the window as the only option when there is no ledger input at all', () => {
    expect(questionsGoToWindow({ appSemantics: true, windowCanReceive: false, hasLedgerInput: false })).toBe(true)
  })

  it('never routes a device run to the window, whatever the renderer reports', () => {
    // Device semantics travel with the grant, so the owner's window must not answer for
    // a device run even in the App process.
    expect(questionsGoToWindow({ appSemantics: false, windowCanReceive: true, hasLedgerInput: true })).toBe(false)
  })
})
