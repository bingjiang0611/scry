import { describe, expect, it } from 'vitest'
import { runSemantics } from './run-frontdoor'

// The two facts the pipeline needs must not be one boolean. `isRemoteRun` is about how
// the run arrived (ledger/transport); `appSemantics` is about who submitted it. The
// default has to be conservative: an unproven scope is never the App's.
describe('run semantics (L3: two flags, fail closed on an unproven scope)', () => {
  it('treats an in-process call as the App', () => {
    expect(runSemantics({})).toEqual({ isRemoteRun: false, appSemantics: true })
    expect(runSemantics({ origin: 'local' })).toEqual({ isRemoteRun: false, appSemantics: true })
    // A local call cannot claim a scope it does not have; it is still the App.
    expect(runSemantics({ origin: 'local', grantScope: 'remote' })).toEqual({ isRemoteRun: false, appSemantics: true })
  })

  it('gives a submitted run the App path only when the verified grant is local', () => {
    expect(runSemantics({ origin: 'remote', grantScope: 'local' })).toEqual({ isRemoteRun: true, appSemantics: true })
    expect(runSemantics({ origin: 'remote', grantScope: 'remote' })).toEqual({ isRemoteRun: true, appSemantics: false })
  })

  it('fails closed when a submitted run carries no verified scope', () => {
    // A run recovered after a restart, or any future caller that forgets to pass the
    // scope, must not silently gain the App's semantics (full_access, empty cwd,
    // unarchived delete). Unknown is the stricter side.
    expect(runSemantics({ origin: 'remote' })).toEqual({ isRemoteRun: true, appSemantics: false })
  })
})
