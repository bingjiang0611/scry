import { describe, expect, it } from 'vitest'
import type { DesktopRemoteCatalog, RemoteSessionRef } from '../../shared/desktop-remote'
import { createRemoteAttentionTracker } from './remote-attention'

const context = { cwd: '/repo', providerId: 'pi', externalSessionId: 's1' }
function catalog(sessions: RemoteSessionRef[]): Pick<DesktopRemoteCatalog, 'sessions'> {
  return { sessions }
}
const session = (overrides: Partial<RemoteSessionRef> = {}): RemoteSessionRef => ({
  sessionId: 'session-1', externalSessionId: 's1', providerId: 'pi', cwd: '/repo',
  label: 'session', ts: 1, ...overrides
})

describe('remote attention tracking for the Dock badge', () => {
  it('baselines before connection, announces a new terminal run, and clears it once opened', () => {
    const published: string[][] = []
    const tracker = createRemoteAttentionTracker((keys) => published.push([...keys]))

    tracker.baseline('conn', [session({ lastRunId: 'run-1', lastRunOutcome: 'completed' })])
    expect(published.at(-1)).toEqual([])

    expect(tracker.catalog('conn', catalog([session({ lastRunId: 'run-2', lastRunOutcome: 'completed' })]))).toHaveLength(1)
    expect(published.at(-1)).toHaveLength(1)

    tracker.viewed('conn', context)
    expect(published.at(-1)).toEqual([])
  })

  it('does not announce an active run or an already announced one again', () => {
    const published: string[][] = []
    const tracker = createRemoteAttentionTracker((keys) => published.push([...keys]))
    tracker.baseline('conn', [session({ isActive: true, lastRunId: 'run-1' })])
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-1', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toHaveLength(1)
    tracker.viewed('conn', context)
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-1', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toEqual([])
    tracker.viewed('conn', null)
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-2', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toHaveLength(1)
  })

  it('drops every key for a disconnected host', () => {
    const published: string[][] = []
    const tracker = createRemoteAttentionTracker((keys) => published.push([...keys]))
    tracker.baseline('conn', [session({ lastRunId: 'run-1', lastRunOutcome: 'failed' })])
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-2', lastRunOutcome: 'failed' })]))
    expect(published.at(-1)).toHaveLength(1)
    tracker.disconnect('conn')
    expect(published.at(-1)).toEqual([])
    tracker.baseline('conn', [session({ lastRunId: 'run-2', lastRunOutcome: 'failed' })])
    expect(published.at(-1)).toHaveLength(1)
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-3', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toHaveLength(1)
    tracker.forget('conn')
    expect(published.at(-1)).toEqual([])
  })
})
