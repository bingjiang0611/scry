import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { releaseBuildEnvironment } from './release-policy.mjs'

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

const builder = join(process.cwd(), 'node_modules', '.bin', 'electron-builder')
// macOS 发布只出 .app（由 install:mac 安装）；Linux 发布要产出可安装的 pacman 包。
// 两种情况都保留 dist/<platform>-unpacked，供后续产物检查与 smoke 使用。
const args = releaseBuild && process.platform === 'linux'
  ? ['--linux', 'pacman']
  : ['--dir', ...(releaseBuild && process.platform === 'darwin' ? ['--config.mac.notarize=true'] : [])]
const result = spawnSync(builder, args, { env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`electron-builder failed with exit ${result.status ?? 'unknown'}`)
