// 平台默认登录 shell。macOS 自带 zsh，Arch/Omarchy 默认 bash：
// 当 SHELL 未设置时写死 zsh 会让桌面启动的环境采集和终端都失败。
export function defaultShellPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

// 从 Linux 桌面启动器启动时通常没有 SHELL，而登录 shell 采集、Provider CLI 和终端都依赖它。
// 在启动早期补上平台默认值，而不是在各处回退到可能不存在的 zsh。
// 已有的 SHELL 一律保留：用户的 shell 选择不能被覆盖。
export function ensureShellEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  env.SHELL ??= defaultShellPath(platform)
}
