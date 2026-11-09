import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from './ipc-error-copy'

describe('IPC error copy', () => {
  it('drops the Electron wrapper and keeps the handler message', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'agent:detect': Error: Provider 探测超时"))).toBe('Provider 探测超时')
  })

  it('names a channel the daemon has not migrated as not provided, not as an internal code', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'agent:detect': Error: daemon_capability_unavailable:agent:detect")))
      .toBe('后台服务尚未提供这项功能（agent:detect）')
  })

  it('never answers with an empty line', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x:y': Error: "))).toBe('未知错误')
    expect(ipcErrorMessage('plain')).toBe('plain')
  })
})
