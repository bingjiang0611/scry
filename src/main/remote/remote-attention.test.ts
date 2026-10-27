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
  it('announces a new terminal remote run and clears it once that session is opened', () => {
    const published: string[][] = []
    const tracker = createRemoteAttentionTracker((keys) => published.push([...keys]))

    // First discovery is a baseline, not thousands of historical results.
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-1', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toEqual([])

    tracker.catalog('conn', catalog([session({ lastRunId: 'run-2', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toHaveLength(1)

    tracker.viewed('conn', context)
    expect(published.at(-1)).toEqual([])
  })

  it('does not announce an active run or an already announced one again', () => {
    const published: string[][] = []
    const tracker = createRemoteAttentionTracker((keys) => published.push([...keys]))
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-1', lastRunOutcome: 'completed' })]))
    // A following run in progress keeps the host's last terminal evidence.
    tracker.catalog('conn', catalog([session({ isActive: true, lastRunId: 'run-1', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toEqual([])
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-1', lastRunOutcome: 'completed' })]))
    expect(published.at(-1)).toEqual([])
  })

  it('drops every key for a disconnected host', () => {
    const published: string[][] = []
    const tracker = createRemoteAttentionTracker((keys) => published.push([...keys]))
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-1', lastRunOutcome: 'failed' })]))
    tracker.catalog('conn', catalog([session({ lastRunId: 'run-2', lastRunOutcome: 'failed' })]))
    expect(published.at(-1)).toHaveLength(1)
    tracker.disconnect('conn')
    expect(published.at(-1)).toEqual([])
  })
})
