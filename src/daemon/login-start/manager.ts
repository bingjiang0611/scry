import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { LoginStartStatus } from '../../shared/background-service'
import { precreateDaemonLog } from '../daemon-log'
import { renderLaunchdPlist, renderSystemdUnit } from '../supervisor-templates'
import {
  LINUX_LOGINCTL, LINUX_SYSTEMCTL, MACOS_LAUNCHCTL, SERVICE_COMMAND_TIMEOUT_MS,
  executableExists, runFixedCommand, type CommandResult, type CommandRunner
} from './exec'
import { parseLaunchdPlist, parseSystemdUnit, type ParsedServiceFile } from './parse'
import {
  loginStartTemplateInput, resolveLoginStartOverrides, serviceFilePath,
  type LoginStartTarget
} from './paths'
import { collectLoginStartPolicyEnv, validateParsedPolicyEntries } from './policy-env'

export type LoginStartMutationResult =
  | { ok: true }
  | { ok: false; reason: string; exitCode?: number; otherUserDataDir?: string; otherExecutable?: string }

export interface LoginStartManagerDeps {
  platform?: NodeJS.Platform
  uid?: number
  homeDir?: string
  daemonMode: boolean
  target: LoginStartTarget
  env?: NodeJS.ProcessEnv
  runner?: CommandRunner
  /** Production keeps Linux unavailable until real-machine verification passes (P5 §2.3). */
  allowLinux?: boolean
  systemctlAvailable?: boolean
  log?: (line: string) => void
}

export interface LoginStartManager {
  readonly filePath: string
  readonly label: string
  readonly unitName: string
  availability(): { ok: true } | { ok: false; reason: string }
  status(): Promise<LoginStartStatus>
  enable(options: { daemonRunning: boolean }): Promise<LoginStartMutationResult>
  disable(options: { daemonRunning: boolean }): Promise<LoginStartMutationResult>
  canLaunchViaService(): boolean
  startViaService(): Promise<LoginStartMutationResult>
}

function readRegularFile(path: string): { kind: 'missing' } | { kind: 'symlink' } | { kind: 'file'; content: string } {
  let info
  try { info = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) return { kind: 'symlink' }
  return { kind: 'file', content: readFileSync(path, 'utf8') }
}

function writeFileAtomicPrivate(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.scry-login-start-${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, filePath)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw error
  }
}

function commandFailed(baseReason: string, result: CommandResult): LoginStartMutationResult {
  if (result.timedOut) return { ok: false, reason: `${baseReason}_timeout` }
  if (result.notFound) return { ok: false, reason: 'login_start_command_missing' }
  return { ok: false, reason: baseReason, ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}) }
}

export function createLoginStartManager(deps: LoginStartManagerDeps): LoginStartManager {
  const platform = deps.platform ?? process.platform
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1)
  const env = deps.env ?? process.env
  const homeDir = deps.homeDir ?? homedir()
  const runner = deps.runner ?? runFixedCommand
  const allowLinux = deps.allowLinux ?? false
  const log = deps.log ?? (() => undefined)
  const overrides = resolveLoginStartOverrides(env, platform)
  const filePath = serviceFilePath({
    platform,
    homeDir,
    ...(env.XDG_CONFIG_HOME ? { xdgConfigHome: env.XDG_CONFIG_HOME } : {}),
    label: overrides.label,
    unitName: overrides.unitName,
    ...(overrides.serviceDirOverride ? { serviceDirOverride: overrides.serviceDirOverride } : {})
  })
  const currentUserData = resolve(deps.target.userDataDir)
  const currentExecutable = resolve(deps.target.executable)
  const macDomain = `gui/${uid}`
  const macTarget = `${macDomain}/${overrides.label}`

  const availability = (): { ok: true } | { ok: false; reason: string } => {
    if (!deps.daemonMode) return { ok: false, reason: 'daemon_mode_disabled' }
    if (!deps.target.isPackaged) return { ok: false, reason: 'unpackaged_build' }
    if (overrides.isTestInstance && !overrides.testOverrideActive) return { ok: false, reason: 'test_instance' }
    if (platform === 'darwin') {
      if (uid < 0) return { ok: false, reason: 'unsupported_platform' }
      return { ok: true }
    }
    if (platform === 'linux') {
      if (!allowLinux) return { ok: false, reason: 'linux_unverified' }
      const hasSystemctl = deps.systemctlAvailable ?? executableExists(LINUX_SYSTEMCTL)
      if (!hasSystemctl) return { ok: false, reason: 'systemd_unavailable' }
      return { ok: true }
    }
    return { ok: false, reason: 'unsupported_platform' }
  }

  const parseExisting = ():
    | { kind: 'missing' }
    | { kind: 'foreign' }
    | { kind: 'ours'; parsed: Extract<ParsedServiceFile, { kind: 'ours' }>; raw: string } => {
    const read = readRegularFile(filePath)
    if (read.kind === 'missing') return { kind: 'missing' }
    if (read.kind === 'symlink') return { kind: 'foreign' }
    const parsed = platform === 'darwin'
      ? parseLaunchdPlist(read.content, overrides.label)
      : parseSystemdUnit(read.content)
    if (parsed.kind === 'foreign') return { kind: 'foreign' }
    return { kind: 'ours', parsed, raw: read.content }
  }

  const renderFor = (policyEnv: ReadonlyArray<readonly [string, string]>): string => {
    const templateInput = loginStartTemplateInput(deps.target, {
      policyEnv,
      ...(platform === 'darwin' ? { label: overrides.label } : {})
    })
    return platform === 'darwin' ? renderLaunchdPlist(templateInput) : renderSystemdUnit(templateInput)
  }

  const inspectOwnership = (allowAutoRewrite: boolean):
    | { kind: 'missing' }
    | { kind: 'conflict'; reason: 'login_start_foreign_service' | 'login_start_other_userdata' | 'login_start_other_app'; otherUserDataDir?: string; otherExecutable?: string }
    | { kind: 'ours'; parsed: Extract<ParsedServiceFile, { kind: 'ours' }>; rewrittenFromExecutable?: string } => {
    const existing = parseExisting()
    if (existing.kind === 'missing') return { kind: 'missing' }
    if (existing.kind === 'foreign') return { kind: 'conflict', reason: 'login_start_foreign_service' }
    const { parsed } = existing
    if (resolve(parsed.userDataDir) !== currentUserData) {
      return { kind: 'conflict', reason: 'login_start_other_userdata', otherUserDataDir: parsed.userDataDir }
    }
    if (resolve(parsed.executable) !== currentExecutable) {
      // Auto-rewrite ONLY when our service file matches this userData and the old App
      // binary no longer exists (App was moved; P5 §2.5 & decision 7).
      if (allowAutoRewrite && !existsSync(parsed.executable)) {
        const validPolicy = validateParsedPolicyEntries(parsed.policyEnv)
        if (validPolicy !== undefined) {
          try {
            const rewritten = renderFor(validPolicy)
            writeFileAtomicPrivate(filePath, rewritten)
            log(`login-start.rewritten old=${parsed.executable} new=${deps.target.executable}`)
            return { kind: 'ours', parsed: { ...parsed, executable: deps.target.executable }, rewrittenFromExecutable: parsed.executable }
          } catch {
            // Fall through to conflict if rewrite fails.
          }
        }
      }
      return { kind: 'conflict', reason: 'login_start_other_app', otherExecutable: parsed.executable }
    }
    return { kind: 'ours', parsed }
  }

  const readLinuxLinger = async (): Promise<'yes' | 'no' | 'unknown'> => {
    const res = await runner(LINUX_LOGINCTL, ['show-user', String(uid), '-p', 'Linger', '--value'], SERVICE_COMMAND_TIMEOUT_MS)
    if (res.exitCode !== 0) return 'unknown'
    const text = res.stdout.trim().toLowerCase()
    return text === 'yes' ? 'yes' : text === 'no' ? 'no' : 'unknown'
  }

  const readLinuxUnitRuntime = async (): Promise<{ enabled: boolean; mainPid: number | null }> => {
    const [enabledRes, showRes] = await Promise.all([
      runner(LINUX_SYSTEMCTL, ['--user', 'is-enabled', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS),
      runner(LINUX_SYSTEMCTL, ['--user', 'show', '-p', 'ActiveState,MainPID', '--value', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    ])
    const lines = showRes.exitCode === 0 ? showRes.stdout.split(/\r?\n/).map((l) => l.trim()) : []
    const active = lines[0] === 'active'
    const parsedPid = Number(lines[1])
    const mainPid = active && Number.isSafeInteger(parsedPid) && parsedPid > 1 ? parsedPid : null
    return { enabled: enabledRes.exitCode === 0, mainPid }
  }

  const status = async (): Promise<LoginStartStatus> => {
    const avail = availability()
    if (!avail.ok) return { state: 'unavailable', reason: avail.reason }
    let ownership
    try {
      ownership = inspectOwnership(true)
    } catch {
      return { state: 'conflict', reason: 'login_start_foreign_service' }
    }
    if (ownership.kind === 'conflict') {
      return {
        state: 'conflict',
        reason: ownership.reason,
        ...(ownership.otherUserDataDir ? { otherUserDataDir: ownership.otherUserDataDir } : {}),
        ...(ownership.otherExecutable ? { otherExecutable: ownership.otherExecutable } : {})
      }
    }
    if (platform === 'darwin') {
      const printRes = await runner(MACOS_LAUNCHCTL, ['print', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      const loaded = printRes.exitCode === 0
      if (ownership.kind === 'missing') return { state: 'disabled', loaded }
      return {
        state: 'enabled',
        loaded,
        policyEnv: ownership.parsed.policyEnv,
        ...(ownership.rewrittenFromExecutable ? { rewrittenFromExecutable: ownership.rewrittenFromExecutable } : {})
      }
    }
    const [linger, runtime] = await Promise.all([readLinuxLinger(), readLinuxUnitRuntime()])
    if (ownership.kind === 'missing') return { state: 'disabled', loaded: runtime.enabled, linuxLinger: linger }
    return {
      state: 'enabled',
      loaded: runtime.enabled,
      policyEnv: ownership.parsed.policyEnv,
      ...(ownership.rewrittenFromExecutable ? { rewrittenFromExecutable: ownership.rewrittenFromExecutable } : {}),
      linuxLinger: linger,
      linuxMainPid: runtime.mainPid
    }
  }

  const enable = async ({ daemonRunning }: { daemonRunning: boolean }): Promise<LoginStartMutationResult> => {
    const avail = availability()
    if (!avail.ok) return { ok: false, reason: avail.reason }
    const policy = collectLoginStartPolicyEnv(env)
    if (!policy.ok) return { ok: false, reason: policy.reason }

    let rendered: string
    try {
      rendered = renderFor(policy.entries)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'login_start_render_failed' }
    }

    const previous = readRegularFile(filePath)
    if (previous.kind === 'symlink') return { ok: false, reason: 'login_start_foreign_service' }
    if (previous.kind === 'file') {
      const parsed = platform === 'darwin'
        ? parseLaunchdPlist(previous.content, overrides.label)
        : parseSystemdUnit(previous.content)
      if (parsed.kind === 'foreign') return { ok: false, reason: 'login_start_foreign_service' }
      if (resolve(parsed.userDataDir) !== currentUserData) {
        return { ok: false, reason: 'login_start_other_userdata', otherUserDataDir: parsed.userDataDir }
      }
    }

    const restorePrevious = (): void => {
      try {
        if (previous.kind === 'missing') unlinkSync(filePath)
        else writeFileAtomicPrivate(filePath, previous.content)
      } catch { /* best-effort rollback */ }
    }

    try {
      precreateDaemonLog(deps.target.userDataDir)
      writeFileAtomicPrivate(filePath, rendered)
    } catch (error) {
      return { ok: false, reason: `login_start_write_failed:${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}` }
    }

    if (platform === 'darwin') {
      const printed = await runner(MACOS_LAUNCHCTL, ['print', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      if (printed.timedOut || printed.notFound) {
        restorePrevious()
        return commandFailed('login_start_launchctl_failed', printed)
      }
      if (printed.exitCode === 0) {
        if (daemonRunning) return { ok: true }
        const bootedOut = await runner(MACOS_LAUNCHCTL, ['bootout', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
        if (bootedOut.exitCode !== 0) {
          restorePrevious()
          return commandFailed('login_start_bootout_failed', bootedOut)
        }
      }
      const bootstrapped = await runner(MACOS_LAUNCHCTL, ['bootstrap', macDomain, filePath], SERVICE_COMMAND_TIMEOUT_MS)
      if (bootstrapped.exitCode !== 0) {
        restorePrevious()
        return commandFailed('login_start_bootstrap_failed', bootstrapped)
      }
      return { ok: true }
    }

    const reloaded = await runner(LINUX_SYSTEMCTL, ['--user', 'daemon-reload'], SERVICE_COMMAND_TIMEOUT_MS)
    if (reloaded.exitCode !== 0) {
      restorePrevious()
      return commandFailed('login_start_systemctl_failed', reloaded)
    }
    const enabledRes = await runner(LINUX_SYSTEMCTL, ['--user', 'enable', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    if (enabledRes.exitCode !== 0) {
      restorePrevious()
      return commandFailed('login_start_systemctl_failed', enabledRes)
    }
    const started = await runner(LINUX_SYSTEMCTL, ['--user', 'start', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    if (started.exitCode !== 0) {
      return commandFailed('login_start_systemctl_start_failed', started)
    }
    return { ok: true }
  }

  const disable = async ({ daemonRunning }: { daemonRunning: boolean }): Promise<LoginStartMutationResult> => {
    const avail = availability()
    if (!avail.ok) return { ok: false, reason: avail.reason }
    const existing = parseExisting()
    if (existing.kind === 'foreign') return { ok: false, reason: 'login_start_foreign_service' }
    if (existing.kind === 'ours' && resolve(existing.parsed.userDataDir) !== currentUserData) {
      return { ok: false, reason: 'login_start_other_userdata', otherUserDataDir: existing.parsed.userDataDir }
    }

    if (platform === 'darwin') {
      try { unlinkSync(filePath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, reason: `login_start_unlink_failed:${(error as NodeJS.ErrnoException).code ?? 'unknown'}` }
        }
      }
      if (!daemonRunning) {
        await runner(MACOS_LAUNCHCTL, ['bootout', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      }
      return { ok: true }
    }

    await runner(LINUX_SYSTEMCTL, ['--user', 'disable', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    try { unlinkSync(filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, reason: `login_start_unlink_failed:${(error as NodeJS.ErrnoException).code ?? 'unknown'}` }
      }
    }
    const reloaded = await runner(LINUX_SYSTEMCTL, ['--user', 'daemon-reload'], SERVICE_COMMAND_TIMEOUT_MS)
    if (reloaded.exitCode !== 0) return commandFailed('login_start_systemctl_failed', reloaded)
    return { ok: true }
  }

  const canLaunchViaService = (): boolean => {
    if (!availability().ok) return false
    try {
      return inspectOwnership(true).kind === 'ours'
    } catch {
      return false
    }
  }

  const startViaService = async (): Promise<LoginStartMutationResult> => {
    const avail = availability()
    if (!avail.ok) return { ok: false, reason: avail.reason }
    const res = platform === 'darwin'
      ? await runner(MACOS_LAUNCHCTL, ['kickstart', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      : await runner(LINUX_SYSTEMCTL, ['--user', 'start', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    if (res.exitCode !== 0) return commandFailed('login_start_service_launch_failed', res)
    return { ok: true }
  }

  return {
    filePath,
    label: overrides.label,
    unitName: overrides.unitName,
    availability,
    status,
    enable,
    disable,
    canLaunchViaService,
    startViaService
  }
}
