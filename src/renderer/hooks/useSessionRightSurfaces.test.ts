import { describe, expect, it, vi } from 'vitest'
import { createRightSurfaceState, reduceRightSurfaceState } from '../right-surface'
import { exitText } from '../components/TerminalSurface'
import { migrateRightSurfaces, restoreSurfaces, type SessionRightSurface } from '../right-surface-storage'

function surface(id: string): SessionRightSurface {
  return { id, cwd: '/repo', state: createRightSurfaceState({ openIds: ['files', 'terminal', 'agents'], activeId: 'terminal' }), terminalMounted: true }
}

describe('conversation right workbenches', () => {
  it('keeps same-workspace conversations independent and preserves draft/run/native identity', () => {
    const original = surface('stable-draft')
    const other = surface('other-conversation')
    let scopes: ReadonlyMap<string, SessionRightSurface> = new Map([['draft', original], ['other', other]])
    scopes = migrateRightSurfaces(scopes, 'draft', 'run')
    expect(scopes.has('draft')).toBe(false)
    expect(scopes.get('run')).toBe(original)
    scopes = migrateRightSurfaces(scopes, 'run', 'native')
    expect(scopes.get('native')).toBe(original)
    expect(scopes.get('other')).toBe(other)
    expect(reduceRightSurfaceState(other.state, { type: 'close', kind: 'terminal' }).openIds).not.toContain('terminal')
    expect(original.state.openIds).toEqual(['files', 'terminal', 'agents'])
    expect(migrateRightSurfaces(scopes, 'native', 'native')).toBe(scopes)
    expect(migrateRightSurfaces(scopes, 'missing', 'native')).toBe(scopes)
  })

  it('keeps both existing workbenches reachable after late capture and renderer reload', () => {
    const source = surface('run-workbench')
    const target = surface('native-workbench')
    const scopes = migrateRightSurfaces(new Map([['run', source], ['native', target]]), 'run', 'native')
    expect(scopes.get('native')?.id).toBe(source.id)
    expect(scopes.get('native')?.relatedIds).toEqual([target.id])
    expect(scopes.get(target.id)).toBe(target)
    vi.stubGlobal('window', { sessionStorage: { getItem: () => JSON.stringify([...scopes]) } })
    try { expect(restoreSurfaces()).toEqual(scopes) } finally { vi.unstubAllGlobals() }
  })

  it('restores remote workbenches without reading the local storage namespace', () => {
    const local = new Map([['local', surface('local-surface')]])
    const remote = new Map([['remote', surface('remote-surface')]])
    const getItem = vi.fn((key: string) => JSON.stringify([...(key === 'remote-workbenches' ? remote : local)]))
    vi.stubGlobal('window', { sessionStorage: { getItem } })
    try {
      expect(restoreSurfaces('remote-workbenches')).toEqual(remote)
      expect(getItem).toHaveBeenLastCalledWith('remote-workbenches')
      expect(restoreSurfaces()).toEqual(local)
    } finally { vi.unstubAllGlobals() }
  })

  it('shows the actual exit code when node-pty reports signal zero', () => {
    expect(exitText({ id: 't', code: 1, signal: 0 })).toBe('Shell 已退出 · code 1')
    expect(exitText({ id: 't', code: 0, signal: null })).toBe('Shell 已退出 · code 0')
    expect(exitText({ id: 't', code: 0, signal: 15 })).toBe('Shell 已退出 · signal 15')
    expect(exitText({ id: 't', code: null, signal: null })).toBe('Shell 已退出')
  })
})
