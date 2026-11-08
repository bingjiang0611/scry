import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { releaseBuildEnvironment } from './release-policy.mjs'

const source = readFileSync(new URL('./run-electron-builder.mjs', import.meta.url), 'utf8')

function runWrapper(platform, releaseBuild, nativeProbeStatus = 0) {
  const calls = []
  const execute = () => runInNewContext(source.replace(/^import .*$/gm, ''), {
    join,
    electronPath: '/fixture/electron',
    releaseBuildEnvironment,
    process: {
      platform,
      cwd: () => '/fixture',
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
      return { status: command === '/fixture/electron' ? nativeProbeStatus : 0, stdout: '', stderr: '' }
    }
  })
  return { calls, execute }
}

describe('local artifact builder never publishes', () => {
  it.each([
    ['linux', false, ['--dir']],
    ['linux', true, ['--linux', 'pacman']],
    ['darwin', false, ['--dir']],
    ['darwin', true, ['--dir', '--config.mac.notarize=true']]
  ])('disables publishing on CI main for %s release=%s', (platform, releaseBuild, target) => {
    const { calls, execute } = runWrapper(platform, releaseBuild)
    execute()
    expect(calls.map(call => call.command)).toEqual([
      '/fixture/node_modules/.bin/electron-rebuild', '/fixture/electron',
      '/fixture/node_modules/.bin/electron-builder'
    ])
    expect(calls[0].args).toEqual(['-f', '-w', 'better-sqlite3', '-w', 'node-pty'])
    expect(calls[1].args[1]).toContain("require('better-sqlite3')(':memory:')")
    expect(calls[1].args[1]).toContain("require('node-pty')")
    expect(calls[2].args).toEqual([...target, '--publish', 'never'])
  })

  it('still refuses to build an artifact when its real native-load probe fails', () => {
    const { calls, execute } = runWrapper('linux', true, 1)
    expect(execute).toThrow('原生模块无法被 Electron 加载')
    expect(calls.some(call => call.command.endsWith('/electron-builder'))).toBe(false)
  })
})
