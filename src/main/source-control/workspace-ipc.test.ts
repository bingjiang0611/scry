import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from '../ipc-trust'
import { SourceControlService } from './service'
import { registerWorkspaceSelectionIpc } from './workspace-ipc'

it('rejects untrusted senders and malformed selection payloads before privileged methods run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-workspace-ipc-'))
  const service = new SourceControlService({
    userData: root, authorizeDirectory: cwd => cwd, unsettledDirectories: () => []
  })
  try {
    const reads = vi.spyOn(service, 'workspaceChoices').mockResolvedValue({ status: 'unavailable', reason: 'fixture' })
    const names = vi.spyOn(service, 'validateWorkspaceBranch').mockResolvedValue({ status: 'unavailable', reason: 'fixture' })
    const inspections = vi.spyOn(service, 'inspectWorkspaceStart').mockResolvedValue({ status: 'unavailable', reason: 'fixture' })
    const frame = { url: 'file:///app/renderer/index.html' }
    const contents = { mainFrame: frame }
    const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => unknown>()
    registerWorkspaceSelectionIpc((channel, listener) => {
      registerTrustedIpcHandler({ handle: (name, wrapped) => { handlers.set(name, wrapped) } },
        channel, () => win, frame.url, listener)
    }, service)
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const invoke = async (channel: string, payload: unknown, sender = event) => handlers.get(channel)!(sender, payload)
    const requests = [
      ['workspaceSelection:read', { cwd: root, kind: 'branches' }],
      ['workspaceSelection:validateBranch', { repositoryId: 'a'.repeat(64), name: 'valid' }],
      ['workspaceSelection:inspectStart', { repositoryId: 'a'.repeat(64), operationId: 'f4826a0a-ef56-4309-8d70-e3cd76f0181c' }]
    ] as const
    for (const [channel, payload] of requests) {
      for (const sender of [
        { ...event, sender: {} },
        { ...event, senderFrame: { url: frame.url } }
      ]) await expect(invoke(channel, payload, sender as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
      for (const invalid of [null, [], 1, {}]) await expect(invoke(channel, invalid)).rejects.toThrow()
    }
    for (const payload of [
      { cwd: root, kind: 'arbitrary-command' },
      { cwd: root, kind: 'branches', query: '\0' },
      { cwd: root, kind: 'branches', cursor: { revision: 'a'.repeat(24), offset: -1 } },
      { cwd: root, kind: 'branches', cursor: { revision: 'a'.repeat(24), offset: 1001 } },
      { cwd: root, kind: 'branches', cursor: { revision: 'stale', offset: 100 } }
    ]) await expect(invoke('workspaceSelection:read', payload)).rejects.toThrow()
    await expect(invoke('workspaceSelection:validateBranch', { repositoryId: '../escape', name: 'valid' })).rejects.toThrow()
    await expect(invoke('workspaceSelection:inspectStart', { repositoryId: 'a'.repeat(64), operationId: '../escape' })).rejects.toThrow()
    expect(reads).not.toHaveBeenCalled()
    expect(names).not.toHaveBeenCalled()
    expect(inspections).not.toHaveBeenCalled()
    for (const [channel, payload] of requests) await expect(invoke(channel, payload))
      .resolves.toEqual({ status: 'unavailable', reason: 'fixture' })
    expect(reads).toHaveBeenCalledExactlyOnceWith(requests[0][1])
    expect(names).toHaveBeenCalledExactlyOnceWith(requests[1][1])
    expect(inspections).toHaveBeenCalledExactlyOnceWith(requests[2][1])
    reads.mockClear()
    names.mockClear()
    inspections.mockClear()
    frame.url = 'https://untrusted.invalid/'
    for (const [channel, payload] of requests) await expect(invoke(channel, payload)).rejects.toThrow('非可信 renderer')
    expect(reads).not.toHaveBeenCalled()
    expect(names).not.toHaveBeenCalled()
    expect(inspections).not.toHaveBeenCalled()
  } finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
