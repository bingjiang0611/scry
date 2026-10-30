import { describe, expect, it, vi } from 'vitest'

// 该模块顶层只读取 electron 的 app/safeStorage，测试只用到纯函数分支。
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/scry-test' }, safeStorage: {} }))

const { unsafeCredentialStorageReason } = await import('./remote-connections')

describe('远程凭据安全存储检查', () => {
  it('加密可用且后端为密钥环时放行', () => {
    expect(unsafeCredentialStorageReason({ platform: 'linux', encryptionAvailable: true, storageBackend: 'gnome_libsecret' })).toBeUndefined()
    expect(unsafeCredentialStorageReason({ platform: 'linux', encryptionAvailable: true, storageBackend: 'kwallet6' })).toBeUndefined()
  })

  it('Linux 的 basic_text 后端必须拒绝，即使 isEncryptionAvailable 为 true', () => {
    const reason = unsafeCredentialStorageReason({ platform: 'linux', encryptionAvailable: true, storageBackend: 'basic_text' })
    expect(reason).toContain('basic_text')
    expect(reason).toContain('安全保存远程设备凭据')
  })

  it('加密不可用时拒绝并说明原因', () => {
    expect(unsafeCredentialStorageReason({ platform: 'darwin', encryptionAvailable: false })).toBe('系统安全存储不可用，无法保存远程设备凭据')
  })

  it('macOS 不读取 Linux 的后端名称，也不会被 basic_text 影响', () => {
    expect(unsafeCredentialStorageReason({ platform: 'darwin', encryptionAvailable: true, storageBackend: 'basic_text' })).toBeUndefined()
  })
})
