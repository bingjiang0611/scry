import { describe, expect, it, vi } from 'vitest'
import {
  activeRightSurfaceTabKey, activeToolId, createRightSurfaceState, MAX_SIDE_CHAT_TABS, reduceRightSurfaceState,
  RIGHT_SURFACE_KINDS, rightSurfaceIsChooser, rightSurfaceTabs, type RightSurfaceState
} from './right-surface'
import { parseSurfaces, persistSurfaces, restoreSurfaces, SURFACE_STORAGE_KEY, type SessionRightSurface } from './right-surface-storage'

function state(overrides: Partial<RightSurfaceState> = {}): RightSurfaceState {
  return { ...createRightSurfaceState({ openIds: ['overview', 'files'], activeId: 'overview' }), ...overrides }
}

describe('flat right-surface tabs', () => {
  it('keeps all six tool identities, their order and the terminal retention rule', () => {
    expect([...RIGHT_SURFACE_KINDS]).toEqual(['overview', 'files', 'diff', 'source-control', 'terminal', 'agents'])
    let current = createRightSurfaceState({ openIds: [] })
    for (const kind of [...RIGHT_SURFACE_KINDS, 'files' as const]) {
      current = reduceRightSurfaceState(current, { type: 'open', kind })
    }
    expect(current.openIds).toEqual([...RIGHT_SURFACE_KINDS])
    expect(activeToolId(current)).toBe('files')
    expect(rightSurfaceTabs(current).map((tab) => tab.type === 'tool' ? tab.kind : tab.conversationId))
      .toEqual([...RIGHT_SURFACE_KINDS])
  })

  it('puts child instances on the same level and keeps one active tab', () => {
    let current = state()
    current = reduceRightSurfaceState(current, { type: 'open-side-chat', conversationId: 'child-a' })
    expect(rightSurfaceTabs(current).map((tab) => tab.type)).toEqual(['tool', 'tool', 'side-chat'])
    expect(activeRightSurfaceTabKey(current)).toBe('side-chat:child-a')
    expect(activeToolId(current)).toBeNull()
    current = reduceRightSurfaceState(current, { type: 'open-side-chat', conversationId: 'child-b' })
    expect(current.sideChats).toEqual(['child-a', 'child-b'])
    // Opening an existing instance activates it instead of duplicating it.
    current = reduceRightSurfaceState(current, { type: 'open-side-chat', conversationId: 'child-a' })
    expect(current.sideChats).toEqual(['child-a', 'child-b'])
    expect(activeRightSurfaceTabKey(current)).toBe('side-chat:child-a')
    // Activating a tool tab does not close the child views.
    current = reduceRightSurfaceState(current, { type: 'activate', kind: 'files' })
    expect(current.sideChats).toEqual(['child-a', 'child-b'])
    expect(activeRightSurfaceTabKey(current)).toBe('files')
    current = reduceRightSurfaceState(current, { type: 'activate-side-chat', conversationId: 'child-b' })
    expect(activeRightSurfaceTabKey(current)).toBe('side-chat:child-b')
  })

  it('closes only the view and returns to a neighbour, a tool, then the chooser', () => {
    let current = state({ sideChats: ['child-a', 'child-b'], activeSideChatId: 'child-a' })
    current = reduceRightSurfaceState(current, { type: 'close-side-chat', conversationId: 'child-a' })
    expect(current.sideChats).toEqual(['child-b'])
    expect(activeRightSurfaceTabKey(current)).toBe('side-chat:child-b')
    current = reduceRightSurfaceState(current, { type: 'close-side-chat', conversationId: 'child-b' })
    expect(current.sideChats).toEqual([])
    expect(activeRightSurfaceTabKey(current)).toBe('overview')
    const empty = reduceRightSurfaceState(createRightSurfaceState({ openIds: [] }), { type: 'close-side-chat', conversationId: 'child-a' })
    expect(rightSurfaceIsChooser(empty)).toBe(true)
    // Closing an inactive child keeps the current active tab untouched.
    const inactive = reduceRightSurfaceState(state({ sideChats: ['a', 'b'], activeSideChatId: 'b' }),
      { type: 'close-side-chat', conversationId: 'a' })
    expect(activeRightSurfaceTabKey(inactive)).toBe('side-chat:b')
  })

  it('bounds the visible tab strip without inventing or deleting child records', () => {
    let current = createRightSurfaceState({ openIds: [] })
    for (let index = 0; index < MAX_SIDE_CHAT_TABS + 2; index++) {
      current = reduceRightSurfaceState(current, { type: 'open-side-chat', conversationId: `child-${index}` })
    }
    expect(current.sideChats).toHaveLength(MAX_SIDE_CHAT_TABS)
    expect(current.sideChats[0]).toBe('child-2')
    expect(current.activeSideChatId).toBe(`child-${MAX_SIDE_CHAT_TABS + 1}`)
  })

  it('drops only ids a bounded read proved missing, keeping the rest open', () => {
    const current = reduceRightSurfaceState(state({ sideChats: ['a', 'b', 'c'], activeSideChatId: 'b' }),
      { type: 'drop-side-chats', conversationIds: ['b', 'c'] })
    expect(current.sideChats).toEqual(['a'])
    expect(current.activeSideChatId).toBe('a')
    expect(reduceRightSurfaceState(current, { type: 'drop-side-chats', conversationIds: ['missing'] })).toBe(current)
  })
})

class MemoryStorage {
  value: string | null = null
  getItem(): string | null { return this.value }
  setItem(_key: string, value: string): void { this.value = value }
}

function storedSurface(id: string, overrides: Partial<RightSurfaceState> = {}): SessionRightSurface {
  return { id, cwd: '/repo', state: { ...createRightSurfaceState({ openIds: ['files'], activeId: 'files' }), ...overrides } }
}

describe('side-chat tab close', () => {
  it('closes only the layout tab and keeps the panel and other tabs intact', () => {
    const state = reduceRightSurfaceState(
      createRightSurfaceState({ openIds: ['overview'], activeId: 'overview' }),
      { type: 'open-side-chat', conversationId: 'child-a' }
    )
    const withBoth = reduceRightSurfaceState(state, { type: 'open-side-chat', conversationId: 'child-b' })
    const closed = reduceRightSurfaceState(withBoth, { type: 'close-side-chat', conversationId: 'child-a' })
    expect(closed.sideChats).toEqual(['child-b'])
    // Closing a child is a layout action: the workbench stays visible and every tool tab
    // survives. Nothing here can stop, archive or delete the child conversation.
    expect(closed.visible).toBe(true)
    expect(closed.openIds).toEqual(['overview'])
    expect(closed.activeSideChatId).toBe('child-b')
  })
})

describe('durable workbench storage', () => {
  it('round-trips child tabs through the durable local namespace', () => {
    const local = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: local, sessionStorage: new MemoryStorage() })
    try {
      const surfaces = new Map([['scope', storedSurface('surface-1', { sideChats: ['child-a'], activeSideChatId: 'child-a' })]])
      expect(persistSurfaces(surfaces, SURFACE_STORAGE_KEY)).toBe(true)
      expect(restoreSurfaces()).toEqual(surfaces)
    } finally { vi.unstubAllGlobals() }
  })

  it('migrates the older session-scoped layout once into the durable namespace', () => {
    const local = new MemoryStorage()
    const legacy = new MemoryStorage()
    const surfaces = new Map([['scope', storedSurface('surface-legacy')]])
    legacy.value = JSON.stringify([...surfaces])
    vi.stubGlobal('window', { localStorage: local, sessionStorage: legacy })
    try {
      expect(restoreSurfaces()).toEqual(surfaces)
      persistSurfaces(restoreSurfaces(), SURFACE_STORAGE_KEY)
      // The durable copy now wins even if the legacy namespace disappears.
      legacy.value = null
      expect(restoreSurfaces()).toEqual(surfaces)
    } finally { vi.unstubAllGlobals() }
  })

  it('drops malformed rows, unknown tool ids and non-string child ids', () => {
    const raw = JSON.stringify([
      ['ok', storedSurface('surface-1', { sideChats: ['child-a', 7 as never, 'child-a'] })],
      ['bad-kind', { id: 's2', cwd: null, state: { openIds: ['rollout'], activeId: null, visible: true, maximized: false } }],
      ['no-state', { id: 's3', cwd: null }],
      'not-a-row'
    ])
    const restored = parseSurfaces(raw)
    expect([...restored.keys()]).toEqual(['ok'])
    expect(restored.get('ok')?.state.sideChats).toEqual(['child-a'])
    expect(parseSurfaces('{broken').size).toBe(0)
  })
})
