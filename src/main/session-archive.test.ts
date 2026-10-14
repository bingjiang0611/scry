import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { createAppSessionStore } from './app-store'
import { archiveSessionAndStop } from './session-archive'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-archive-'))
  dirs.push(dir)
  const store = createAppSessionStore(dir)
  const ref = { providerId: 'pi' as const, agentProfileId: 'pi:first', cwd: '/fixture', externalSessionId: 'native' }
  store.record({ ...ref, runtimeProvider: 'pi_rpc', runId: 'first-run', prompt: 'archive me' })
  const run: ActiveRun = { runId: 'next-run', ...ref, sessionId: 'native', userText: 'running', items: [], done: false }
  return { store, ref, run }
}

describe('archive stops exact session and fences later starts', () => {
  it('stops a resumed run, persists archive first, and does not fake its terminal state', () => {
    const { store, ref, run } = fixture()
    const unrelated = [
      { ...run, runId: 'other-profile', agentProfileId: 'pi:second' },
      { ...run, runId: 'other-workspace', cwd: '/other' },
      { ...run, runId: 'other-provider', providerId: 'claude' as const },
      { ...run, runId: 'other-session', externalSessionId: 'other', sessionId: 'other' }
    ]
    const stop = vi.fn(() => { expect(store.isArchived(ref)).toBe(true); return true })
    expect(archiveSessionAndStop(store, ref, [run, ...unrelated], stop)).toBe(true)
    expect(stop.mock.calls).toEqual([['next-run']])
    expect(run.done).toBe(false)
    expect(store.listProjects()).toEqual([])
    expect(store.listArchivedProjects()[0].sessions[0].sessionId).toBe('native')
  })

  it('stops the provisional run before a native session ID exists; keeps archive on late ID capture', () => {
    const { store, ref } = fixture()
    store.recordPending({ ...ref, runId: 'pending', runtimeProvider: 'pi_rpc', prompt: 'pending' })
    const pendingRef = { ...ref, externalSessionId: 'pending' }
    const run: ActiveRun = { runId: 'pending', providerId: 'pi', agentProfileId: ref.agentProfileId,
      cwd: ref.cwd, userText: 'pending', items: [], done: false }
    const stop = vi.fn(() => true)
    expect(archiveSessionAndStop(store, pendingRef, [run], stop)).toBe(true)
    expect(stop).toHaveBeenCalledWith('pending')
    store.record({ ...ref, externalSessionId: 'late-native', runId: 'pending', runtimeProvider: 'pi_rpc', prompt: 'pending' })
    expect(store.isArchived(pendingRef)).toBe(true)
    expect(store.isArchived({ ...ref, externalSessionId: 'late-native' })).toBe(true)
    expect(store.isArchived({ ...pendingRef, agentProfileId: 'pi:second' })).toBe(false)
  })

  it('does not stop anything if catalog archive fails; undo does not restart execution', () => {
    const { store, ref, run } = fixture()
    const stop = vi.fn(() => true)
    expect(archiveSessionAndStop(store, { ...ref, externalSessionId: 'missing' }, [run], stop)).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    archiveSessionAndStop(store, ref, [run], stop)
    expect(store.setArchived(ref, false)).toBe(true)
    expect(store.isArchived(ref)).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
    expect(store.listProjects()).toHaveLength(1)
  })
})
