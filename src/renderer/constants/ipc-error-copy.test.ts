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

  it('says why the background service cannot answer, in words, keeping the code for support', () => {
    // Verification of be81d57 (B3): the file panel showed the raw IPC string.
    expect(ipcErrorMessage(new Error("Error invoking remote method 'workspace:read': Error: daemon_unavailable:daemon_userdata_owned")))
      .toBe('后台服务无法启动：这个数据目录正被另一个 Scry 进程使用（daemon_userdata_owned）')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'workspace:read': Error: daemon_unavailable:daemon_ready_timeout")))
      .toBe('后台服务无法启动（daemon_ready_timeout）')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'agent:setCwd': Error: daemon_not_running")))
      .toBe('后台服务未在运行，请稍后重试（daemon_not_running）')
  })

  it('never answers with an empty line', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x:y': Error: "))).toBe('未知错误')
    expect(ipcErrorMessage('plain')).toBe('plain')
  })
})
