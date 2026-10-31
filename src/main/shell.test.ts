import { afterEach, describe, expect, it } from 'vitest'
import { defaultShellPath, ensureShellEnv } from './shell'

const originalComspec = process.env.COMSPEC

afterEach(() => {
  if (originalComspec === undefined) delete process.env.COMSPEC
  else process.env.COMSPEC = originalComspec
})

describe('平台默认 shell', () => {
  it('macOS 与 Linux 各自使用系统自带 shell，而不是把 zsh 带到 Linux', () => {
    expect(defaultShellPath('darwin')).toBe('/bin/zsh')
    expect(defaultShellPath('linux')).toBe('/bin/bash')
  })

  it('Windows 使用 ComSpec', () => {
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
    expect(defaultShellPath('win32')).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('启动时补齐 SHELL', () => {
  it('Linux 桌面入口没有 SHELL 时补 bash，采集与终端不再指向 zsh', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureShellEnv(env, 'linux')
    expect(env.SHELL).toBe('/bin/bash')
  })

  it('不覆盖用户已有的 SHELL', () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/usr/bin/fish' }
    ensureShellEnv(env, 'linux')
    expect(env.SHELL).toBe('/usr/bin/fish')
  })
})
