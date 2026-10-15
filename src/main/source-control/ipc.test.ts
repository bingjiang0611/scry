import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from '../ipc-trust'
import { parseScMutation, registerSourceControlIpc } from './ipc'
import type { SourceControlService } from './service'

const expected = { repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64), operationId: randomUUID() }

describe('production source-control IPC boundary', () => {
  it('rejects every source-control channel from wrong sender/frame/origin before the service runs', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(name, handler)
      }
    }
    const entry = 'file:///app/renderer/index.html'
    const frame = { url: entry }
    const contents = { mainFrame: frame, isDestroyed: () => false }
    const window = { webContents: contents, isDestroyed: () => false }
    const methods = [
      'read',
      'diff',
      'mutate',
      'operations',
      'reconcile',
      'acknowledge',
      'pullRequests',
      'pullRequest',
      'saveDraft',
      'loadDraft',
      'saveCommitDraft',
      'loadCommitDraft'
    ]
    const privileged = Object.fromEntries(methods.map((method) => [method, vi.fn()]))
    registerSourceControlIpc(
      (channel, listener) =>
        registerTrustedIpcHandler(
          ipcMain,
          channel,
          () => window as unknown as BrowserWindow,
          entry,
          listener
        ),
      privileged as unknown as SourceControlService
    )
    expect(handlers.size).toBe(methods.length)
    for (const handler of handlers.values()) {
      for (const event of [
        { sender: {}, senderFrame: frame },
        { sender: contents, senderFrame: { url: entry } }
      ]) {
        expect(() => handler(event as IpcMainInvokeEvent, {})).toThrow('非可信 renderer')
      }
      frame.url = 'https://evil.invalid/'
      expect(() =>
        handler({ sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent, {})
      ).toThrow('非可信 renderer')
      frame.url = entry
    }
    for (const method of methods) expect(privileged[method]).not.toHaveBeenCalled()
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    expect(() =>
      handlers.get('sourceControl:mutate')!(event, { ...expected, action: 'stage', paths: ['../outside'] })
    ).toThrow('相对')
    expect(() => handlers.get('sourceControl:mutate')!(event, { ...expected, action: 'commit', message: 'commit', paths: ['../outside'] })).toThrow('相对')
    expect(privileged.mutate).not.toHaveBeenCalled()
    handlers.get('sourceControl:mutate')!(event, { ...expected, action: 'stage', paths: ['safe name.ts'] })
    expect(privileged.mutate).toHaveBeenCalledWith({ ...expected, action: 'stage', paths: ['safe name.ts'] })
  })

  it('validates and deduplicates guided commit paths without requiring new paths for existing index', () => {
    expect(parseScMutation({ ...expected, action: 'commit', message: 'commit', paths: ['safe name.ts', 'safe name.ts'] }))
      .toEqual({ ...expected, action: 'commit', message: 'commit', paths: ['safe name.ts'] })
    expect(parseScMutation({ ...expected, action: 'commit', message: 'commit', paths: [] })).toMatchObject({ paths: [] })
  })

  it.each([
    { action: 'shell', command: 'rm -rf /' },
    { action: 'stage', paths: ['.git/config'] },
    { action: 'stage', paths: ['/etc/passwd'] },
    { action: 'stage', paths: [] },
    { action: 'push', remote: '--receive-pack=evil' },
    { action: 'merge', repository: 'https://evil.invalid', number: 1 },
    { action: 'review', repository: 'owner/repo', number: Number.NaN },
    { action: 'commit', message: 'bad\0message' },
    { action: 'commit', message: 'commit', paths: ['.git/config'] },
    { action: 'commit', message: 'commit', paths: 'not-an-array' },
    { action: 'commit', message: 'commit', paths: Array(1001).fill('file.txt') }
  ])('rejects malformed privileged payload %#', (payload) => {
    expect(() => parseScMutation({ ...expected, ...payload })).toThrow()
  })
})
