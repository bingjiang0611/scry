import { existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { LoginStartStatus } from '../../shared/background-service'
import { precreateDaemonLog } from '../daemon-log'
import { renderLaunchdPlist, renderSystemdUnit } from '../supervisor-templates'
import {
  LINUX_LOGINCTL, LINUX_SYSTEMCTL, MACOS_LAUNCHCTL, SERVICE_COMMAND_TIMEOUT_MS,
  commandFailure, executableExists, runFixedCommand, type CommandRunner
} from './exec'
import {
  parseLaunchctlPrint, parseSystemdShowProperties, readRegularServiceFile, writeFileAtomicPrivate,
  type ServiceFileRead
} from './file-io'
import { parseLaunchdPlist, parseSystemdUnit, type ParsedServiceFile } from './parse'
import {
  isEphemeralMacAppPath, loginStartTemplateInput, resolveLoginStartOverrides, serviceFilePath,
  type LoginStartTarget
} from './paths'
import { collectLoginStartPolicyEnv, validateParsedPolicyEntries } from './policy-env'

export { parseLaunchctlPrint, parseSystemdShowProperties }

export type LoginStartMutationResult =
  | { ok: true }
  | { ok: false; reason: string; exitCode?: number; otherUserDataDir?: string; otherExecutable?: string }

export type LoginStartPrecheckResult =
  | { ok: true; policyEnvKeys: string[] }
  | { ok: false; reason: string; otherUserDataDir?: string; otherExecutable?: string }

export interface LoginStartManagerDeps {
  platform?: NodeJS.Platform
  uid?: number
  homeDir?: string
  target: LoginStartTarget
  env?: NodeJS.ProcessEnv
  runner?: CommandRunner
  allowLinux?: boolean
  systemctlAvailable?: boolean
  readServiceFile?: (path: string) => ServiceFileRead
  log?: (line: string) => void
}

export interface LoginStartManager {
  readonly filePath: string
  readonly label: string
  readonly unitName: string
  availability(): { ok: true } | { ok: false; reason: string }
  precheckEnable(): LoginStartPrecheckResult
  status(): Promise<LoginStartStatus>
  reconcileMovedApp(): { rewritten: true; fromExecutable: string } | { rewritten: false }
  enable(options: { daemonRunning: boolean }): Promise<LoginStartMutationResult>
  disable(options: { daemonRunning: boolean }): Promise<LoginStartMutationResult>
  canLaunchViaService(): boolean
  startViaService(): Promise<LoginStartMutationResult>
}

export function createLoginStartManager(deps: LoginStartManagerDeps): LoginStartManager {
  const platform = deps.platform ?? process.platform
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1)
  const env = deps.env ?? process.env
  const homeDir = deps.homeDir ?? homedir()
  const runner = deps.runner ?? runFixedCommand
  const readServiceFile = deps.readServiceFile ?? readRegularServiceFile
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
  let lastRewrittenFrom: string | undefined

  const availability = (): { ok: true } | { ok: false; reason: string } => {
    if (!deps.target.isPackaged) return { ok: false, reason: 'unpackaged_build' }
    if (overrides.isTestInstance && !overrides.testOverrideActive) return { ok: false, reason: 'test_instance' }
    if (platform === 'darwin') {
      if (uid < 0) return { ok: false, reason: 'unsupported_platform' }
      if (isEphemeralMacAppPath(currentExecutable)) return { ok: false, reason: 'login_start_ephemeral_app_path' }
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
    | { kind: 'error'; code: string }
    | { kind: 'foreign' }
    | { kind: 'ours'; parsed: Extract<ParsedServiceFile, { kind: 'ours' }>; raw: string } => {
    const read = readServiceFile(filePath)
    if (read.kind === 'missing') return { kind: 'missing' }
    if (read.kind === 'error') return { kind: 'error', code: read.code }
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

  type Ownership =
    | { kind: 'missing' }
    | { kind: 'read-error'; code: string }
    | { kind: 'conflict'; reason: 'login_start_foreign_service' | 'login_start_other_userdata' | 'login_start_other_app'; otherUserDataDir?: string; otherExecutable?: string }
    | { kind: 'moved'; parsed: Extract<ParsedServiceFile, { kind: 'ours' }>; raw: string }
    | { kind: 'ours'; parsed: Extract<ParsedServiceFile, { kind: 'ours' }>; raw: string }

  const inspectReadOnly = (): Ownership => {
    const existing = parseExisting()
    if (existing.kind === 'missing') return { kind: 'missing' }
    if (existing.kind === 'error') return { kind: 'read-error', code: existing.code }
    if (existing.kind === 'foreign') return { kind: 'conflict', reason: 'login_start_foreign_service' }
    const { parsed, raw } = existing
    if (resolve(parsed.userDataDir) !== currentUserData) {
      return { kind: 'conflict', reason: 'login_start_other_userdata', otherUserDataDir: parsed.userDataDir }
    }
    if (resolve(parsed.executable) !== currentExecutable) {
      if (!existsSync(parsed.executable)) return { kind: 'moved', parsed, raw }
      return { kind: 'conflict', reason: 'login_start_other_app', otherExecutable: parsed.executable }
    }
    return { kind: 'ours', parsed, raw }
  }

  const reconcileMovedApp = (): { rewritten: true; fromExecutable: string } | { rewritten: false } => {
    if (!availability().ok) return { rewritten: false }
    const ownership = inspectReadOnly()
    if (ownership.kind !== 'moved') return { rewritten: false }
    const validPolicy = validateParsedPolicyEntries(ownership.parsed.policyEnv)
    if (validPolicy === undefined) return { rewritten: false }
    try {
      const rewritten = renderFor(validPolicy)
      writeFileAtomicPrivate(filePath, rewritten)
      lastRewrittenFrom = ownership.parsed.executable
      log(`login-start.rewritten old=${ownership.parsed.executable} new=${deps.target.executable}`)
      return { rewritten: true, fromExecutable: ownership.parsed.executable }
    } catch {
      return { rewritten: false }
    }
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
      runner(LINUX_SYSTEMCTL, ['--user', 'show', '-p', 'ActiveState,MainPID', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    ])
    const { mainPid } = showRes.exitCode === 0 ? parseSystemdShowProperties(showRes.stdout) : { mainPid: null }
    return { enabled: enabledRes.exitCode === 0, mainPid }
  }

  const conflictResult = (
    conflict: Extract<Ownership, { kind: 'conflict' }>
  ): { ok: false; reason: string; otherUserDataDir?: string; otherExecutable?: string } => ({
    ok: false,
    reason: conflict.reason,
    ...(conflict.otherUserDataDir ? { otherUserDataDir: conflict.otherUserDataDir } : {}),
    ...(conflict.otherExecutable ? { otherExecutable: conflict.otherExecutable } : {})
  })

  const unlinkServiceFile = (): LoginStartMutationResult | null => {
    try { unlinkSync(filePath); return null } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ENOENT' ? null : { ok: false, reason: `login_start_unlink_failed:${code ?? 'unknown'}` }
    }
  }

  const precheckEnable = (): LoginStartPrecheckResult => {
    const avail = availability()
    if (!avail.ok) return avail
    const policy = collectLoginStartPolicyEnv(env)
    if (!policy.ok) return policy
    const ownership = inspectReadOnly()
    if (ownership.kind === 'read-error') return { ok: false, reason: `login_start_read_failed:${ownership.code}` }
    if (ownership.kind === 'conflict') return conflictResult(ownership)
    return { ok: true, policyEnvKeys: policy.entries.map(([key]) => key) }
  }

  const status = async (): Promise<LoginStartStatus> => {
    const avail = availability()
    if (!avail.ok) return { state: 'unavailable', reason: avail.reason }
    const ownership = inspectReadOnly()
    if (ownership.kind === 'read-error') return { state: 'unavailable', reason: `login_start_read_failed:${ownership.code}` }
    if (ownership.kind === 'conflict') {
      const { reason, otherUserDataDir, otherExecutable } = ownership
      return {
        state: 'conflict',
        reason,
        ...(otherUserDataDir ? { otherUserDataDir } : {}),
        ...(otherExecutable ? { otherExecutable } : {})
      }
    }
    const rewrittenFrom = ownership.kind === 'ours' ? lastRewrittenFrom : undefined
    if (platform === 'darwin') {
      const printRes = await runner(MACOS_LAUNCHCTL, ['print', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      const loaded = printRes.exitCode === 0
      if (ownership.kind === 'missing') return { state: 'disabled', loaded }
      return {
        state: 'enabled',
        loaded,
        policyEnv: ownership.parsed.policyEnv,
        ...(rewrittenFrom ? { rewrittenFromExecutable: rewrittenFrom } : {})
      }
    }
    const [linger, runtime] = await Promise.all([readLinuxLinger(), readLinuxUnitRuntime()])
    if (ownership.kind === 'missing') return { state: 'disabled', loaded: runtime.enabled, linuxLinger: linger }
    return {
      state: 'enabled',
      loaded: runtime.enabled,
      policyEnv: ownership.parsed.policyEnv,
      ...(rewrittenFrom ? { rewrittenFromExecutable: rewrittenFrom } : {}),
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

    const ownership = inspectReadOnly()
    if (ownership.kind === 'read-error') return { ok: false, reason: `login_start_read_failed:${ownership.code}` }
    if (ownership.kind === 'conflict') return conflictResult(ownership)
    const previousRaw = ownership.kind === 'ours' || ownership.kind === 'moved' ? ownership.raw : undefined
    const hadOwnedFile = previousRaw !== undefined

    const restorePrevious = (): void => {
      try {
        if (previousRaw === undefined) unlinkSync(filePath)
        else writeFileAtomicPrivate(filePath, previousRaw)
      } catch {}
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
        return commandFailure('login_start_launchctl_failed', printed)
      }
      if (printed.exitCode === 0) {
        const printInfo = parseLaunchctlPrint(printed.stdout)
        const ownedByPrint = printInfo.userDataDir !== null && resolve(printInfo.userDataDir) === currentUserData
        const ownedLoadedJob = hadOwnedFile || ownedByPrint
        const isIdleJob = printInfo.runState === 'idle'
        if (!ownedLoadedJob && !isIdleJob) {
          restorePrevious()
          return { ok: false, reason: 'login_start_loaded_without_file' }
        }
        if (daemonRunning) {
          if (ownedLoadedJob) return { ok: true }
          const bootedIdle = await runner(MACOS_LAUNCHCTL, ['bootout', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
          if (bootedIdle.exitCode !== 0) {
            restorePrevious()
            return commandFailure('login_start_bootout_failed', bootedIdle)
          }
          return { ok: true }
        }
        const bootedOut = await runner(MACOS_LAUNCHCTL, ['bootout', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
        if (bootedOut.exitCode !== 0) {
          restorePrevious()
          return commandFailure('login_start_bootout_failed', bootedOut)
        }
      }
      const bootstrapped = await runner(MACOS_LAUNCHCTL, ['bootstrap', macDomain, filePath], SERVICE_COMMAND_TIMEOUT_MS)
      if (bootstrapped.exitCode !== 0) {
        restorePrevious()
        return commandFailure('login_start_bootstrap_failed', bootstrapped)
      }
      return { ok: true }
    }

    const reloaded = await runner(LINUX_SYSTEMCTL, ['--user', 'daemon-reload'], SERVICE_COMMAND_TIMEOUT_MS)
    if (reloaded.exitCode !== 0) {
      restorePrevious()
      return commandFailure('login_start_systemctl_failed', reloaded)
    }
    const enabledRes = await runner(LINUX_SYSTEMCTL, ['--user', 'enable', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    if (enabledRes.exitCode !== 0) {
      restorePrevious()
      await runner(LINUX_SYSTEMCTL, ['--user', 'daemon-reload'], SERVICE_COMMAND_TIMEOUT_MS)
      return commandFailure('login_start_systemctl_failed', enabledRes)
    }
    const started = await runner(LINUX_SYSTEMCTL, ['--user', 'start', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    if (started.exitCode !== 0) {
      if (!hadOwnedFile) {
        await runner(LINUX_SYSTEMCTL, ['--user', 'disable', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
      }
      restorePrevious()
      await runner(LINUX_SYSTEMCTL, ['--user', 'daemon-reload'], SERVICE_COMMAND_TIMEOUT_MS)
      return commandFailure('login_start_systemctl_start_failed', started)
    }
    return { ok: true }
  }

  const disable = async ({ daemonRunning }: { daemonRunning: boolean }): Promise<LoginStartMutationResult> => {
    const avail = availability()
    if (!avail.ok) return { ok: false, reason: avail.reason }
    const ownership = inspectReadOnly()
    if (ownership.kind === 'read-error') return { ok: false, reason: `login_start_read_failed:${ownership.code}` }
    if (ownership.kind === 'conflict') return conflictResult(ownership)

    if (platform === 'darwin') {
      if (ownership.kind === 'missing') return { ok: true }
      const unlinkErr = unlinkServiceFile()
      if (unlinkErr) return unlinkErr
      if (!daemonRunning) await runner(MACOS_LAUNCHCTL, ['bootout', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      return { ok: true }
    }

    if (ownership.kind === 'missing') return { ok: true }
    await runner(LINUX_SYSTEMCTL, ['--user', 'disable', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    const unlinkErr = unlinkServiceFile()
    if (unlinkErr) return unlinkErr
    const reloaded = await runner(LINUX_SYSTEMCTL, ['--user', 'daemon-reload'], SERVICE_COMMAND_TIMEOUT_MS)
    if (reloaded.exitCode !== 0) return commandFailure('login_start_systemctl_failed', reloaded)
    return { ok: true }
  }

  const canLaunchViaService = (): boolean => {
    if (!availability().ok) return false
    reconcileMovedApp()
    return inspectReadOnly().kind === 'ours'
  }

  const startViaService = async (): Promise<LoginStartMutationResult> => {
    const avail = availability()
    if (!avail.ok) return { ok: false, reason: avail.reason }
    if (!canLaunchViaService()) return { ok: false, reason: 'login_start_not_installed' }
    if (platform === 'darwin') {
      const printed = await runner(MACOS_LAUNCHCTL, ['print', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      if (printed.timedOut || printed.notFound) return commandFailure('login_start_service_launch_failed', printed)
      if (printed.exitCode === 0) {
        const printInfo = parseLaunchctlPrint(printed.stdout)
        if (printInfo.runState === 'running') {
          if (printInfo.userDataDir !== null && resolve(printInfo.userDataDir) !== currentUserData) {
            return { ok: false, reason: 'login_start_other_userdata', otherUserDataDir: printInfo.userDataDir }
          }
          return { ok: true }
        }
        await runner(MACOS_LAUNCHCTL, ['bootout', macTarget], SERVICE_COMMAND_TIMEOUT_MS)
      }
      const res = await runner(MACOS_LAUNCHCTL, ['bootstrap', macDomain, filePath], SERVICE_COMMAND_TIMEOUT_MS)
      if (res.exitCode !== 0) return commandFailure('login_start_service_launch_failed', res)
      return { ok: true }
    }
    await runner(LINUX_SYSTEMCTL, ['--user', 'daemon-reload'], SERVICE_COMMAND_TIMEOUT_MS)
    const res = await runner(LINUX_SYSTEMCTL, ['--user', 'start', overrides.unitName], SERVICE_COMMAND_TIMEOUT_MS)
    if (res.exitCode !== 0) return commandFailure('login_start_service_launch_failed', res)
    return { ok: true }
  }

  return {
    filePath,
    label: overrides.label,
    unitName: overrides.unitName,
    availability,
    precheckEnable,
    status,
    reconcileMovedApp,
    enable,
    disable,
    canLaunchViaService,
    startViaService
  }
}
