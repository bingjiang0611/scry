import { beforeAll, describe, expect, it } from 'vitest'

interface CloseResult { state: 'closed' | 'unknown'; code?: number | null; signal?: string | null; reason?: string; timedOut?: boolean }
interface Inspection { state: string; descendants?: string }
interface LifecycleRecord {
  name: string
  pid: number | null
  phase: string
  startupError: string | null
  stop: { reason: string; identityBefore?: Inspection; closeRequest?: { requested: boolean; error?: string } } | null
  close: CloseResult | null
  owned: { status: 'stopped' | 'failed'; error?: string; tracked?: number } | null
  inspection: Inspection | null
  faults: Array<{ phase: string; error: string }>
}
interface OwnedChildOptions {
  name: string
  child: { pid: number }
  childClose: { wait: () => Promise<CloseResult> }
  snapshots?: { close: () => void }
  inspect?: (child: { pid: number }) => Inspection
  stopProcess?: (child: { pid: number }) => Promise<{ tracked: number }>
  requestClose?: () => Promise<unknown>
}
interface OwnedChild {
  record: LifecycleRecord
  ready(run: () => Promise<unknown>): Promise<unknown>
  fault(phase: string, error: unknown): void
  shutdown(reason?: string): Promise<LifecycleRecord>
}
interface LifecycleModule {
  ownedChild(options: OwnedChildOptions): OwnedChild
  lifecycleVerdict(records: LifecycleRecord[]): { ok: boolean; issues: string[] }
}

let lifecycle: LifecycleModule
beforeAll(async () => {
  lifecycle = await import(new URL('./fixtures/concurrency-trace-live-lifecycle.mjs', import.meta.url).href) as LifecycleModule
})

const CHILD = { pid: 4242 }

function harness(options: {
  close?: CloseResult
  inspected?: Inspection
  stopFails?: string
  closeRequest?: () => Promise<unknown>
  stopTracked?: number
} = {}) {
  const calls: string[] = []
  const child = { ...CHILD }
  const inspected = options.inspected ?? { state: 'exited', descendants: 'unknown' }
  const owned = lifecycle.ownedChild({
    name: 'host',
    child,
    childClose: { wait: async () => { calls.push(`wait:${calls.some((call) => call.startsWith('stop:'))}`); return options.close ?? { state: 'closed', code: 0 } } },
    snapshots: { close: () => { calls.push('snapshots') } },
    inspect: (target) => { calls.push(`inspect:${target.pid}`); return inspected },
    stopProcess: async (target) => {
      calls.push(`stop:${target.pid}`)
      if (options.stopFails) throw new Error(options.stopFails)
      return { tracked: options.stopTracked ?? 3 }
    },
    ...(options.closeRequest ? { requestClose: async () => { calls.push('requestClose'); return options.closeRequest?.() } } : {})
  })
  return { handle: owned, calls, child }
}

describe('live lane process ownership', () => {
  it('keeps owning a child whose startup failed, and stops it once', async () => {
    const { handle, calls } = harness({ close: { state: 'closed', code: 0, reason: 'startup failed' } })
    await expect(handle.ready(async () => { throw new Error('renderer never answered') })).rejects.toThrow('renderer never answered')
    expect(handle.record.phase).toBe('startup-failed')
    expect(handle.record.startupError).toBe('renderer never answered')

    const first = await handle.shutdown('startup-failure')
    const second = await handle.shutdown('second call is a no-op')
    expect(second).toBe(first)
    expect(calls.filter((call) => call.startsWith('stop:'))).toHaveLength(1)
    expect(calls.filter((call) => call === 'snapshots')).toHaveLength(1)
    expect(handle.record.close).toEqual({ state: 'closed', code: 0, reason: 'startup failed' })
    const verdict = lifecycle.lifecycleVerdict([handle.record])
    expect(verdict.ok).toBe(false)
    expect(verdict.issues.join()).toMatch(/startup failed \(renderer never answered\)/)
  })

  it('passes the real child to the helpers, in the documented order', async () => {
    // The bug this covers: calling inspectOwnedApp() with no child reports not-started
    // forever, so the owner would believe a live tree was already gone.
    const { handle, calls } = harness({ closeRequest: async () => ({ peers: 0 }) })
    await handle.ready(async () => ({ ok: true }))
    await handle.shutdown('launcher')
    expect(calls).toEqual([
      `inspect:${CHILD.pid}`, // readiness identity
      'requestClose', // peer cleanup first, never an exit
      'snapshots',
      `inspect:${CHILD.pid}`, // identity revalidation before signalling
      `stop:${CHILD.pid}`, // ownership capture + signal while the root is alive
      'wait:true', // the real close, only after the stop
      `inspect:${CHILD.pid}` // read-only final inspection
    ])
    expect(handle.record.stop?.identityBefore).toEqual({ state: 'exited', descendants: 'unknown' })
    expect(handle.record.owned).toEqual({ status: 'stopped', tracked: 3 })
  })

  it('accepts a real close after a converged stop', async () => {
    const { handle } = harness({ close: { state: 'closed', code: 0, signal: null } })
    await handle.ready(async () => ({ ok: true }))
    await handle.shutdown('launcher')
    expect(lifecycle.lifecycleVerdict([handle.record])).toEqual({ ok: true, issues: [] })
  })

  it('fails when the root already exited, so descendants stay unknown', async () => {
    const { handle } = harness({
      inspected: { state: 'exited', descendants: 'unknown' },
      stopFails: 'test App exited before ownership capture; descendant cleanup unknown'
    })
    await handle.ready(async () => ({ ok: true }))
    await handle.shutdown('launcher')
    expect(handle.record.owned).toMatchObject({ status: 'failed', error: 'test App exited before ownership capture; descendant cleanup unknown' })
    const verdict = lifecycle.lifecycleVerdict([handle.record])
    expect(verdict.ok).toBe(false)
    expect(verdict.issues.join()).toMatch(/owned cleanup failed \(test App exited before ownership capture/)
  })

  it('reports an unobserved close and a tree that is still running', async () => {
    const { handle } = harness({ close: { state: 'unknown', reason: 'ipc disconnected' }, inspected: { state: 'observed' } })
    await handle.ready(async () => ({ ok: true }))
    await handle.shutdown('launcher')
    const verdict = lifecycle.lifecycleVerdict([handle.record])
    expect(verdict.ok).toBe(false)
    expect(verdict.issues.join()).toMatch(/close unknown \(ipc disconnected\)/)
    expect(verdict.issues.join()).toMatch(/process tree still observed running after cleanup/)
  })

  it('records a rejected peer cleanup without losing the stop', async () => {
    const { handle } = harness({ closeRequest: async () => { throw new Error('close command refused') } })
    await handle.ready(async () => ({ ok: true }))
    await handle.shutdown('launcher')
    expect(handle.record.stop?.closeRequest).toEqual({ requested: false, error: 'close command refused' })
    expect(handle.record.owned).toEqual({ status: 'stopped', tracked: 3 })
    expect(lifecycle.lifecycleVerdict([handle.record]).issues.join()).toMatch(/peer\/transport cleanup failed/)
  })

  it('keeps launcher faults on the record so they reach the report', async () => {
    const { handle } = harness()
    await handle.ready(async () => ({ ok: true }))
    handle.fault('renderer-gone', new Error('gone'))
    await handle.shutdown('launcher')
    expect(handle.record.faults).toEqual([{ phase: 'renderer-gone', error: 'gone' }])
    expect(lifecycle.lifecycleVerdict([handle.record]).issues.join()).toMatch(/renderer-gone fault \(gone\)/)
  })
})
