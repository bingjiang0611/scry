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

  it('says the system keyring is the reason when the local daemon credential cannot be kept (B4-S F2)', () => {
    const raw = new Error("Error invoking remote method 'agent:start': Error: daemon_credential_unavailable:unsafe_credential_storage")
    const linux = ipcErrorMessage(raw, 'linux')
    expect(linux).toContain('系统密钥环不可用')
    expect(linux).toContain('无法保存本机后台服务的连接凭据')
    expect(linux).toContain('Secret Service 密钥环（例如 gnome-keyring）')
    expect(linux).toContain('（daemon_credential_unavailable:unsafe_credential_storage）')
    // The Linux advice is not offered where it was never checked.
    const mac = ipcErrorMessage(raw, 'macos')
    expect(mac).toContain('系统密钥环不可用')
    expect(mac).not.toContain('gnome-keyring')
    expect(ipcErrorMessage(new Error('daemon_credential_unavailable'), 'linux')).toContain('（daemon_credential_unavailable）')
  })

  it('shows a refused start the same in both modes: no wrapper, no internal class name (B4-S)', () => {
    const inProcess = new Error("Error invoking remote method 'agent:start': AgentRuntimeError: 同一会话已有一轮正在运行")
    const daemon = new Error("Error invoking remote method 'agent:start': Error: 同一会话已有一轮正在运行")
    expect(ipcErrorMessage(inProcess)).toBe('同一会话已有一轮正在运行')
    expect(ipcErrorMessage(daemon)).toBe('同一会话已有一轮正在运行')
    // Only the wrapper's own class prefix goes: a message that merely mentions one stays.
    expect(ipcErrorMessage(new Error("Error invoking remote method 'agent:start': 配置 AgentRuntimeError: x"))).toBe('配置 AgentRuntimeError: x')
  })

  it('never answers with an empty line', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x:y': Error: "))).toBe('未知错误')
    expect(ipcErrorMessage('plain')).toBe('plain')
  })
})
