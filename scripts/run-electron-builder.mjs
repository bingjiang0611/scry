import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import electronPath from 'electron'
import { releaseBuildEnvironment } from './release-policy.mjs'

// 随 Electron ABI 变化、必须与产物运行时可加载的原生模块。
const nativeModules = ['better-sqlite3', 'node-pty']

function localSigningIdentity() {
  if (process.platform !== 'darwin') return null
  const result = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const identities = [...result.stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  return identities.find((identity) => identity.startsWith('Developer ID Application:')) ??
    identities.find((identity) => identity.startsWith('Apple Development:')) ??
    null
}

let env = { ...process.env }
const releaseBuild = env.SCRY_RELEASE_BUILD === '1'
if (!env.CSC_NAME && !env.CSC_LINK && env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') {
  const identity = localSigningIdentity()
  if (identity) {
    env.CSC_NAME = identity
    console.log(`[scry] signing macOS app with ${identity}`)
  } else if (process.platform === 'darwin' && !releaseBuild) {
    console.warn('[scry] no code-signing identity found; this output is development-only')
  }
}
env = releaseBuildEnvironment({
  releaseBuild,
  platform: process.platform,
  env,
  discoveredIdentity: env.CSC_NAME || localSigningIdentity()
})

// electron-builder 自带的 rebuild 在模块已存在时可能静默跳过：实测 non-forced
// electron-rebuild 0.6s 返回、二进制仍是 Node ABI，产物里的 SQLite 会降级成 unavailable。
// 所以打包前强制按 Electron ABI 重建，再用 Electron 本身加载一次做 fail-closed 校验。
function assertNativeModulesLoadInElectron() {
  // better-sqlite3 的 native binding 在构造时才加载，裸 require 不触发绑定，必须先建一次库。
  const probe = "require('better-sqlite3')(':memory:').exec('create table probe(a)');require('node-pty')"
  const result = spawnSync(electronPath, ['-e', probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`原生模块无法被 Electron 加载，继续打包会得到降级产物：\n${(result.stderr || result.stdout || '').slice(-2000)}`)
  }
}

function rebuildNativeModules() {
  const rebuild = join(process.cwd(), 'node_modules', '.bin', 'electron-rebuild')
  const args = ['-f', ...nativeModules.flatMap((name) => ['-w', name])]
  const result = spawnSync(rebuild, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`electron-rebuild failed with exit ${result.status ?? 'unknown'}`)
  assertNativeModulesLoadInElectron()
  console.log('[scry] native modules rebuilt for Electron and verified')
}

const builder = join(process.cwd(), 'node_modules', '.bin', 'electron-builder')
// macOS 发布只出 .app（由 install:mac 安装）；Linux 发布要产出可安装的 pacman 包。
// 两种情况都保留 dist/<platform>-unpacked，供后续产物检查与 smoke 使用。
const args = releaseBuild && process.platform === 'linux'
  ? ['--linux', 'pacman']
  : ['--dir', ...(releaseBuild && process.platform === 'darwin' ? ['--config.mac.notarize=true'] : [])]
rebuildNativeModules()
const result = spawnSync(builder, args, { env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`electron-builder failed with exit ${result.status ?? 'unknown'}`)
