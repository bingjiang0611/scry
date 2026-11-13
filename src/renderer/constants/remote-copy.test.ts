import { describe, expect, it } from 'vitest'
import { errorText } from '../components/RemoteChatShared'
import { REMOTE_ACCESS_COPY, REMOTE_SESSION_COPY } from './remote-copy'

describe('remote access error copy', () => {
  it('turns proven SSH forwarding failures into actionable copy', () => {
    expect(REMOTE_ACCESS_COPY.errorText(new Error(
      "Error invoking remote method 'desktopRemote:connect': Error: desktop_ssh_target_unreachable"
    ))).toContain('远端 Scry 服务不可达')
    expect(REMOTE_ACCESS_COPY.errorText(new Error('desktop_ssh_forwarding_denied'))).toContain('拒绝端口转发')
    expect(REMOTE_ACCESS_COPY.errorText(new Error(
      "Error invoking remote method 'desktopRemote:history': Error: desktop_tls_request_eof"
    ))).toContain('远端 Scry 在响应前关闭了连接')
  })

  it('formats remote chat polling errors without losing session-specific copy', () => {
    expect(errorText(new Error(
      "Error invoking remote method 'desktopRemote:history': Error: desktop_tls_request_eof"
    ))).toContain('远端 Scry 在响应前关闭了连接')
    expect(errorText(new Error(
      "Error invoking remote method 'desktopRemote:liveRun': Error: desktop_session_operation_unknown"
    ))).toBe(REMOTE_SESSION_COPY.operationUnknown)
  })

  it('removes IPC implementation details from unknown errors', () => {
    expect(REMOTE_ACCESS_COPY.errorText(new Error(
      "Error invoking remote method 'desktopRemote:connect': Error: device_certificate_expired"
    ))).toBe('device_certificate_expired')
    expect(REMOTE_ACCESS_COPY.errorText(new Error("Error invoking remote method 'desktopRemote:connect': Error: ")))
      .toBe('远程操作失败，未返回原因。')
  })
})
