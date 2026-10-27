import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAgentStartRequest } from '../../shared/runtime'
import type { WorkspaceIntent, WorkspaceStartSelection } from '../../shared/workspace-selection'
import { SourceControlService } from './service'
import { ScProcess } from './process'
import type { StartPreparedWorkspace, WorkspaceStartRequest } from './workspace-start'

let root: string
let cwd: string
let home: string
let userData: string
let service: SourceControlService
let authorized: Set<string>
let running: string[]
let registered: Map<string, string>
let providerCalls: string[]
const environment = () => ({ PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' })
const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env: environment(), encoding: 'utf8' }).trim()
const createService = () => new SourceControlService({
  userData, process: new ScProcess(environment), unsettledDirectories: () => running,
  authorizeDirectory: path => {
    if (!authorized.has(path)) throw new Error('revoked project')
    return path
  },
  registeredWorkspaceRun: (runId, path) => registered.get(runId) === path
})
const start: StartPreparedWorkspace = async (target, runId, admit) => {
  authorized.add(target.cwd)
  await admit(() => {
    registered.set(runId, target.cwd)
    running.push(target.cwd)
  })
  providerCalls.push(target.cwd)
  return { runId }
}
async function choices() {
  const result = await service.workspaceChoices({ cwd, kind: 'branches' })
  if (result.status !== 'available') throw new Error(result.reason)
  return result.data
}
async function selection(kind: 'current' | 'newWorktree', branch = 'generated/topic'): Promise<WorkspaceStartSelection> {
  const result = await choices()
  const expected = { repositoryId: result.repositoryId, expectedRevision: result.revision }
  const intent: WorkspaceIntent = kind === 'current' ? { ...expected, kind } : {
    ...expected, kind, base: { name: 'refs/heads/main', kind: 'local', head: result.head! }, newBranch: branch
  }
  return { operationId: randomUUID(), intent }
}
function request(workspace: WorkspaceStartSelection, prompt = 'task'): WorkspaceStartRequest {
  const commandId = randomUUID()
  return { ...normalizeAgentStartRequest({ prompt, cwd, commandId, expectedExternalSessionId: null }), cwd, commandId, workspace }
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scry-workspace-start-')))
  cwd = join(root, 'source with spaces')
  home = join(root, 'home')
  userData = join(root, 'data')
  await mkdir(cwd)
  await mkdir(home)
  authorized = new Set([cwd])
  running = []
  registered = new Map()
  providerCalls = []
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(cwd, 'base.txt'), 'initial\n')
  git('add', '.')
  git('commit', '-m', 'initial')
  service = createService()
})
afterEach(async () => {
  await service.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('atomic workspace first-send preparation with real Git', { timeout: 15_000 }, () => {
  it('starts current cwd once and binds a replay to the same message without exposing prompt bodies in the journal', async () => {
    await writeFile(join(cwd, 'base.txt'), 'source dirty\n')
    const input = request(await selection('current'), 'private message marker')
    const result = await service.startWorkspace(input, start)
    expect(result.workspace?.cwd).toBe(cwd)
    expect(providerCalls).toEqual([cwd])
    expect(await service.startWorkspace(input, start)).toEqual(result)
    expect(providerCalls).toHaveLength(1)
    await expect(service.startWorkspace({ ...input, prompt: 'different' }, start)).rejects.toThrow('另一条消息')
    const journal = await readFile(join(userData, 'source-control/operations', `${input.workspace.operationId}.json`), 'utf8')
    expect(journal).not.toContain('private message marker')
    expect(JSON.parse(journal).intent.workspace.phase).toBe('registered')
    expect(await readFile(join(cwd, 'base.txt'), 'utf8')).toBe('source dirty\n')
  })

  it('creates one host-owned worktree, preserves source dirt/index, and reuses preparation after a known pre-start failure and restart', async () => {
    await writeFile(join(cwd, 'base.txt'), 'source staged\n')
    git('add', 'base.txt')
    await writeFile(join(cwd, 'base.txt'), 'source working\n')
    const index = await readFile(join(cwd, '.git/index'))
    const input = request(await selection('newWorktree'))
    await expect(service.startWorkspace(input, async () => { throw new Error('trust rejected') })).rejects.toThrow('trust rejected')
    const status = await service.inspectWorkspaceStart({ ...input.workspace.intent, operationId: input.workspace.operationId })
    expect(status.status).toBe('available')
    if (status.status !== 'available') throw new Error(status.reason)
    if (!status.data) throw new Error('Expected persisted workspace preparation')
    expect(status.data.phase).toBe('prepared')
    expect(status.data.workspace?.cwd).toContain(join(userData, 'worktrees'))
    const target = status.data.workspace!.cwd
    expect(await readFile(join(target, 'base.txt'), 'utf8')).toBe('initial\n')
    expect(providerCalls).toEqual([])
    await service.dispose()
    service = createService()
    await choices()
    const result = await service.startWorkspace(input, start)
    expect(result.workspace?.cwd).toBe(target)
    const inventory = await service.workspaceChoices({ cwd, kind: 'worktrees' })
    expect(inventory.status).toBe('available')
    if (inventory.status !== 'available' || inventory.data.page.kind !== 'worktrees') throw new Error('Expected worktrees')
    expect(inventory.data.page.items[0].id).toBe(result.workspace?.worktreeId)
    expect(providerCalls).toEqual([target])
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
    expect(await readFile(join(cwd, '.git/index'))).toEqual(index)
    expect(await readFile(join(cwd, 'base.txt'), 'utf8')).toBe('source working\n')
  })

  it('reuses an already checked-out branch, rejects dirty switches, and creates worktrees without native hooks', async () => {
    const existing = join(root, 'already checked out')
    git('worktree', 'add', '-b', 'existing', existing)
    const input = request(await selection('current'))
    input.workspace.intent = { ...input.workspace.intent, kind: 'current', branch: {
      name: 'refs/heads/existing', head: git('rev-parse', 'existing'), kind: 'local'
    } }
    expect((await service.startWorkspace(input, start)).workspace?.cwd).toBe(existing)
    running = []
    git('branch', 'not-checked-out')
    await writeFile(join(cwd, 'base.txt'), 'dirty\n')
    const dirty = request(await selection('current'))
    dirty.workspace.intent = { ...dirty.workspace.intent, kind: 'current', branch: {
      name: 'refs/heads/not-checked-out', head: git('rev-parse', 'HEAD'), kind: 'local'
    } }
    await expect(service.startWorkspace(dirty, start)).rejects.toThrow('未提交改动')
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    const markers = ['post-checkout', 'post-index-change', 'reference-transaction'].map(name => ({
      hook: join(cwd, '.git/hooks', name), marker: join(root, `${name}-ran`)
    }))
    for (const { hook, marker } of markers) {
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`)
      await chmod(hook, 0o755)
    }
    const created = request(await selection('newWorktree', 'hooks-disabled'))
    expect((await service.startWorkspace(created, start)).workspace?.branchRef).toBe('refs/heads/hooks-disabled')
    for (const { marker } of markers) await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(providerCalls).toHaveLength(2)
  })

  it('holds the existing commonDir gate through delayed trust/baseline work and synchronous registration', async () => {
    const input = request(await selection('newWorktree'))
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const pending = service.startWorkspace(input, async (...args) => {
      enter()
      await held
      return start(...args)
    })
    try {
      await Promise.race([entered, pending.then(() => { throw new Error('unexpected early completion') })])
      const concurrent = vi.fn()
      await expect(service.admitRun(cwd, concurrent)).rejects.toThrow('源代码管理操作')
      expect(concurrent).not.toHaveBeenCalled()
      expect(providerCalls).toHaveLength(0)
      const queuedWrite = service.mutate({
        repositoryId: input.workspace.intent.repositoryId, expectedRevision: input.workspace.intent.expectedRevision,
        action: 'stage', paths: ['base.txt'], operationId: randomUUID()
      })
      release()
      await pending
      expect((await queuedWrite).status).toBe('failed')
      expect(providerCalls).toHaveLength(1)
    } finally {
      release()
      await pending.catch(() => {})
    }
  })

  it('treats an uncertain registration as unknown, reconciles only real run evidence, and never starts another Provider', async () => {
    const input = request(await selection('current'))
    await expect(service.startWorkspace(input, async (target, runId, admit) => {
      authorized.add(target.cwd)
      await admit(() => {
        registered.set(runId, target.cwd)
        throw new Error('registration response lost')
      })
      throw new Error('unreachable')
    })).rejects.toThrow('registration response lost')
    const record = await service.store.get(input.workspace.operationId)
    expect(record?.operation.status).toBe('unknown')
    expect(record?.intent.workspace?.phase).toBe('start_requested')
    const result = await service.startWorkspace(input, start)
    expect(result.runId).toBe(record?.intent.workspace?.launch?.runId)
    expect(providerCalls).toHaveLength(0)
  })

  it('does not replay an unknown Git dispatch or a start-requested journal without authoritative run evidence after restart', async () => {
    const input = request(await selection('newWorktree'))
    const actual = service.git.run.bind(service.git)
    const spy = vi.spyOn(service.git, 'run').mockImplementation(async (path, args, ...options) => {
      const result = await actual(path, args, ...options)
      if (args.includes('add') && args.includes('worktree')) throw new Error('Git response lost')
      return result
    })
    await expect(service.startWorkspace(input, start)).rejects.toThrow('Git response lost')
    spy.mockRestore()
    expect((await service.store.get(input.workspace.operationId))?.intent.workspace?.phase).toBe('git_requested')
    // Read-back can prove the target; it cannot invent a Provider result.
    const reconciled = await service.inspectWorkspaceStart({ ...input.workspace.intent, operationId: input.workspace.operationId })
    expect(reconciled.status === 'available' && reconciled.data?.phase).toBe('prepared')
    await expect(service.startWorkspace(input, async (target, _runId, admit) => {
      authorized.add(target.cwd)
      await admit(() => { throw new Error('registration unknown') })
      throw new Error('unreachable')
    })).rejects.toThrow('registration unknown')
    await service.dispose()
    service = createService()
    await choices()
    await expect(service.startWorkspace(input, start)).rejects.toThrow('结果仍未知')
    expect(providerCalls).toHaveLength(0)
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  })

  it('creates the new worktree from the base commit that is current now and starts the Provider after the selection moved', async () => {
    const input = request(await selection('newWorktree', 'follow/topic'))
    // 选择之后源工作区又出现改动与新提交：新建 worktree 不碰这个 checkout，不能因此拒绝发送。
    await writeFile(join(cwd, 'late.txt'), 'late\n')
    await writeFile(join(cwd, 'second.txt'), 'second\n')
    git('add', 'second.txt')
    git('commit', '-m', 'second')
    const baseHead = git('rev-parse', 'HEAD')
    const result = await service.startWorkspace(input, start)
    const parent = join(await realpath(userData), 'worktrees')
    const [repository] = await readdir(parent)
    expect(result.workspace?.cwd).toBe(join(parent, repository, input.workspace.operationId))
    expect(result.workspace?.branchRef).toBe('refs/heads/follow/topic')
    expect(result.workspace?.head).toBe(baseHead)
    expect(await readFile(join(result.workspace!.cwd, 'second.txt'), 'utf8')).toBe('second\n')
    expect(providerCalls).toEqual([result.workspace!.cwd])
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  })

  it('reuses an existing worktree and starts the Provider without matching the source snapshot', async () => {
    const created = await service.startWorkspace(request(await selection('newWorktree', 'reuse/topic')), start)
    const target = created.workspace!
    running = []
    const inventory = await service.workspaceChoices({ cwd, kind: 'worktrees' })
    if (inventory.status !== 'available' || inventory.data.page.kind !== 'worktrees') throw new Error('Expected worktrees')
    const tree = inventory.data.page.items.find(item => item.path === target.cwd)
    if (!tree) throw new Error('Expected the created worktree')
    const reuse: WorkspaceStartSelection = {
      operationId: randomUUID(),
      intent: { repositoryId: inventory.data.repositoryId, expectedRevision: inventory.data.revision,
        kind: 'existingWorktree', worktreeId: tree.id }
    }
    await writeFile(join(cwd, 'after-pick.txt'), 'changed\n')
    const result = await service.startWorkspace(request(reuse), start)
    expect(result.workspace?.cwd).toBe(target.cwd)
    expect(providerCalls).toEqual([target.cwd, target.cwd])
  })

  it('creates and starts a worktree while other runs in the same repository are still settling', async () => {
    const runningElsewhere = join(root, 'settling worktree')
    git('worktree', 'add', '-b', 'settling', runningElsewhere)
    running = [cwd, runningElsewhere]
    const input = request(await selection('newWorktree', 'parallel/topic'))
    const result = await service.startWorkspace(input, start)
    expect(result.workspace?.cwd).toContain(join(userData, 'worktrees'))
    expect(providerCalls).toEqual([result.workspace!.cwd])
    // 同一个仓库里未收口的 run 仍会挡住复用它自己的 worktree。
    const inventory = await service.workspaceChoices({ cwd, kind: 'worktrees' })
    if (inventory.status !== 'available' || inventory.data.page.kind !== 'worktrees') throw new Error('Expected worktrees')
    const busyTree = inventory.data.page.items.find(item => item.path === runningElsewhere)
    if (!busyTree) throw new Error('Expected the settling worktree')
    const reuse: WorkspaceStartSelection = {
      operationId: randomUUID(),
      intent: { repositoryId: inventory.data.repositoryId, expectedRevision: inventory.data.revision,
        kind: 'existingWorktree', worktreeId: busyTree.id }
    }
    running = [runningElsewhere]
    await expect(service.startWorkspace(request(reuse), start)).rejects.toThrow('占用')
  })

  it('still holds a create when a run cwd cannot be resolved to a repository', async () => {
    running = ['']
    const input = request(await selection('newWorktree', 'unknown/topic'))
    await expect(service.startWorkspace(input, start)).rejects.toThrow('占用')
    expect(providerCalls).toHaveLength(0)
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('switches the source checkout while a run in another worktree is settling', async () => {
    const other = join(root, 'other worktree')
    git('worktree', 'add', '-b', 'other', other)
    git('branch', 'switch-target')
    const input = request(await selection('current'))
    input.workspace.intent = { ...input.workspace.intent, kind: 'current', branch: {
      name: 'refs/heads/switch-target', head: git('rev-parse', 'switch-target'), kind: 'local'
    } }
    running = [other]
    const result = await service.startWorkspace(input, start)
    expect(result.workspace?.cwd).toBe(cwd)
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/switch-target')
  })

  it('rejects a stale branch switch, busy targets and revoked source authority before Provider dispatch', async () => {
    git('branch', 'switch-target')
    const stale = request(await selection('current'))
    stale.workspace.intent = { ...stale.workspace.intent, kind: 'current', branch: {
      name: 'refs/heads/switch-target', head: git('rev-parse', 'switch-target'), kind: 'local'
    } }
    await writeFile(join(cwd, 'new.txt'), 'changed\n')
    await expect(service.startWorkspace(stale, start)).rejects.toThrow('仓库已变化')
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    const busy = request(await selection('current'))
    running = [cwd]
    await expect(service.startWorkspace(busy, start)).rejects.toThrow('占用')
    running = []
    const revoked = request(await selection('newWorktree'))
    authorized.delete(cwd)
    await expect(service.startWorkspace(revoked, start)).rejects.toThrow('revoked project')
    expect(providerCalls).toHaveLength(0)
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })
})
