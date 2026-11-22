import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  LAUNCHD_CLEARED_ENV, SCRY_BUNDLE_IDENTIFIER, SYSTEMD_UNSET_ENV,
  renderLaunchdPlist, renderSystemdUnit, writeSupervisorTemplates, type ServiceTemplateInput
} from './supervisor-templates'

const roots: string[] = []
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'scry-templates-')); roots.push(value); return value }
afterEach(() => { roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })) })

const mac: ServiceTemplateInput = {
  executable: '/Applications/Scry.app/Contents/MacOS/Scry',
  supervisorEntry: '/Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon-supervisor.js',
  daemonEntry: '/Applications/Scry.app/Contents/Resources/app.asar/out/main/daemon.js',
  userDataDir: '/Users/me/Library/Application Support/Scry',
  appPath: '/Applications/Scry.app/Contents/Resources/app.asar',
  resourcesPath: '/Applications/Scry.app/Contents/Resources',
  isPackaged: true
}
const awkward = '/home/me/项目 a&b<c>"q"\\x 100%$HOME'
const linux: ServiceTemplateInput = {
  executable: `/opt/${awkward}/scry`,
  supervisorEntry: `/opt/${awkward}/resources/app.asar/out/main/daemon-supervisor.js`,
  daemonEntry: `/opt/${awkward}/resources/app.asar/out/main/daemon.js`,
  userDataDir: `${awkward}/.config/scry`,
  appPath: `/opt/${awkward}/resources/app.asar`,
  resourcesPath: `/opt/${awkward}/resources`,
  isPackaged: true
}

const xmlText = (value: string): string => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
function plistEnvironment(plist: string): Record<string, string> {
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)![1]!
  return Object.fromEntries([...block.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)].map((match) => [match[1]!, xmlText(match[2]!)]))
}
function systemdWords(line: string, command: boolean): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => {
    const unescaped = match[1]!.replace(/\\(.)/g, '$1').replaceAll('%%', '%')
    return command ? unescaped.replaceAll('$$', '$') : unescaped
  })
}
function unitEnvironment(unit: string): Record<string, string> {
  return Object.fromEntries(unit.split('\n').filter((line) => line.startsWith('Environment=')).map((line) => {
    const word = systemdWords(line, false)[0]!
    return [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]
  }))
}
const line = (text: string, prefix: string): string => text.split('\n').find((entry) => entry.startsWith(prefix))!

const fixed = (input: ServiceTemplateInput): Record<string, string> => ({
  ELECTRON_RUN_AS_NODE: '1',
  SCRY_DAEMON_STATE_DIR: join(input.userDataDir, 'daemon'),
  SCRY_DAEMON_USER_DATA_DIR: input.userDataDir,
  SCRY_DAEMON_ENTRY: input.daemonEntry,
  SCRY_DAEMON_APP_PATH: input.appPath,
  SCRY_DAEMON_RESOURCES_PATH: input.resourcesPath,
  SCRY_DAEMON_PACKAGED: '1',
  SCRY_DAEMON_LAUNCHED_BY: 'service'
})

describe('login service templates', () => {
  it('carries no version in either file', () => {
    for (const input of [mac, linux]) {
      expect(renderLaunchdPlist(input)).not.toContain('VERSION')
      expect(renderSystemdUnit(input)).not.toContain('VERSION')
    }
  })

  it('launchd: fixed environment, cleared Node and loader variables, stop and restart rules', () => {
    for (const input of [mac, linux]) {
      const plist = renderLaunchdPlist(input)
      expect(plistEnvironment(plist)).toEqual({ ...fixed(input), ...Object.fromEntries(LAUNCHD_CLEARED_ENV.map((key) => [key, ''])) })
      const args = [...plist.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/)![1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => xmlText(match[1]!))
      expect(args).toEqual([input.executable, input.supervisorEntry])
      expect(plist).toContain('<key>RunAtLoad</key><true/>')
      expect(plist).toContain('<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>')
      expect(plist).toContain('<key>LimitLoadToSessionType</key><string>Aqua</string>')
      expect(plist).toContain('<key>ExitTimeOut</key><integer>30</integer>')
      expect(plist).toContain(`<key>AssociatedBundleIdentifiers</key><array><string>${SCRY_BUNDLE_IDENTIFIER}</string></array>`)
      expect(plist).not.toContain('ProcessType')
      const log = join(input.userDataDir, 'logs', 'daemon.log')
      for (const key of ['StandardOutPath', 'StandardErrorPath']) {
        expect(xmlText(plist.match(new RegExp(`<key>${key}</key><string>([^<]*)</string>`))![1]!)).toBe(log)
      }
    }
    expect(LAUNCHD_CLEARED_ENV).toEqual(expect.arrayContaining([
      'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REDIRECT_WARNINGS', 'NODE_V8_COVERAGE',
      'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH'
    ]))
  })

  it('systemd: fixed environment, unset Node and loader variables, stop and restart rules', () => {
    for (const input of [mac, linux]) {
      const unit = renderSystemdUnit(input)
      expect(unitEnvironment(unit)).toEqual(fixed(input))
      expect(systemdWords(line(unit, 'ExecStart='), true)).toEqual([input.executable, input.supervisorEntry])
      expect(line(unit, 'UnsetEnvironment=').slice('UnsetEnvironment='.length).split(' ')).toEqual([...SYSTEMD_UNSET_ENV])
      expect(unit).toContain('\nRestart=on-abnormal\n')
      expect(unit).toContain('\nKillMode=mixed\n')
      expect(unit).toContain('\nTimeoutStopSec=30\n')
      expect(unit).toContain('\nWantedBy=default.target\n')
      const log = join(input.userDataDir, 'logs', 'daemon.log')
      for (const key of ['StandardOutput=append:', 'StandardError=append:']) {
        expect(line(unit, key).slice(key.length).replaceAll('%%', '%')).toBe(log)
      }
    }
    expect(SYSTEMD_UNSET_ENV).toEqual(expect.arrayContaining([
      'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REDIRECT_WARNINGS', 'NODE_V8_COVERAGE',
      'LD_PRELOAD', 'LD_LIBRARY_PATH'
    ]))
  })

  it('escapes % everywhere, $ only where systemd expands it', () => {
    const unit = renderSystemdUnit(linux)
    expect(line(unit, 'Environment="SCRY_DAEMON_USER_DATA_DIR=')).toContain('100%%$HOME')
    expect(line(unit, 'ExecStart=')).toContain('100%%$$HOME')
    expect(line(unit, 'StandardOutput=')).toContain('\\x 100%%$HOME')
    expect(renderLaunchdPlist(linux)).toContain('a&amp;b&lt;c&gt;"q"\\x 100%$HOME')
  })

  it('names the App bundle electron-builder builds', () => {
    const builder = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(builder).toMatch(new RegExp(`^appId: ${SCRY_BUNDLE_IDENTIFIER.replaceAll('.', '\\.')}$`, 'm'))
  })

  it.each([['newline', '\n'], ['carriage return', '\r'], ['tab', '\t'], ['bell', '\u0007'], ['DEL', '\u007f'], ['next line', '\u0085']])(
    'refuses a path with a %s and writes nothing', (_name, character) => {
      const directory = join(root(), 'out')
      for (const key of ['executable', 'supervisorEntry', 'daemonEntry', 'userDataDir', 'appPath', 'resourcesPath'] as const) {
        const input = { ...linux, [key]: `${linux[key]}${character}x` }
        expect(() => renderLaunchdPlist(input)).toThrow('login_start_path_unsupported')
        expect(() => renderSystemdUnit(input)).toThrow('login_start_path_unsupported')
        expect(() => writeSupervisorTemplates({ ...input, directory })).toThrow('login_start_path_unsupported')
      }
      expect(existsSync(directory)).toBe(false)
    })

  it('writes both files owner-only without installing them', () => {
    const directory = join(root(), 'templates')
    const files = writeSupervisorTemplates({ ...mac, directory })
    expect(files).toEqual({ launchd: join(directory, 'com.scry.daemon.plist'), systemd: join(directory, 'scry-daemon.service') })
    expect(readFileSync(files.launchd, 'utf8')).toBe(renderLaunchdPlist(mac))
    expect(readFileSync(files.systemd, 'utf8')).toBe(renderSystemdUnit(mac))
    expect(statSync(files.launchd).mode & 0o777).toBe(0o600)
    expect(statSync(files.systemd).mode & 0o777).toBe(0o600)
  })
})
