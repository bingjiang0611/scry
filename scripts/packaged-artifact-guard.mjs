import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractFile } from '@electron/asar'

// The security smoke can drive two different artifacts: the source build (--dev) or a
// packaged app. A packaged artifact that predates the source answers with older IPC
// envelopes, so its assertions read like a source regression that is really a stale
// build. Compare versions before launching, and say what to do about it.
export function packagedArtifactVersion(appPath, platform = process.platform) {
  if (platform === 'darwin') {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  }
  // electron-builder.yml packs the app into resources/app.asar; an unpacked resources/app
  // is only read when no archive exists, so a stale loose copy cannot answer for it.
  const archive = join(appPath, 'resources', 'app.asar')
  const manifest = existsSync(archive)
    ? extractFile(archive, 'package.json').toString('utf8')
    : readFileSync(join(appPath, 'resources', 'app', 'package.json'), 'utf8')
  return JSON.parse(manifest).version
}

export function assertArtifactMatchesSource(appPath, { platform = process.platform, sourcePackage = 'package.json' } = {}) {
  const artifactVersion = packagedArtifactVersion(appPath, platform)
  const sourceVersion = JSON.parse(readFileSync(resolve(sourcePackage), 'utf8')).version
  if (artifactVersion === sourceVersion) return sourceVersion
  // Not a warning: continuing would assert against the wrong build and report a
  // failure that has nothing to do with the source under test.
  console.error(`[scry] 产物过期，请先 npm run pack:artifact：${appPath} 是 ${artifactVersion ?? '未知版本'}，源码是 ${sourceVersion}`)
  process.exit(2)
}
