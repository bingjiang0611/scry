import { join } from 'node:path'
import { isHostCliExperimentalEnabled } from '../shared/experimental-host-cli'
import { isInsideHostChild } from '../shared/host-admin'
import type { BuildIdentity } from '../shared/build-identity'
import {
  prepareBackgroundServiceStop,
  stopBackgroundService,
  type BackgroundServiceStopDeps
} from '../main/background-service-stop'
import { daemonLogPath } from './daemon-log'
import { createLoginStartManager, type LoginStartManager } from './login-start'
import { callHostAdmin } from './host-admin-client'
import { resolveHostCliTarget } from './host-cli-paths'
import type { HostAdminStatusPayload } from './host-cli-format'

export const EXIT_OK = 0
export const EXIT_USAGE_OR_REFUSED = 1
export const EXIT_DAEMON_NOT_RUNNING = 2
export const EXIT_VERSION_MISMATCH = 3
export const EXIT_APPROVAL_DISABLED = 4
export const EXIT_USER_CANCELLED = 5
export const EXIT_RATE_LIMITED = 6

export interface HostCliServiceContext {
  userDataDir: string
  executable?: string
  platform: NodeJS.Platform
  homeDir: string
  env: NodeJS.ProcessEnv
  clientIdentity: BuildIdentity
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  stdout(text: string): void
  stderr(text: string): void
  prompt(question: string): Promise<string>
  stopDeps?: BackgroundServiceStopDeps
  loginStart?: LoginStartManager
}

export function getLoginStartManager(ctx: HostCliServiceContext): LoginStartManager {
  if (ctx.loginStart) return ctx.loginStart
  const target = resolveHostCliTarget({
    ...(ctx.executable ? { executable: ctx.executable } : {}),
    userDataDir: ctx.userDataDir,
    platform: ctx.platform,
    homeDir: ctx.homeDir,
    env: ctx.env
  })
  return createLoginStartManager({
    target,
    platform: ctx.platform,
    homeDir: ctx.homeDir,
    env: ctx.env
  })
}

export async function reportUnavailableAdminSocket(
  ctx: HostCliServiceContext,
  options: { jsonStatus?: boolean } = {}
): Promise<number> {
  const prepared = await prepareBackgroundServiceStop(getStopDeps(ctx))
  if (prepared.status === 'running') {
    const logPath = daemonLogPath(ctx.userDataDir)
    const flagOn = isHostCliExperimentalEnabled(ctx.env)
    if (options.jsonStatus) {
      ctx.stdout(`${JSON.stringify({
        daemon: { running: true, pid: prepared.holder.pid },
        hostCliEnabled: false,
        error: flagOn ? 'host_admin_socket_unavailable' : 'host_cli_experimental_disabled',
        ...(flagOn ? { daemonLogPath: logPath } : {})
      }, null, 2)}\n`)
    } else if (flagOn) {
      ctx.stderr(`后台服务正在运行（pid ${prepared.holder.pid}），但 host-admin.sock 不可用（可能是后台服务未带 SCRY_EXPERIMENTAL_HOST_CLI=1 启动，或 admin socket 创建失败；请查看 ${logPath} 中的 host-admin.disabled 原因）。\n`)
    } else {
      ctx.stderr(`后台服务正在运行（pid ${prepared.holder.pid}），但命令行管理功能未开启（host-admin.sock 不可用；如已为后台服务启用 SCRY_EXPERIMENTAL_HOST_CLI=1，请查看 ${logPath} 中的 host-admin.disabled 原因）。\n`)
    }
    return EXIT_APPROVAL_DISABLED
  }
  if (prepared.status === 'refused') {
    ctx.stderr(`无法确认后台服务状态（${prepared.reason}）。\n`)
    return EXIT_USAGE_OR_REFUSED
  }
  const installed = getLoginStartManager(ctx).canLaunchViaService()
  ctx.stderr(daemonNotRunningHint(ctx, installed))
  return EXIT_DAEMON_NOT_RUNNING
}

export function getStopDeps(ctx: HostCliServiceContext): BackgroundServiceStopDeps {
  if (ctx.stopDeps) return ctx.stopDeps
  return {
    paths: {
      stateDirectory: join(ctx.userDataDir, 'daemon'),
      userDataDir: ctx.userDataDir
    }
  }
}

export function daemonNotRunningHint(ctx: HostCliServiceContext, serviceInstalled: boolean): string {
  if (serviceInstalled) {
    if (ctx.platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '$(id -u)'
      return `后台服务未运行。已安装登录服务，可执行：launchctl kickstart gui/${uid}/com.scry.daemon\n`
    }
    return '后台服务未运行。已安装登录服务，可执行：systemctl --user start scry-daemon.service\n'
  }
  return '后台服务未运行。可执行 scry-host login-start enable 或打开 Scry App 启动。\n'
}

export async function runHostCliRestart(ctx: HostCliServiceContext): Promise<number> {
  const stopDeps = getStopDeps(ctx)
  const loginStart = getLoginStartManager(ctx)
  const prepared = await prepareBackgroundServiceStop(stopDeps)
  if (prepared.status === 'refused') {
    ctx.stderr(`无法停止后台服务（${prepared.reason}）。\n`)
    return EXIT_USAGE_OR_REFUSED
  }

  if (prepared.status === 'running') {
    // Best-effort read activeRuns; if unavailable or mismatched, ask confirmation conservatively (§3.8).
    let activeRuns: number | null = null
    const st = await callHostAdmin({
      daemonStateDirectory: stopDeps.paths.stateDirectory,
      clientIdentity: ctx.clientIdentity,
      method: 'status'
    })
    if (st.ok) {
      const payload = st.result as Partial<HostAdminStatusPayload> | null
      if (payload && Number.isSafeInteger(payload.activeRuns)) activeRuns = payload.activeRuns as number
    }

    if (activeRuns !== 0) {
      if (!ctx.stdinIsTTY || !ctx.stdoutIsTTY) {
        ctx.stderr('host_cli_requires_tty: 存在运行中或未知数量的任务，重启后台服务需要交互确认。\n')
        return EXIT_USAGE_OR_REFUSED
      }
      const warning = activeRuns === null
        ? '无法确认当前是否有运行中的任务，重启会中断它们。'
        : `当前有 ${activeRuns} 个正在运行的任务，重启会中断它们。`
      ctx.stdout(`${warning}\n`)
      const answer = (await ctx.prompt('输入 yes 确认重启后台服务: ')).trim().toLowerCase()
      if (answer !== 'yes') {
        ctx.stderr('已取消重启。\n')
        return EXIT_USER_CANCELLED
      }
    }

    const stopped = await stopBackgroundService(prepared.holder, stopDeps)
    if (stopped.status === 'refused') {
      ctx.stderr(`停止后台服务失败（${stopped.reason}）。\n`)
      return EXIT_USAGE_OR_REFUSED
    }
  }

  if (loginStart.canLaunchViaService()) {
    const started = await loginStart.startViaService()
    if (!started.ok) {
      ctx.stderr(`通过系统服务重新拉起失败（${started.reason}${started.exitCode !== undefined ? `, exit ${started.exitCode}` : ''}）。\n`)
      return EXIT_USAGE_OR_REFUSED
    }
    ctx.stdout('后台服务已通过系统服务重启。\n')
    return EXIT_OK
  }

  ctx.stdout('后台服务已停止。未安装登录时启动服务，因此未自动拉起；请打开 Scry App 或运行 scry-host login-start enable。\n')
  return EXIT_OK
}

export async function runHostCliLoginStart(subcommand: string | undefined, ctx: HostCliServiceContext): Promise<number> {
  if (subcommand !== 'enable' && subcommand !== 'disable' && subcommand !== 'status') {
    ctx.stderr('用法: scry-host login-start <enable|disable|status>\n')
    return EXIT_USAGE_OR_REFUSED
  }
  const loginStart = getLoginStartManager(ctx)
  const stopDeps = getStopDeps(ctx)

  if (subcommand === 'status') {
    const status = await loginStart.status()
    ctx.stdout(`${JSON.stringify(status, null, 2)}\n`)
    return EXIT_OK
  }

  if (subcommand === 'enable') {
    if (isInsideHostChild(ctx.env)) {
      ctx.stderr('host_cli_inside_agent: 拒绝在 Scry 运行的 Agent 或终端内开启登录时启动。\n')
      return EXIT_USAGE_OR_REFUSED
    }
    if (!ctx.stdinIsTTY || !ctx.stdoutIsTTY) {
      ctx.stderr('host_cli_requires_tty: 开启登录时启动需要在交互终端中确认。\n')
      return EXIT_USAGE_OR_REFUSED
    }
    const precheck = loginStart.precheckEnable()
    if (!precheck.ok) {
      ctx.stderr(`无法开启登录时启动（${precheck.reason}）。\n`)
      return EXIT_USAGE_OR_REFUSED
    }
    ctx.stdout('将安装一个随登录常驻、可被已配对设备远程访问的后台服务（不会打开「允许命令行批准」）。\n')
    const answer = (await ctx.prompt('输入 yes 确认开启登录时启动: ')).trim().toLowerCase()
    if (answer !== 'yes') {
      ctx.stderr('已取消。\n')
      return EXIT_USER_CANCELLED
    }
    const daemonRunning = (await prepareBackgroundServiceStop(stopDeps)).status === 'running'
    const result = await loginStart.enable({ daemonRunning })
    if (!result.ok) {
      ctx.stderr(`开启登录时启动失败（${result.reason}${result.exitCode !== undefined ? `, exit ${result.exitCode}` : ''}）。\n`)
      return EXIT_USAGE_OR_REFUSED
    }
    ctx.stdout('已开启登录时启动。\n')
    return EXIT_OK
  }

  const daemonRunning = (await prepareBackgroundServiceStop(stopDeps)).status === 'running'
  const result = await loginStart.disable({ daemonRunning })
  if (!result.ok) {
    ctx.stderr(`关闭登录时启动失败（${result.reason}${result.exitCode !== undefined ? `, exit ${result.exitCode}` : ''}）。\n`)
    return EXIT_USAGE_OR_REFUSED
  }
  ctx.stdout('已关闭登录时启动（当前运行的后台服务未停止）。\n')
  return EXIT_OK
}
