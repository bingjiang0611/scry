import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeAgentStartRequest } from '../../shared/runtime'
import type { WorkspacePrepareProgress, WorkspaceStartSelection } from '../../shared/workspace-selection'
import { ScProcess } from './process'
import { SourceControlService } from './service'
import { parseGitCheckoutProgress } from './workspace-git'
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

async function newWorktreeSelection(branch: string): Promise<WorkspaceStartSelection> {
  const result = await service.workspaceChoices({ cwd, kind: 'branches' })
  if (result.status !== 'available') throw new Error(result.reason)
  return {
    operationId: randomUUID(),
    intent: {
      repositoryId: result.data.repositoryId,
      expectedRevision: result.data.revision,
      kind: 'newWorktree',
      base: { name: 'refs/heads/main', kind: 'local', head: result.data.head! },
      newBranch: branch
    }
  }
}

function request(workspace: WorkspaceStartSelection, prompt = 'task'): WorkspaceStartRequest {
  const commandId = randomUUID()
  return { ...normalizeAgentStartRequest({ prompt, cwd, commandId, expectedExternalSessionId: null }), cwd, commandId, workspace }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scry-workspace-progress-')))
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

describe('workspace worktree progress streaming and cancellation with real Git', { timeout: 15_000 }, () => {
  it('streams staged worktree progress with real Git checkout progress and parses stderr percentages strictly', async () => {
    expect(parseGitCheckoutProgress('Updating files:  42% (126/300)\rUpdating files: 100% (300/300), done.\n'))
      .toEqual({ completed: 300, total: 300, percent: 100 })
    expect(parseGitCheckoutProgress('Updating files: 120% (5/3)')).toBeNull()
    expect(parseGitCheckoutProgress('unrelated stderr line')).toBeNull()

    const events: WorkspacePrepareProgress[] = []
    const input = request(await newWorktreeSelection('progress/topic'))
    const result = await service.startWorkspace(input, start, undefined, {
      onProgress: (progress) => events.push(progress)
    })
    expect(result.workspace?.branchRef).toBe('refs/heads/progress/topic')
    const stages = events.map(event => event.stage)
    expect(stages[0]).toBe('preparing')
    expect(stages).toContain('checking_out')
    expect(stages).toContain('verifying')
    expect(stages.at(-1)).toBe('completed')
    const checkoutEvent = events.find(event => event.stage === 'checking_out')
    expect(checkoutEvent?.workspacePrepared).toBe(true)
    expect(checkoutEvent?.cancellable).toBe(true)
    expect(events.at(-1)?.cancellable).toBe(false)
  })

  it('cancels worktree creation cleanly before Provider handoff, cleans up directory and branch, and allows retry', async () => {
    const input = request(await newWorktreeSelection('cancel/topic'))
    const events: WorkspacePrepareProgress[] = []
    const cancelPromise = service.startWorkspace(input, start, undefined, {
      onProgress: (progress) => {
        events.push(progress)
        if (progress.stage === 'checking_out') {
          void service.cancelWorkspaceStart({
            repositoryId: input.workspace.intent.repositoryId,
            operationId: input.workspace.operationId
          })
        }
      }
    })
    await expect(cancelPromise).rejects.toThrow('workspace_start_cancelled')
    expect(providerCalls).toHaveLength(0)
    expect(events.some(event => event.stage === 'cancelled')).toBe(true)
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(git('for-each-ref', '--format=%(refname)', 'refs/heads/cancel/topic')).toBe('')
    // Repository is NOT stuck in unknown; sending again with the same operationId succeeds cleanly.
    const retried = await service.startWorkspace(input, start)
    expect(retried.workspace?.branchRef).toBe('refs/heads/cancel/topic')
    expect(providerCalls).toHaveLength(1)
  })

  it('refuses cancellation once Provider handoff has started', async () => {
    const input = request(await newWorktreeSelection('late-cancel/topic'))
    let cancelResult: boolean | undefined
    const result = await service.startWorkspace(input, async (target, runId, admit) => {
      cancelResult = await service.cancelWorkspaceStart({
        repositoryId: input.workspace.intent.repositoryId,
        operationId: input.workspace.operationId
      })
      return start(target, runId, admit)
    })
    expect(cancelResult).toBe(false)
    expect(result.workspace?.branchRef).toBe('refs/heads/late-cancel/topic')
    expect(providerCalls).toHaveLength(1)
  })
})
