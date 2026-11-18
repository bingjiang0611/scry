import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGED_MAIN_ENTRIES, parseSmokeArguments, privateCliEvidence, resolvePackagedApp } from './packaged.mjs'

// Fake electron-builder Linux layouts in a temp directory: <app>/scry, <app>/resources/app.asar.
// The platform is passed explicitly, so the same cases run on a macOS or Linux host.
const temps = []
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }) })
// Real path: macOS tmpdir() is behind a symlink, and the resolver returns real paths.
const tempDir = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'scry-packaged-smoke-test-'))); temps.push(path); return path }

function sourcePackage(root, version = '9.9.9') {
  const path = join(root, 'source-package.json')
  writeFileSync(path, JSON.stringify({ version }))
  return path
}

async function fakeApp(root, { name = 'scry', version = '9.9.9', entries = PACKAGED_MAIN_ENTRIES, archive = true } = {}) {
  const appPath = join(root, 'linux-unpacked')
  mkdirSync(join(appPath, 'resources'), { recursive: true })
  writeFileSync(join(appPath, name), '#!/bin/sh\nexit 0\n')
  chmodSync(join(appPath, name), 0o755)
  if (archive) {
    const source = join(root, 'asar-source')
    mkdirSync(join(source, 'out', 'main'), { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'scry', version }))
    for (const entry of entries) writeFileSync(join(source, 'out', 'main', entry), '// entry\n')
    await createPackage(source, join(appPath, 'resources', 'app.asar'))
  }
  return { appPath, executable: join(appPath, name) }
}

describe('daemon-mode smoke arguments', () => {
  it('reads --app and --log and refuses an option without its value', () => {
    expect(parseSmokeArguments([])).toEqual({ ok: true, app: undefined, log: undefined })
    expect(parseSmokeArguments(['--app', 'dist/linux-unpacked/scry', '--log', 'x.log'])).toEqual({ ok: true, app: 'dist/linux-unpacked/scry', log: 'x.log' })
    expect(parseSmokeArguments(['--app'])).toMatchObject({ ok: false, reason: 'argument_value_missing' })
    expect(parseSmokeArguments(['--app', '--log', 'x'])).toMatchObject({ ok: false, reason: 'argument_value_missing' })
    expect(parseSmokeArguments(['--no-sandbox'])).toMatchObject({ ok: false, reason: 'unknown_argument' })
  })
})

describe('resolvePackagedApp fails closed on anything but a current packaged layout', () => {
  it('accepts the packaged executable and derives the archive the daemon must run from', async () => {
    const root = tempDir()
    const { appPath, executable } = await fakeApp(root)
    const target = resolvePackagedApp(executable, { platform: 'linux', sourcePackage: sourcePackage(root) })
    expect(target).toMatchObject({ ok: true, packaged: true, executable, appPath, version: '9.9.9' })
    expect(target.appArchive).toBe(join(target.resources, 'app.asar'))
    expect(target.entryDirectory).toBe(join(target.resources, 'app.asar', 'out', 'main'))
  })

  it('refuses a missing executable', () => {
    const root = tempDir()
    expect(resolvePackagedApp(join(root, 'nope', 'scry'), { platform: 'linux', sourcePackage: sourcePackage(root) }))
      .toMatchObject({ ok: false, reason: 'app_executable_missing' })
    expect(resolvePackagedApp(undefined, { platform: 'linux' })).toMatchObject({ ok: false, reason: 'app_argument_missing' })
  })

  it('refuses a dev Electron binary even beside a packaged archive', async () => {
    const root = tempDir()
    const { executable } = await fakeApp(root, { name: 'electron' })
    expect(resolvePackagedApp(executable, { platform: 'linux', sourcePackage: sourcePackage(root) }))
      .toMatchObject({ ok: false, reason: 'app_executable_not_packaged_layout' })
  })

  it('refuses a directory with no app.asar (an unpacked source tree is not the artifact)', async () => {
    const root = tempDir()
    const { executable } = await fakeApp(root, { archive: false })
    expect(resolvePackagedApp(executable, { platform: 'linux', sourcePackage: sourcePackage(root) }))
      .toMatchObject({ ok: false, reason: 'app_not_packaged' })
  })

  it('refuses an archive missing a daemon entry or a worker', async () => {
    const root = tempDir()
    const { executable } = await fakeApp(root, { entries: PACKAGED_MAIN_ENTRIES.filter((entry) => entry !== 'terminal-recording-worker.js') })
    expect(resolvePackagedApp(executable, { platform: 'linux', sourcePackage: sourcePackage(root) }))
      .toMatchObject({ ok: false, reason: 'app_archive_missing_entries', missing: ['terminal-recording-worker.js'] })
  })

  it('refuses an artifact older than the source', async () => {
    const root = tempDir()
    const { executable } = await fakeApp(root, { version: '1.0.0' })
    expect(resolvePackagedApp(executable, { platform: 'linux', sourcePackage: sourcePackage(root, '1.0.1') }))
      .toMatchObject({ ok: false, reason: 'app_artifact_stale', artifactVersion: '1.0.0', sourceVersion: '1.0.1' })
  })

  it('refuses a file that is not executable', async () => {
    const root = tempDir()
    const { executable } = await fakeApp(root)
    chmodSync(executable, 0o644)
    expect(resolvePackagedApp(executable, { platform: 'linux', sourcePackage: sourcePackage(root) }))
      .toMatchObject({ ok: false, reason: 'app_executable_not_executable' })
  })
})

describe('privateCliEvidence', () => {
  async function packagedWithCli(root, script = '#!/bin/sh\necho 0.2.56\n') {
    const { executable } = await fakeApp(root)
    const target = resolvePackagedApp(executable, { platform: 'linux', sourcePackage: sourcePackage(root) })
    mkdirSync(join(target.resources, 'bin'), { recursive: true })
    mkdirSync(join(target.resources, 'scry-cli'), { recursive: true })
    writeFileSync(join(target.resources, 'scry-cli', 'package.json'), JSON.stringify({ version: '0.2.56' }))
    if (script !== null) {
      writeFileSync(join(target.resources, 'bin', 'scry'), script)
      chmodSync(join(target.resources, 'bin', 'scry'), 0o755)
    }
    return target
  }

  it('runs the CLI the daemon resolved and requires the bundled version', async () => {
    const root = tempDir()
    const target = await packagedWithCli(root)
    expect(privateCliEvidence(target, target.resources)).toEqual({ ok: true, path: join(target.resources, 'bin', 'scry'), version: '0.2.56' })
    writeFileSync(join(target.resources, 'bin', 'scry'), '#!/bin/sh\necho 0.0.1\n')
    expect(privateCliEvidence(target, target.resources)).toMatchObject({ ok: false, reason: 'private_cli_version_mismatch', actual: '0.0.1' })
  })

  it('refuses a missing CLI, a CLI outside the resources, and a daemon with no resources', async () => {
    const root = tempDir()
    const missing = await packagedWithCli(join(root, 'a'), null)
    expect(privateCliEvidence(missing, missing.resources)).toMatchObject({ ok: false, reason: 'private_cli_missing' })
    expect(privateCliEvidence(missing, null)).toMatchObject({ ok: false, reason: 'daemon_resources_unavailable' })
    expect(privateCliEvidence({ ...missing, packaged: false }, missing.resources)).toMatchObject({ ok: false, reason: 'not_packaged' })

    const escaped = await packagedWithCli(join(root, 'b'), null)
    const outside = join(root, 'outside-scry')
    writeFileSync(outside, '#!/bin/sh\necho 0.2.56\n')
    chmodSync(outside, 0o755)
    symlinkSync(outside, join(escaped.resources, 'bin', 'scry'))
    expect(privateCliEvidence(escaped, escaped.resources)).toMatchObject({ ok: false, reason: 'private_cli_outside_resources' })
  })
})
