import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { createAppRunSessionPublication, type AppRunSessionEvent } from './app-run-session-publication'

function fixture(overrides: Partial<Parameters<typeof createAppRunSessionPublication>[0]> = {}) {
  const order: string[] = []
  const renderer: AppRunSessionEvent[] = []
  const runState: Pick<ActiveRun, 'sessionId' | 'externalSessionId' | 'attachments'> = {
    sessionId: 'provisional', externalSessionId: 'provisional'
  }
  let selected: string | undefined
  const lifecycle = createAppRunSessionPublication({
    runId: 'run-1',
    initialSessionId: 'provisional',
    initialDiffContextKey: 'diff:provisional',
    editSourceSessionId: 'edit-source',
    providerId: 'codex',
    agentProfileId: 'profile-1',
    runState,
    initialRendererEnabled: true,
    recordInitialSession: () => { order.push('record-initial') },
    prepareAttachments: () => { order.push('prepare-attachments'); return [{ kind: 'image', name: 'a.png', mimeType: 'image/png', dataBase64: 'YQ==', path: '/tmp/a' }] },
    preparePrompt: () => { order.push('prepare-prompt'); return { prompt: 'prepared', inputTextHash: 'hash-1' } },
    cleanupProvisional: () => { order.push('cleanup') },
    deleteAttachments: () => { order.push('delete-attachments') },
    promoteDiffContext: (current, sessionId) => { order.push('promote-diff'); return `${current}->${sessionId}` },
    commitSelectedSession: sessionId => { order.push('commit-selected'); selected = sessionId },
    badgeKey: sessionId => `badge:${sessionId}`,
    rekeyBadge: (previous, next) => { order.push(`rekey:${previous}:${next}`) },
    viewBadge: (key, focused) => { order.push(`view:${key}:${focused}`) },
    isRunViewed: () => true,
    isWindowFocused: () => false,
    updateAttachmentOwner: () => { order.push('owner') },
    recordNativeSession: () => { order.push('record-native') },
    onExternalSession: () => { order.push('external') },
    sendRendererSession: event => { order.push(`renderer:${event.sessionId}`); renderer.push(event) },
    warn: message => { order.push(`warn:${message}`) },
    ...overrides
  })
  return { lifecycle, order, renderer, runState, selected: () => selected }
}

describe('App run session identity publication', () => {
  it('promotes authoritative identity in the established cross-store order', () => {
    const f = fixture()
    expect(f.order).toEqual(['record-initial', 'prepare-attachments', 'prepare-prompt', 'renderer:provisional'])
    expect(f.lifecycle.runtimePrompt).toBe('prepared')
    expect(f.lifecycle.managedInputTextHash).toBe('hash-1')
    expect(f.lifecycle.attachments).toHaveLength(1)

    f.lifecycle.publishSessionId('native-1')

    expect(f.order.slice(4)).toEqual([
      'external', 'promote-diff', 'commit-selected',
      'rekey:badge:provisional:badge:native-1', 'owner', 'record-native',
      'view:badge:native-1:false', 'renderer:native-1'
    ])
    expect(f.lifecycle.observedSessionId()).toBe('native-1')
    expect(f.lifecycle.diffContextKey()).toBe('diff:provisional->native-1')
    expect(f.selected()).toBe('native-1')
    expect(f.runState).toMatchObject({ sessionId: 'native-1', externalSessionId: 'native-1' })
    expect(f.renderer.at(-1)).toMatchObject({ sessionId: 'native-1', previousSessionId: 'edit-source', externalSessionId: 'native-1' })
  })

  it('keeps selected-session authority fenced while still publishing run-local identity', () => {
    let selected = 'newer-session'
    const f = fixture({ commitSelectedSession: () => { /* Main revision predicate rejected this promotion */ } })
    f.lifecycle.publishSessionId('native-2')
    expect(selected).toBe('newer-session')
    expect(f.lifecycle.observedSessionId()).toBe('native-2')
    expect(f.runState.externalSessionId).toBe('native-2')
    expect(f.order).toContain('record-native')
    expect(f.renderer.at(-1)?.sessionId).toBe('native-2')
  })

  it('preserves external duplicate callbacks but suppresses duplicate renderer events', () => {
    const external = vi.fn()
    const f = fixture({ initialSessionId: undefined, initialRendererEnabled: false, onExternalSession: external })
    f.lifecycle.publishSessionId('native-3')
    f.lifecycle.publishSessionId('native-3')
    expect(external).toHaveBeenCalledTimes(2)
    expect(f.renderer.filter(event => event.sessionId === 'native-3')).toHaveLength(1)
    expect(f.order.filter(value => value === 'record-native')).toHaveLength(2)
    expect(f.lifecycle.diffContextKey()).toBe('diff:provisional->native-3->native-3')
  })

  it('rolls back provisional ownership and attachment bytes on initial publication failure', () => {
    const frontdoor = new Error('renderer failed')
    const order: string[] = []
    expect(() => fixture({
      sendRendererSession: () => { throw frontdoor },
      cleanupProvisional: () => { order.push('cleanup'); throw new Error('cleanup failed') },
      deleteAttachments: () => { order.push('delete') }
    })).toThrow(frontdoor)
    expect(order).toEqual(['cleanup', 'delete'])
  })
})
