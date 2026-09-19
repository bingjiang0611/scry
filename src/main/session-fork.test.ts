import { describe, expect, it } from 'vitest'
import type { TraceArchive, TraceArchiveTurn } from './transcript-archive'
import { verifyForkArchiveBoundary } from './session-fork'

const archivedTurn = (runId: string, providerTurnId: string): TraceArchiveTurn => ({
  runId,
  providerTurnId,
  forkTurnId: providerTurnId,
  userText: runId,
  attachments: [],
  items: [],
  done: true,
  status: 'completed',
  ts: 1
})

const archive: TraceArchive = {
  version: 1,
  providerId: 'codex',
  runtimeProvider: 'codex_cli',
  cwd: '/repo',
  sessionId: 'thread-source',
  turns: [
    archivedTurn('run-1', 'turn-1'),
    archivedTurn('run-2', 'turn-2'),
    archivedTurn('run-3', 'turn-3')
  ]
}

describe('selected-turn session fork boundary', () => {
  it('returns the archive prefix through the selected turn', () => {
    const verified = verifyForkArchiveBoundary(archive, {
      sourceRunId: 'run-2',
      sourceProviderTurnId: 'turn-2',
      sourceForkTurnId: 'turn-2'
    })

    expect(verified.sourceIndex).toBe(1)
    expect(verified.prefix.map((turn) => turn.runId)).toEqual(['run-1', 'run-2'])
  })

  it('rejects stale renderer boundaries instead of forking a different turn', () => {
    expect(() => verifyForkArchiveBoundary(archive, {
      sourceRunId: 'run-2',
      sourceProviderTurnId: 'turn-3',
      sourceForkTurnId: 'turn-3'
    })).toThrow('轮次边界已变化')
  })

  it('accepts a settled provider failure as a recoverable branch boundary', () => {
    const failed = {
      ...archive,
      turns: [{ ...archive.turns[0], status: 'failed' as const }]
    }
    const verified = verifyForkArchiveBoundary(failed, {
      sourceRunId: 'run-1',
      sourceProviderTurnId: 'turn-1',
      sourceForkTurnId: 'turn-1'
    })

    expect(verified.source.status).toBe('failed')
    expect(verified.prefix).toHaveLength(1)
  })

  it('rejects incomplete source turns', () => {
    const incomplete = {
      ...archive,
      turns: [{ ...archive.turns[0], done: false, status: 'interrupted' as const }]
    }
    expect(() => verifyForkArchiveBoundary(incomplete, {
      sourceRunId: 'run-1',
      sourceProviderTurnId: 'turn-1',
      sourceForkTurnId: 'turn-1'
    })).toThrow('已结束轮次')
  })
})
