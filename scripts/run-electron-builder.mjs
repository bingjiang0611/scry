import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

function localSigningIdentity() {
  if (process.platform !== 'darwin') return null
  const result = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const identities = [...result.stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  return identities.find((identity) => identity.startsWith('Developer ID Application:')) ??
    identities.find((identity) => identity.startsWith('Apple Development:')) ??
    null
}

const env = { ...process.env }
if (!env.CSC_NAME && !env.CSC_LINK && env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') {
  const identity = localSigningIdentity()
  if (identity) {
    env.CSC_NAME = identity
    console.log(`[scry] signing macOS app with ${identity}`)
  } else if (process.platform === 'darwin') {
    console.warn('[scry] no code-signing identity found; macOS Dock badge requires a signed build')
  }
}

const builder = join(process.cwd(), 'node_modules', '.bin', 'electron-builder')
const result = spawnSync(builder, ['--dir'], { env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`electron-builder failed with exit ${result.status ?? 'unknown'}`)
