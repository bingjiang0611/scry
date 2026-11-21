import { describe, expect, it } from 'vitest'
import { noteWatchEvents, type RunCursor } from './daemon-run-cursor'

// The bind markers a run's watch reads. A workspace start runs in the directory it
// prepared, and the daemon re-announces the run there once it is registered; the window
// must read the run where it runs, while other runs' markers never move this cursor.

const cursor = (): RunCursor => ({
  runId: 'ledger-run-1', context: { cwd: '/source', providerId: 'claude' }, lifecycle: 'recorded',
  watch: 0, output: 0, pushed: [], askedQuestions: new Set(), answerIds: new Map(),
  resyncRequired: false, pumping: false, stopped: false, sawText: false
} as unknown as RunCursor)

const bound = (fields: Record<string, unknown>) => ({
  runId: 'ledger-run-1', kind: 'run_progress', detail: JSON.stringify({ event: 'bound', scryRunId: 'remote-run-abc-1', providerId: 'claude', ...fields })
})

describe('daemon run cursor binds', () => {
  it('follows the run into the workspace it was re-announced in', () => {
    const value = cursor()
    noteWatchEvents(value, [bound({ ledgerRunId: 'ledger-run-1', cwd: '/source' }), bound({ ledgerRunId: 'ledger-run-1', cwd: '/managed/worktree' })])
    expect(value.scryRunId).toBe('remote-run-abc-1')
    expect(value.context).toEqual({ cwd: '/managed/worktree', providerId: 'claude' })
  })

  it('keeps its directory for a marker that does not name this ledger run', () => {
    const value = cursor()
    noteWatchEvents(value, [bound({ cwd: '/elsewhere' }), bound({ ledgerRunId: 'ledger-run-2', cwd: '/other' })])
    expect(value.context?.cwd).toBe('/source')
  })
})
