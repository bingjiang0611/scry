import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseBuildEnvironment } from './release-policy.mjs'

const source = readFileSync(new URL('./run-electron-builder.mjs', import.meta.url), 'utf8')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function runWrapper(platform, releaseBuild, nativeProbeStatus = 0, buildStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), 'scry builder fixture-'))
  roots.push(root)
  const sdk = join(root, 'node_modules', 'electron', 'dist')
  const binary = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
  const defaultApp = platform === 'darwin' ? 'Electron.app/Contents/Resources/default_app.asar' : 'resources/default_app.asar'
  for (const name of [binary, defaultApp, 'version', 'LICENSE']) {
    mkdirSync(dirname(join(sdk, name)), { recursive: true })
    writeFileSync(join(sdk, name), 'original')
  }
  symlinkSync(binary, join(sdk, 'runtime-link'))
  const calls = []
  let distribution
  const execute = () => runInNewContext(source.replace(/^import .*$/gm, ''), {
    constants, cpSync, mkdtempSync, rmSync, basename, join, tmpdir: () => root,
    electronPath: '/fixture/electron',
    releaseBuildEnvironment,
    process: {
      platform,
      cwd: () => root,
      env: {
        CI: 'true', GITHUB_REF: 'refs/heads/main',
        SCRY_RELEASE_BUILD: releaseBuild ? '1' : '0',
        CSC_NAME: 'Developer ID Application: Fixture (TEAM)',
        APPLE_TEAM_ID: 'TEAM', APPLE_ID: 'fixture@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'fixture-only'
      }
    },
    console: { log() {}, warn() {} },
    spawnSync(command, args, options) {
      calls.push({ command, args, options })
      if (command.endsWith('/electron-builder')) {
        const option = args.find(value => value.startsWith('--config.electronDist='))
        if (!option) throw new Error('Builder would download Electron again')
        distribution = option.slice('--config.electronDist='.length)
        expect(readFileSync(join(distribution, binary), 'utf8')).toBe('original')
        expect(readlinkSync(join(distribution, 'runtime-link'))).toBe(binary)
        expect(existsSync(join(distribution, defaultApp))).toBe(false)
        expect(existsSync(join(distribution, 'version'))).toBe(false)
        // Packaging can modify its copy without touching the installed SDK.
        writeFileSync(join(distribution, binary), 'packaged')
        return { status: buildStatus }
      }
      return { status: command === '/fixture/electron' ? nativeProbeStatus : 0, stdout: '', stderr: '' }
    }
  })
  return { calls, execute, root, sdk, binary, defaultApp, get distribution() { return distribution } }
}

describe('local artifact builder reuses its verified SDK and never publishes', () => {
  it.each([
    ['linux', false, ['--dir']],
    ['linux', true, ['--linux', 'pacman']],
    ['darwin', false, ['--dir']],
    ['darwin', true, ['--dir', '--config.mac.notarize=true']]
  ])('keeps the existing host target on CI main for %s release=%s', (platform, releaseBuild, target) => {
    const fixture = runWrapper(platform, releaseBuild)
    fixture.execute()
    const { calls, root, sdk, binary, defaultApp, distribution } = fixture
    expect(calls.map(call => call.command)).toEqual([
      join(root, 'node_modules/.bin/electron-rebuild'), '/fixture/electron',
      join(root, 'node_modules/.bin/electron-builder')
    ])
    expect(calls[0].args).toEqual(['-f', '-w', 'better-sqlite3', '-w', 'node-pty'])
    expect(calls[1].args[1]).toContain("require('better-sqlite3')(':memory:')")
    expect(calls[1].args[1]).toContain("require('node-pty')")
    expect(calls[2].args).toEqual([...target, `--config.electronDist=${distribution}`, '--publish', 'never'])
    expect(existsSync(distribution)).toBe(false)
    expect(readFileSync(join(sdk, binary), 'utf8')).toBe('original')
    expect(readFileSync(join(sdk, defaultApp), 'utf8')).toBe('original')
    expect(readFileSync(join(sdk, 'version'), 'utf8')).toBe('original')
  })

  it('still refuses to build an artifact when its real native-load probe fails', () => {
    const { calls, execute } = runWrapper('linux', true, 1)
    expect(execute).toThrow('原生模块无法被 Electron 加载')
    expect(calls.some(call => call.command.endsWith('/electron-builder'))).toBe(false)
  })

  it('removes the temporary distribution even when packaging fails', () => {
    const fixture = runWrapper('linux', true, 0, 1)
    expect(fixture.execute).toThrow('electron-builder failed with exit 1')
    expect(existsSync(fixture.distribution)).toBe(false)
    expect(readFileSync(join(fixture.sdk, fixture.binary), 'utf8')).toBe('original')
  })
})
