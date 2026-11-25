import { join } from 'node:path'

// Verification and launch share this layout (ADR 020).
export function packagedAppLayout(appPath, { platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const contents = join(appPath, 'Contents')
    return {
      appPath,
      resources: join(contents, 'Resources'),
      executable: join(contents, 'MacOS', 'Scry'),
      locales: join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    }
  }
  if (platform === 'linux') {
    // 可执行文件名由 electron-builder.yml 的 executableName 固定，不是产品名。
    return {
      appPath,
      resources: join(appPath, 'resources'),
      executable: join(appPath, 'scry'),
      locales: join(appPath, 'locales')
    }
  }
  throw new Error(`不支持的桌面打包平台：${platform}`)
}

export function defaultPackagedAppPath({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') return join('dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app')
  if (platform === 'linux') return join('dist', arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked')
  throw new Error(`不支持的桌面打包平台：${platform}`)
}

export function electronDevLayout({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const appPath = join('node_modules', 'electron', 'dist', 'Electron.app')
    return { appPath, executable: join(appPath, 'Contents', 'MacOS', 'Electron') }
  }
  const appPath = join('node_modules', 'electron', 'dist')
  return { appPath, executable: join(appPath, 'electron') }
}
