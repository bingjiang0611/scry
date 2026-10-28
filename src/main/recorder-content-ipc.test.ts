import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { registerRecorderContentIpc } from './recorder-content-ipc'

const readers = vi.hoisted(() => ({ app: vi.fn(), location: vi.fn(), recorder: vi.fn() }))
vi.mock('./trace-tool-content', () => ({ readAppTraceContentPage: readers.app }))
vi.mock('../core/turn-recorder/config', () => ({ resolveRecorderLocation: readers.location }))
vi.mock('./recorder-content-access', () => ({ readAuthorizedRecorderContentPage: readers.recorder }))
beforeEach(() => { readers.app.mockReset(); readers.location.mockReset(); readers.recorder.mockReset() })

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: never[]) => unknown>()
  let cwd: string | undefined = '/authorized/workspace'
  registerRecorderContentIpc({
    handleTrusted: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler) },
    currentCwd: () => cwd, userDataDir: () => '/isolated/userData'
  })
  // Reader completion sentinels test routing/fences only. Real bounded-reference
  // validation has separate recorder-content-access/trace-tool-content tests.
  const invoke = (request: unknown) => handlers.get('agent:recorderContentPage')!({} as IpcMainInvokeEvent, request as never)
  return { handlers, invoke, setCwd: (next: string | undefined) => { cwd = next } }
}

describe('recorder content IPC extraction', () => {
  it('registers without reading and rejects unknown sources before either reader', async () => {
    const f = fixture()
    expect([...f.handlers.keys()]).toEqual(['agent:recorderContentPage'])
    expect(readers.location).not.toHaveBeenCalled()
    await expect(f.invoke({ source: 'file', path: '/untrusted/path' })).rejects.toThrow('invalid_content_source')
    expect(readers.app).not.toHaveBeenCalled()
    expect(readers.recorder).not.toHaveBeenCalled()
  })

  it('uses current workspace and userData for App trace requests', async () => {
    const f = fixture(), request = { source: 'app-trace' }, page = { fixture: 'App reader completion' }
    readers.app.mockResolvedValue(page)
    f.setCwd('/another/authorized/workspace')
    await expect(f.invoke(request)).resolves.toBe(page)
    expect(readers.app).toHaveBeenCalledExactlyOnceWith('/isolated/userData', '/another/authorized/workspace', request)
    expect(readers.location).not.toHaveBeenCalled()
  })

  it('never returns an App page after the selected workspace changes during its read', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    readers.app.mockReturnValue(new Promise(done => { resolve = done }))
    const pending = f.invoke({ source: 'app-trace' })
    expect(readers.app).toHaveBeenCalledOnce()
    f.setCwd('/another/authorized/workspace')
    resolve({ fixture: 'must not escape old workspace' })
    await expect(pending).rejects.toThrow('recorder_workspace_changed')
  })

  it('rejects a missing workspace without resolving arbitrary recorder locations', async () => {
    const f = fixture()
    f.setCwd(undefined)
    await expect(f.invoke({ ref: 'untrusted' })).rejects.toThrow('recorder_workspace_unavailable')
    expect(readers.location).not.toHaveBeenCalled()
    expect(readers.recorder).not.toHaveBeenCalled()
  })

  it('rechecks workspace after location resolution before authorizing the recorder read', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    readers.location.mockReturnValue(new Promise(done => { resolve = done }))
    const pending = f.invoke({ ref: 'untrusted' })
    expect(readers.location).toHaveBeenCalledExactlyOnceWith('/authorized/workspace')
    f.setCwd('/another/authorized/workspace')
    resolve({ valid: true, dataRoot: '/old/authorized/data' })
    await expect(pending).rejects.toThrow('recorder_workspace_changed')
    expect(readers.recorder).not.toHaveBeenCalled()
  })

  it('uses only the resolved data root and retains unavailable reasons', async () => {
    const f = fixture(), request = { ref: 'validated by downstream reader', path: '/never-used' }
    readers.location.mockResolvedValue({ valid: false, reason: 'invalid_config' })
    await expect(f.invoke(request)).rejects.toThrow('recorder_unavailable:invalid_config')
    expect(readers.recorder).not.toHaveBeenCalled()
    readers.location.mockResolvedValue({ valid: true, dataRoot: '/authorized/recorder/data' })
    const page = { fixture: 'recorder reader completion' }
    readers.recorder.mockResolvedValue(page)
    await expect(f.invoke(request)).resolves.toBe(page)
    expect(readers.recorder).toHaveBeenCalledExactlyOnceWith('/authorized/recorder/data', request)
  })
})
