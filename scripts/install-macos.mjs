import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { installBundle } from './install-macos-core.mjs'

if (process.platform !== 'darwin') {
  throw new Error('install:mac 仅支持 macOS')
}

const source = join(process.cwd(), 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app')
const installRoot = process.env.SCRY_INSTALL_DIR || '/Applications'

if (!existsSync(source)) {
  throw new Error(`找不到打包产物：${source}`)
}

const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const expectedVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version

function run(command, args, capture = false) {
  const result = spawnSync(command, args, capture ? { encoding: 'utf8' } : { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败：exit ${result.status}`)
  return capture ? String(result.stdout).trim() : ''
}

function validateBundle(path) {
  accessSync(join(path, 'Contents', 'MacOS', 'Scry'), constants.X_OK)
  if (!existsSync(join(path, 'Contents', 'Resources', 'app.asar'))) throw new Error('安装包缺少 Resources/app.asar')
  const plist = join(path, 'Contents', 'Info.plist')
  const bundleId = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], true)
  const version = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], true)
  if (bundleId !== 'com.scry.app') throw new Error(`bundle id 不匹配：${bundleId}`)
  if (version !== expectedVersion) throw new Error(`版本不匹配：expected ${expectedVersion}, got ${version}`)
}

const installed = installBundle({
  source,
  installRoot,
  copyBundle: (from, to) => { run('/usr/bin/ditto', [from, to]) },
  validateBundle,
  registerBundle: (path) => { run(launchServices, ['-f', path]) },
  indexBundle: (path) => { run('/usr/bin/mdimport', ['-i', path]) },
  warn: (message) => console.warn(`[scry] ${message}`)
})

console.log(installed.target)
if (installed.backup) console.log(`backup: ${installed.backup}`)
