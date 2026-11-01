import { join } from 'node:path'

// 桌面产物在 macOS 是 .app bundle，在 Linux 是 electron-builder 的解包目录。
// 打包检查、security smoke、主机 smoke 和 App 私有 CLI 启动器必须共享这一份布局知识：
// 任何脚本自己拼路径，都会出现“检查通过、实际启动的是另一个可执行文件”。
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
    // electron-builder 的 linux 解包目录：<appPath>/scry + <appPath>/resources + <appPath>/locales。
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

// 本地 smoke 跑的是 node_modules 里未打包的 Electron，它同样按平台有不同布局。
export function electronDevLayout({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const appPath = join('node_modules', 'electron', 'dist', 'Electron.app')
    return { appPath, executable: join(appPath, 'Contents', 'MacOS', 'Electron') }
  }
  const appPath = join('node_modules', 'electron', 'dist')
  return { appPath, executable: join(appPath, 'electron') }
}
