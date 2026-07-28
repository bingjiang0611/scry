import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  throw new Error('install:mac 仅支持 macOS')
}

const source = join(process.cwd(), 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app')
const installRoot = process.env.SCRY_INSTALL_DIR || '/Applications'
const target = join(installRoot, 'Scry.app')

if (!existsSync(source)) {
  throw new Error(`找不到打包产物：${source}`)
}

mkdirSync(installRoot, { recursive: true })
rmSync(target, { recursive: true, force: true })

const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
for (const [command, args] of [
  ['/usr/bin/ditto', [source, target]],
  [launchServices, ['-f', target]],
  ['/usr/bin/mdimport', ['-i', target]]
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败：exit ${result.status}`)
}

console.log(target)
