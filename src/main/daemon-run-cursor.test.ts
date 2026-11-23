import { describe, expect, it } from 'vitest'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { announceRun } from './daemon-run-subscription.fixtures'

const RUN = 'ledger-run-1'
const CANONICAL = 'remote-run-abc-1'

function fixture() {
  const reads: unknown[] = []
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(async (payload) => {
      reads.push(payload.query)
      return { desktop: { kind: 'trace', run: null } }
    }),
    send: () => undefined
  })
  return { runtime, reads }
}

describe('a binding hint names the directory and run to read', () => {
  it('follows the run into the workspace it was re-announced in', async () => {
    const { runtime, reads } = fixture()
    await announceRun(runtime, RUN, { scryRunId: CANONICAL, cwd: '/source' })
    await announceRun(runtime, RUN, { scryRunId: CANONICAL, cwd: '/managed/worktree', outputSeq: 2 })
    expect(reads).toEqual([
      expect.objectContaining({ runId: CANONICAL, context: { cwd: '/source', providerId: 'codex' } }),
      expect.objectContaining({ runId: CANONICAL, context: { cwd: '/managed/worktree', providerId: 'codex' } })
    ])
  })

  it('keeps one run’s directory when another run binds elsewhere', async () => {
    const { runtime, reads } = fixture()
    await announceRun(runtime, RUN, { scryRunId: CANONICAL, cwd: '/source' })
    await announceRun(runtime, 'ledger-run-2', { scryRunId: 'remote-run-abc-2', cwd: '/other' })
    await runtime.deliverAfterRead(RUN, () => undefined)
    expect(reads.at(-1)).toMatchObject({ runId: CANONICAL, context: { cwd: '/source', providerId: 'codex' } })
  })
})
