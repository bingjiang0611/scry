import { describe, expect, it } from 'vitest'
import { boundMarker } from './daemon-run-evidence'

const marker = (scryRunId: string) => JSON.stringify({ event: 'bound', ledgerRunId: 'ledger-1', scryRunId, cwd: '/w', providerId: 'codex' })

describe('bind marker', () => {
  it('accepts the canonical ids the daemon mints for runs it dispatches', () => {
    expect(boundMarker(marker('remote-run-mw6osn9o-0'))?.scryRunId).toBe('remote-run-mw6osn9o-0')
    expect(boundMarker(marker('run-mw6osn9o-12'))?.scryRunId).toBe('run-mw6osn9o-12')
  })

  it('accepts a conversation run, whose canonical id is the conversation turn run id', () => {
    // The in-process App already runs conversation turns under this UUID; a daemon send
    // keeps it, so a window that refused the shape would never bind the run.
    const turn = '3f2b8c1d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
    expect(boundMarker(marker(turn))).toMatchObject({ scryRunId: turn, ledgerRunId: 'ledger-1', cwd: '/w' })
  })

  it('refuses anything else as a run id', () => {
    for (const id of ['', '../etc', 'run-', 'not a run', `${'a'.repeat(200)}`]) expect(boundMarker(marker(id))).toBeUndefined()
    expect(boundMarker('{"event":"started"}')).toBeUndefined()
    expect(boundMarker('not json')).toBeUndefined()
  })
})
