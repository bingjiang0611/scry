import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonLogPath } from './daemon-log'

// Login service definitions for the background service (P5 §2.1): a launchd LaunchAgent
// and a systemd --user unit. Rendered only; nothing here installs or loads them.
//
// What the files must and must not carry:
// - no version: the supervisor takes it from its own bundle (daemon-config.ts), so the
//   file stays valid across in-place upgrades;
// - Node and loader variables the service manager's own environment may hold are
//   cleared (launchd: set to empty; systemd: UnsetEnvironment=); the supervisor still
//   filters the daemon's environment through its allowlist;
// - stop: the supervisor waits up to 25 s for the daemon (supervisor.ts), below the 30 s
//   both service managers allow; restart only after an abnormal death.

export const LAUNCHD_LABEL = 'com.scry.daemon'
export const SYSTEMD_UNIT_NAME = 'scry-daemon.service'
/** electron-builder.yml `appId`: shows the job as Scry under Login Items. */
export const SCRY_BUNDLE_IDENTIFIER = 'com.scry.app'
export const SERVICE_STOP_TIMEOUT_SECONDS = 30

const CLEARED_NODE_ENV = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_REDIRECT_WARNINGS', 'NODE_V8_COVERAGE'
] as const
export const LAUNCHD_CLEARED_ENV = [
  ...CLEARED_NODE_ENV,
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH'
] as const
export const SYSTEMD_UNSET_ENV = [...CLEARED_NODE_ENV, 'LD_PRELOAD', 'LD_LIBRARY_PATH'] as const

export interface ServiceTemplateInput {
  executable: string
  supervisorEntry: string
  daemonEntry: string
  userDataDir: string
  appPath: string
  resourcesPath: string
  isPackaged: boolean
}

// A newline would end a systemd line early or split an XML string; neither format can
// carry other control characters faithfully. Spaces and non-ASCII text are fine.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

function fixedEnvironment(input: ServiceTemplateInput): Array<[string, string]> {
  const values: Array<[string, string]> = [
    ['ELECTRON_RUN_AS_NODE', '1'],
    ['SCRY_DAEMON_STATE_DIR', join(input.userDataDir, 'daemon')],
    ['SCRY_DAEMON_USER_DATA_DIR', input.userDataDir],
    ['SCRY_DAEMON_ENTRY', input.daemonEntry],
    ['SCRY_DAEMON_APP_PATH', input.appPath],
    ['SCRY_DAEMON_RESOURCES_PATH', input.resourcesPath],
    ['SCRY_DAEMON_PACKAGED', input.isPackaged ? '1' : '0'],
    ['SCRY_DAEMON_LAUNCHED_BY', 'service']
  ]
  for (const value of [input.executable, input.supervisorEntry, ...values.map(([, value]) => value)]) {
    if (CONTROL.test(value)) throw new Error('login_start_path_unsupported')
  }
  return values
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** One quoted word for Environment=: C escapes inside the quotes; `%` is a specifier. `$` is literal there. */
function systemdEnvironmentWord(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}
/** One quoted ExecStart= argument: as above, and `$` would expand a variable, so `$$`. */
function systemdCommandWord(value: string): string {
  return systemdEnvironmentWord(value).replaceAll('$', () => '$$')
}
/** The path after `append:`: taken verbatim to the end of the line, specifiers expanded. */
function systemdOutputPath(value: string): string {
  return value.replaceAll('%', '%%')
}

export function renderLaunchdPlist(input: ServiceTemplateInput): string {
  const environment = [
    ...fixedEnvironment(input),
    ...LAUNCHD_CLEARED_ENV.map((key): [string, string] => [key, ''])
  ]
  const log = xml(daemonLogPath(input.userDataDir))
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key><array><string>${xml(input.executable)}</string><string>${xml(input.supervisorEntry)}</string></array>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...environment.map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`),
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>',
    '  <key>LimitLoadToSessionType</key><string>Aqua</string>',
    `  <key>ExitTimeOut</key><integer>${SERVICE_STOP_TIMEOUT_SECONDS}</integer>`,
    `  <key>AssociatedBundleIdentifiers</key><array><string>${SCRY_BUNDLE_IDENTIFIER}</string></array>`,
    `  <key>StandardOutPath</key><string>${log}</string>`,
    `  <key>StandardErrorPath</key><string>${log}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

export function renderSystemdUnit(input: ServiceTemplateInput): string {
  const log = systemdOutputPath(daemonLogPath(input.userDataDir))
  return [
    '[Unit]',
    'Description=Scry remote host daemon',
    '',
    '[Service]',
    'Type=simple',
    ...fixedEnvironment(input).map(([key, value]) => `Environment=${systemdEnvironmentWord(`${key}=${value}`)}`),
    `UnsetEnvironment=${SYSTEMD_UNSET_ENV.join(' ')}`,
    `ExecStart=${systemdCommandWord(input.executable)} ${systemdCommandWord(input.supervisorEntry)}`,
    'Restart=on-abnormal',
    'KillMode=mixed',
    `TimeoutStopSec=${SERVICE_STOP_TIMEOUT_SECONDS}`,
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

export function writeSupervisorTemplates(input: ServiceTemplateInput & { directory: string }): { launchd: string; systemd: string } {
  const plist = renderLaunchdPlist(input)
  const unit = renderSystemdUnit(input)
  mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  const launchd = join(input.directory, `${LAUNCHD_LABEL}.plist`)
  const systemd = join(input.directory, SYSTEMD_UNIT_NAME)
  writeFileSync(launchd, plist, { mode: 0o600 })
  writeFileSync(systemd, unit, { mode: 0o600 })
  return { launchd, systemd }
}
