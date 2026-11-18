import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunRegistry, type RunRegistryState } from '../src/main/run-registry'
import { SourceControlService } from '../src/main/source-control/service'
import type { GitIdentity } from '../src/main/source-control/git'
import { executeMutation } from '../src/main/source-control/mutation'

// Only the external write boundary is replaced, never the gate or run registry.
vi.mock('../src/main/source-control/mutation', () => ({ executeMutation: vi.fn() }))

type State = RunRegistryState & { cwd?: string }
const dirs: string[] = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(onSnapshot?: () => void) {
  const dir = await mkdtemp(join(tmpdir(), 'scry-formal-gate-'))
  dirs.push(dir)
  const root = join(dir, 'repo')
  const linked = join(dir, 'linked')
  const other = join(dir, 'other')
  await Promise.all([root, linked, other].map(path => mkdir(path)))
  const identities = new Map<string, GitIdentity>([
    [root, { id: 'a'.repeat(64), root, gitDir: join(root, '.git'), commonDir: join(root, '.git') }],
    [linked, { id: 'b'.repeat(64), root: linked, gitDir: join(root, '.git/worktrees/linked'), commonDir: join(root, '.git') }],
    [other, { id: 'c'.repeat(64), root: other, gitDir: join(other, '.git'), commonDir: join(other, '.git') }]
  ])
  const registry = new RunRegistry<State, { runId: string }>()
  const service = new SourceControlService({
    userData: join(dir, 'userData'),
    authorizeDirectory: path => path,
    // Production index.ts wiring, with the real RunRegistry method.
    unsettledDirectories: () => {
      const snapshot = registry.unsettledStates().map(run => run.cwd)
      onSnapshot?.()
      return snapshot
    }
  })
  await service.store.ready
  vi.spyOn(service.git, 'identity').mockImplementation(async path => {
    const identity = identities.get(path)
    if (!identity) throw new Error('fixture identity unavailable')
    return identity
  })
  // Seed the identity cache normally populated by read(). Path/auth correctness is out of scope.
  const cache = Reflect.get(service, 'identities') as Map<string, GitIdentity>
  for (const identity of identities.values()) cache.set(identity.id, identity)
  const mutate = () => service.mutate({ repositoryId: 'a'.repeat(64), fingerprint: 'fixture',
    action: 'stage', paths: ['file.txt'], operationId: randomUUID() })
  const register = (cwd?: string, finalizing = false) => {
    const state: State = { runId: randomUUID(), cwd, done: finalizing,
      providerSettled: finalizing, localFinalizing: finalizing }
    registry.register(state, { runId: state.runId })
    return state
  }
  return { service, registry, identities, root, linked, other, mutate, register }
}

function pauseAfterGate(service: SourceControlService) {
  const entered = deferred()
  const release = deferred()
  const get = service.store.get.bind(service.store)
  vi.spyOn(service.store, 'get').mockImplementation(async id => {
    entered.resolve()
    await release.promise
    return get(id)
  })
  return { entered: entered.promise, release: release.resolve }
}

beforeEach(() => {
  vi.mocked(executeMutation).mockReset()
  vi.mocked(executeMutation).mockImplementation(async (_request, _identity, record, deps) => {
    record.operation.status = 'succeeded'
    await deps.store.save(record)
    return record.operation
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('NoWriteDuringUnsettled: real-code witnesses for the bounded model', () => {
  it.each(['same', 'linked'] as const)('write first: reject %s repository run until dispatch ends', async kind => {
    const f = await fixture()
    const started = deferred()
    const finish = deferred()
    let writing = false
    vi.mocked(executeMutation).mockImplementation(async (_request, _identity, record, deps) => {
      writing = true
      started.resolve()
      await finish.promise
      writing = false
      record.operation.status = 'succeeded'
      await deps.store.save(record)
      return record.operation
    })
    const mutation = f.mutate()
    // If dispatch fails before the signal, propagate the error instead of hanging.
    await Promise.race([started.promise, mutation.then(() => { throw new Error('mutation never dispatched') })])
    let registered = false
    try {
      const admissionError = await f.service.admitRun(kind === 'same' ? f.root : f.linked, () => {
        registered = true
        f.register(f.root)
      }).then(() => undefined, error => error as Error)
      expect(writing && registered, 'NoWriteDuringUnsettled: gate allowed a run during dispatch').toBe(false)
      expect(registered).toBe(false)
      expect(admissionError?.message).toContain('此仓库正在执行源代码管理操作')
    } finally {
      finish.resolve()
      await mutation
    }
  })

  for (const finalizing of [false, true]) {
    it.each(['same', 'linked', 'unknown'] as const)(`run first (finalizing=${finalizing}): block %s repository write`, async kind => {
      const f = await fixture()
      f.register(kind === 'unknown' ? undefined : kind === 'same' ? f.root : f.linked, finalizing)
      await f.mutate()
      expect(executeMutation, 'NoWriteDuringUnsettled: dispatch overlapped an unsettled run').not.toHaveBeenCalled()
    })
  }

  it('replays shortest BrokenAdmission path: empty busy snapshot, late registration, dispatch', async () => {
    let resolveIdentity!: (identity: GitIdentity) => void
    const pendingIdentity = new Promise<GitIdentity>(resolve => { resolveIdentity = resolve })
    const f = await fixture(() => resolveIdentity(f.identities.get(f.root)!))
    const paused = pauseAfterGate(f.service)
    const mutation = f.mutate()
    await paused.entered // AcquireWriteGate
    vi.mocked(f.service.git.identity).mockReturnValueOnce(pendingIdentity)
    const admission = f.service.admitRun(f.root, () => f.register(f.root))
      .then(() => undefined, error => error as Error) // BeginRun, waiting at its real await
    let overlap = false
    vi.mocked(executeMutation).mockImplementation(async (_request, _identity, record, deps) => {
      overlap = f.registry.unsettledStates().length > 0
      record.operation.status = 'succeeded'
      await deps.store.save(record)
      return record.operation
    })
    // CaptureUnsettled snapshots [] before releasing admission identity. Its continuation
    // checks/registers before mutate resumes from await busy(), then dispatch follows.
    paused.release()
    await Promise.all([admission, mutation])
    expect(executeMutation).toHaveBeenCalledOnce()
    expect(overlap, 'NoWriteDuringUnsettled: shortest admission counterexample replayed').toBe(false)
  })

  it('replays shortest BrokenFinalization path: run, gate, provider settles, busy snapshot, dispatch', async () => {
    const f = await fixture()
    let state!: State
    await f.service.admitRun(f.root, () => { state = f.register(f.root) })
    const paused = pauseAfterGate(f.service)
    const mutation = f.mutate()
    await paused.entered
    state.done = true
    state.providerSettled = true
    state.localFinalizing = true
    paused.release()
    await mutation
    expect(executeMutation, 'NoWriteDuringUnsettled: shortest finalization counterexample replayed').not.toHaveBeenCalled()
  })

  it('allows unrelated repository work and allows writes after local finalization', async () => {
    const f = await fixture()
    f.register(f.other)
    expect((await f.mutate()).status).toBe('succeeded')
    const same = f.register(f.linked, true)
    expect((await f.mutate()).status).toBe('failed')
    f.registry.remove(same.runId)
    same.localFinalizing = false
    expect((await f.mutate()).status).toBe('succeeded')
    expect(executeMutation).toHaveBeenCalledTimes(2)
  })
})
