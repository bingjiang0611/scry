import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareAppRunEditLastTurn } from './app-run-edit-last-turn'
import { readTraceArchiveAsync, upsertTraceArchiveTurn, type TraceArchiveTurn } from './transcript-archive'
import { AgentRuntimeError } from './run-outcome'
import type { ForkLastTurnFacet } from './providers/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const previous: TraceArchiveTurn = { runId: 'previous-run', userText: 'previous prompt', providerTurnId: 'previous-native',
  forkTurnId: 'previous-fork', items: [], done: true, status: 'completed', ts: 1 }
const head: TraceArchiveTurn = { runId: 'head-run', userText: 'original head prompt', providerTurnId: 'head-native',
  forkTurnId: 'head-fork', items: [], done: true, status: 'completed', ts: 2 }
const edit = { replaceRunId: head.runId, replaceProviderTurnId: head.providerTurnId!, replaceForkTurnId: head.forkTurnId!,
  previousProviderTurnId: previous.providerTurnId, previousForkTurnId: previous.forkTurnId }
const firstEdit = { replaceRunId: head.runId, replaceProviderTurnId: head.providerTurnId!, replaceForkTurnId: head.forkTurnId! }
const interrupted = (runId: string, ts: number): TraceArchiveTurn => ({ runId, userText: 'local only', items: [],
  done: true, status: 'interrupted', ts })

async function fixture(turns: TraceArchiveTurn[] = [previous, head]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-edit-last-turn-')))
  roots.push(root)
  const catalogCwd = join(root, 'source workspace')
  const cwd = join(root, 'execution workspace')
  const userDataDir = join(root, 'isolated userData')
  await Promise.all([mkdir(catalogCwd), mkdir(cwd), mkdir(userDataDir)])
  for (const turn of turns) expect(upsertTraceArchiveTurn({ cwd: catalogCwd, sessionId: 'source-session',
    providerId: 'codex', runtimeProvider: 'codex_cli', userDataDir, turn })).toBe(true)
  const fork = vi.fn<ForkLastTurnFacet['fork']>(async () => ({ externalSessionId: 'forked-session' }))
  const facet = { fork }
  const clone = vi.fn<Parameters<typeof prepareAppRunEditLastTurn>[0]['cloneForkArchiveTurns']>()
  const commit = vi.fn<(sessionId: string | undefined) => void>()
  const getMcp = vi.fn<Parameters<typeof prepareAppRunEditLastTurn>[0]['getMcpExecution']>(() => undefined)
  const changed = new AgentRuntimeError('fixture context changed', { provider: 'codex_cli', stage: 'frontdoor',
    cwd, nextAction: 'keep the original session' })
  const input: Parameters<typeof prepareAppRunEditLastTurn>[0] = {
    request: { forkLastTurn: { ...edit } }, forkSourceSessionId: 'source-session', restartSourceSessionId: 'source-session',
    expectedSessionId: 'source-session', providerId: 'codex', runtimeProvider: 'codex_cli', cwd, catalogCwd,
    agentProfileId: 'fixture-profile', model: { id: 'fixture-model' }, permissionMode: 'default', codexHookTrust: [],
    openCodePluginTrust: undefined, getMcpExecution: getMcp, forkLastTurnFacet: vi.fn(() => facet),
    userDataDir: vi.fn(() => userDataDir), cloneForkArchiveTurns: clone, commitSession: commit,
    contextChangedError: () => changed
  }
  return { input, fork, facet, clone, commit, getMcp, changed, userDataDir }
}

function noCommit(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.clone).not.toHaveBeenCalled()
  expect(f.commit).not.toHaveBeenCalled()
}

describe('App edit-last-turn preparation', () => {
  it('does nothing without an edit request and rejects stale source selection before archive I/O', async () => {
    const f = await fixture()
    await prepareAppRunEditLastTurn({ ...f.input, request: {} })
    expect(f.input.userDataDir).not.toHaveBeenCalled()
    await expect(prepareAppRunEditLastTurn({ ...f.input, expectedSessionId: 'different-session' })).rejects.toBe(f.changed)
    expect(f.input.userDataDir).not.toHaveBeenCalled()
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.getMcp).not.toHaveBeenCalled()
    noCommit(f)
  })

  it.each([
    { replaceRunId: 'stale-run' },
    { replaceProviderTurnId: 'stale-provider-boundary' },
    { replaceForkTurnId: 'stale-fork-boundary' }
  ])('requires the exact persisted replacement head: %j', async change => {
    const f = await fixture()
    f.input.request = { forkLastTurn: { ...edit, ...change } }
    await expect(prepareAppRunEditLastTurn(f.input)).rejects.toMatchObject({ brief: { stage: 'frontdoor' } })
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.getMcp).not.toHaveBeenCalled()
    noCommit(f)
  })

  it('rejects missing archive or a mismatched previous boundary before any native fork', async () => {
    for (const turns of [[], [previous, head]]) {
      const f = await fixture(turns)
      f.input.request = { forkLastTurn: { ...edit, previousForkTurnId: 'wrong-previous-fork' } }
      await expect(prepareAppRunEditLastTurn(f.input)).rejects.toMatchObject({ brief: { stage: 'frontdoor' } })
      expect(f.fork).not.toHaveBeenCalled()
      expect(f.getMcp).not.toHaveBeenCalled()
      noCommit(f)
    }
  })

  it('defers capability/MCP reads until after archive I/O, clones only the prefix and commits synchronously', async () => {
    const f = await fixture()
    const order: string[] = []
    let fresh = false
    let cloneYielded = false
    const lateFork = vi.fn<ForkLastTurnFacet['fork']>(async request => {
      order.push('fork')
      expect(request).toMatchObject({ ...edit, sourceSessionId: 'source-session', originalPrompt: head.userText,
        cwd: f.input.cwd, agentProfileId: 'fixture-profile', model: { id: 'fixture-model' }, permissionMode: 'default' })
      expect(request.codexHookTrust).toBe(f.input.codexHookTrust)
      return { externalSessionId: 'late-fork' }
    })
    let currentFacet: ForkLastTurnFacet = f.facet
    f.input.forkLastTurnFacet = () => { order.push('facet'); return currentFacet }
    f.getMcp.mockImplementation(() => { expect(fresh).toBe(true); order.push('mcp'); return undefined })
    f.clone.mockImplementation(() => { order.push('clone'); queueMicrotask(() => { cloneYielded = true }) })
    f.commit.mockImplementation(id => {
      expect(cloneYielded).toBe(false)
      expect(id).toBe('late-fork')
      order.push('commit')
    })
    const pending = prepareAppRunEditLastTurn(f.input)
    expect(order).toEqual([])
    fresh = true
    currentFacet = { fork: lateFork }
    await pending
    expect(order).toEqual(['facet', 'mcp', 'fork', 'clone', 'commit'])
    expect(f.fork).not.toHaveBeenCalled()
    expect(lateFork).toHaveBeenCalledOnce()
    const archive = await readTraceArchiveAsync({ cwd: f.input.catalogCwd, sessionId: 'source-session',
      providerId: 'codex', userDataDir: f.userDataDir })
    expect(f.clone).toHaveBeenCalledExactlyOnceWith({ turns: archive!.turns.slice(0, -1), targetSessionId: 'late-fork',
      providerId: 'codex', runtimeProvider: 'codex_cli', cwd: f.input.catalogCwd })
    expect(f.commit).toHaveBeenCalledOnce()
  })

  it('resets only a sole first turn, without requiring a native fork or consulting MCP', async () => {
    const f = await fixture([head])
    f.input.request = { forkLastTurn: firstEdit }
    await prepareAppRunEditLastTurn(f.input)
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(f.clone).not.toHaveBeenCalled()
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.getMcp).not.toHaveBeenCalled()
    expect(f.input.forkLastTurnFacet).not.toHaveBeenCalled()
    const multiple = await fixture()
    multiple.input.request = { forkLastTurn: firstEdit }
    await expect(prepareAppRunEditLastTurn(multiple.input)).rejects.toMatchObject({ brief: { stage: 'frontdoor' } })
    noCommit(multiple)
  })

  it('fails closed when the native facet disappears or deferred trust rejects', async () => {
    const absent = await fixture()
    absent.input.forkLastTurnFacet = () => undefined
    await expect(prepareAppRunEditLastTurn(absent.input)).rejects.toMatchObject({ brief: { stage: 'capability' } })
    expect(absent.getMcp).not.toHaveBeenCalled()
    noCommit(absent)
    const denied = await fixture()
    denied.getMcp.mockImplementation(() => { throw new Error('fingerprint changed') })
    await expect(prepareAppRunEditLastTurn(denied.input)).rejects.toThrow('fingerprint changed')
    expect(denied.fork).not.toHaveBeenCalled()
    noCommit(denied)
  })

  it('never commits or replays a fork when native completion is unknown, the id is missing or prefix copy fails', async () => {
    const unknown = await fixture()
    unknown.fork.mockRejectedValueOnce(new Error('native result unknown'))
    await expect(prepareAppRunEditLastTurn(unknown.input)).rejects.toThrow('native result unknown')
    expect(unknown.fork).toHaveBeenCalledOnce()
    noCommit(unknown)
    const missing = await fixture()
    missing.fork.mockResolvedValueOnce({})
    await expect(prepareAppRunEditLastTurn(missing.input)).rejects.toThrow('Provider 未返回分支会话 ID')
    expect(missing.fork).toHaveBeenCalledOnce()
    noCommit(missing)
    const failedCopy = await fixture()
    failedCopy.clone.mockImplementation(() => { throw new Error('prefix copy failed') })
    await expect(prepareAppRunEditLastTurn(failedCopy.input)).rejects.toThrow('prefix copy failed')
    expect(failedCopy.fork).toHaveBeenCalledOnce()
    expect(failedCopy.clone).toHaveBeenCalledOnce()
    expect(failedCopy.commit).not.toHaveBeenCalled()
  })

  it('restarts only an exact all-interrupted local archive without any native boundary', async () => {
    const f = await fixture([interrupted('old-local', 1), interrupted('head-local', 2)])
    f.input.request = { restartLastTurn: { replaceRunId: 'head-local' } }
    await prepareAppRunEditLastTurn(f.input)
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.getMcp).not.toHaveBeenCalled()
    expect(f.clone).not.toHaveBeenCalled()
    for (const turns of [[previous, interrupted('head-local', 2)],
      [{ ...interrupted('old-local', 1), status: 'completed' as const }, interrupted('head-local', 2)],
      [interrupted('different-head', 2)]]) {
      const rejected = await fixture(turns)
      rejected.input.request = { restartLastTurn: { replaceRunId: 'head-local' } }
      await expect(prepareAppRunEditLastTurn(rejected.input)).rejects.toMatchObject({ brief: { stage: 'frontdoor' } })
      expect(rejected.fork).not.toHaveBeenCalled()
      noCommit(rejected)
    }
  })
})
