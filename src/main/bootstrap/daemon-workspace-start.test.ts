import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartRequest } from '../../shared/runtime'
import type { DaemonRunTransport } from '../daemon-run-transport'
import type { DaemonRunRuntime } from '../daemon-run-runtime'
import { createDaemonRunSurface, routingDetail } from './daemon-run-surface'


const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const selection = {
  operationId: '11111111-1111-4111-8111-111111111111',
  intent: { kind: 'newWorktree' as const, repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64),
    base: { kind: 'local' as const, name: 'refs/heads/main', head: 'c'.repeat(40) }, newBranch: 'topic' }
}

function project(): { source: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), 'scry-daemon-workspace-'))
  dirs.push(root)
  mkdirSync(join(root, 'source'))
  mkdirSync(join(root, 'other'))
  return { source: join(root, 'source'), other: join(root, 'other') }
}

const request = (cwd: string): AgentStartRequest => ({
  prompt: 'go', providerId: 'claude', cwd, commandId: 'command-1', expectedExternalSessionId: null, workspace: selection
})

describe('daemon workspace start', () => {
  it('sends the workspace selection to the daemon instead of a plain turn', () => {
    expect(JSON.parse(routingDetail(request('/w'), '/w')).workspace).toEqual(selection)
    expect(JSON.parse(routingDetail({ prompt: 'go', providerId: 'claude', cwd: '/w' }, '/w')).workspace).toBeUndefined()
  })

  it('answers the registered workspace from the daemon journal and follows the run there', async () => {
    const { source } = project()
    const prepared = { operationId: selection.operationId, repositoryId: 'a'.repeat(64), cwd: '/managed/worktree',
      worktreeId: 'd'.repeat(24), branchRef: 'refs/heads/topic', head: 'c'.repeat(40) }
    const localOp = vi.fn(async () => ({ status: 'available', data: { phase: 'registered', runId: 'remote-run-1', commandId: 'ledger', workspace: prepared } }))
    const runtime = {
      start: vi.fn(async (input: { intentId: string }) => ({ intentId: input.intentId, runId: 'remote-run-1', bound: true })),
      runView: () => null, activeRuns: () => [], isTracking: () => true
    } as unknown as DaemonRunRuntime
    const send = vi.fn()
    const value = createDaemonRunSurface({ transport: { localOp } as unknown as DaemonRunTransport, runtime, currentCwd: () => source, send })
    await expect(value.start(request(source))).resolves.toEqual({ runId: 'remote-run-1', workspace: prepared })
    expect(localOp).toHaveBeenCalledWith({ op: 'workspaceSelection', method: 'inspectStart', read: false,
      args: [{ repositoryId: 'a'.repeat(64), operationId: selection.operationId }] })
    expect(send).toHaveBeenCalledWith('agent:focusedRun', expect.objectContaining({ runId: 'remote-run-1', cwd: '/managed/worktree' }))
  })

  it('reports a start the journal does not show registered for this run', async () => {
    const { source } = project()
    const localOp = vi.fn(async () => ({ status: 'available', data: { phase: 'start_requested', runId: 'remote-run-1' } }))
    const runtime = {
      start: vi.fn(async (input: { intentId: string }) => ({ intentId: input.intentId, runId: 'remote-run-1', bound: true })),
      runView: () => null, activeRuns: () => [], isTracking: () => true
    } as unknown as DaemonRunRuntime
    const value = createDaemonRunSurface({ transport: { localOp } as unknown as DaemonRunTransport, runtime, currentCwd: () => source })
    await expect(value.start(request(source))).rejects.toThrow('daemon_workspace_unconfirmed')
  })

  it('refuses before submitting when the window moved to another project', async () => {
    const { source, other } = project()
    const runtime = { start: vi.fn(), activeRuns: () => [], isTracking: () => true } as unknown as DaemonRunRuntime
    const value = createDaemonRunSurface({ transport: {} as unknown as DaemonRunTransport, runtime, currentCwd: () => other })
    await expect(value.start(request(source))).rejects.toThrow('发送前项目已切换')
    expect(runtime.start).not.toHaveBeenCalled()
  })
})
