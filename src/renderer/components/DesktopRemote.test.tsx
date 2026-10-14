import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultOption, DesktopRemote, desktopRemoteStateKey, desktopProviderKey, remoteTurns, shouldQueryUnknownIntent } from './DesktopRemote'
import type { TraceEvent } from '@shared/trace'

const event = (partial: Partial<TraceEvent>): TraceEvent => ({
  id: partial.id ?? 'e', ts: partial.ts ?? '2026-01-01T00:00:00.000Z', runId: partial.runId ?? 'r1',
  kind: partial.kind ?? 'model', stage: partial.stage ?? 'text', ...partial
})

describe('desktop remote renderer contract', () => {
  it('keys state by connection, provider/profile, cwd and session', () => {
    const base = { cwd: '/repo', providerId: 'claude', agentProfileId: 'default', externalSessionId: 's1' }
    expect(desktopRemoteStateKey('host-a', base)).not.toBe(desktopRemoteStateKey('host-b', base))
    expect(desktopRemoteStateKey('host-a', base)).not.toBe(desktopRemoteStateKey('host-a', { ...base, externalSessionId: 's2' }))
  })

  it('keeps Provider profiles distinct in picker values', () => {
    expect(desktopProviderKey({ id: 'pi', agentProfileId: 'rotom' })).not.toBe(desktopProviderKey({ id: 'pi', agentProfileId: 'default' }))
    expect(desktopProviderKey({ id: 'pi' })).not.toBe(desktopProviderKey({ id: 'pi', agentProfileId: 'rotom' }))
  })

  it('never treats an unknown receipt as safe to resend', () => {
    expect(shouldQueryUnknownIntent({ status: 'unknown' })).toBe(true)
    expect(shouldQueryUnknownIntent({ status: 'recorded' })).toBe(false)
  })

  it('preserves human boundaries while projecting trace events to transcript turns', () => {
    const turns = remoteTurns([
      event({ id: 'p1', runId: 'r1', kind: 'human', stage: 'prompt', text: 'first' }),
      event({ id: 'a1', runId: 'r1', kind: 'model', stage: 'text', text: 'answer' }),
      event({ id: 'p2', runId: 'r2', kind: 'human', stage: 'prompt', text: 'second' })
    ])
    expect(turns.map((turn) => turn.userText)).toEqual(['first', 'second'])
    expect(turns[0].items).toHaveLength(2)
  })

  it('renders the remote screen shell during SSR without a privileged bridge', () => {
    const html = renderToStaticMarkup(<DesktopRemote onBack={() => {}} />)
    expect(html).toContain('桌面远程')
    expect(html).toContain('返回')
  })

  it('uses explicit host defaults when a catalog marks them', () => {
    expect(defaultOption([{ id: 'slow', label: 'Slow' }, { id: 'fast', label: 'Fast', isDefault: true }])).toBe('fast')
  })
})
