import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildIdentity, scryBundleVersion, type BuildIdentity } from '../shared/build-identity'
import { isHostCliExperimentalEnabled } from '../shared/experimental-host-cli'
import { isInsideHostChild } from '../shared/host-admin'
import type { RemoteDevice, RemotePairingCode, RemotePendingPairing } from '../shared/remote'
import type { BackgroundServiceStopDeps } from '../main/background-service-stop'
import type { LoginStartManager } from './login-start'
import { callHostAdmin } from './host-admin-client'
import type { HostAdminReply } from './host-admin-socket'
import { defaultHostUserDataDir } from './host-cli-paths'
import {
  formatDeviceList,
  formatPendingList,
  formatRemainingSeconds,
  formatStatusReport,
  groupFingerprint64,
  normalizeHexPrefix,
  resolveIdQuery,
  shortFingerprint16,
  type HostAdminStatusPayload
} from './host-cli-format'
import {
  daemonNotRunningHint,
  EXIT_APPROVAL_DISABLED,
  EXIT_DAEMON_NOT_RUNNING,
  EXIT_OK,
  EXIT_RATE_LIMITED,
  EXIT_USAGE_OR_REFUSED,
  EXIT_USER_CANCELLED,
  EXIT_VERSION_MISMATCH,
  getLoginStartManager,
  runHostCliLoginStart,
  runHostCliRestart,
  type HostCliServiceContext
} from './host-cli-service'

export interface HostCliIo {
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  stdout(text: string): void
  stderr(text: string): void
  prompt(question: string): Promise<string>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
  userDataDir?: string
  executable?: string
  clientIdentity?: BuildIdentity
  stopDeps?: BackgroundServiceStopDeps
  loginStart?: LoginStartManager
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const USAGE = [
  '用法: scry-host <command> [options]',
  '  status [--json]                     查看后台服务与配对用量状态',
  '  pending [--json]                    查看待确认配对',
  '  devices [--json]                    查看已配对设备与批准方式',
  '  invite <phone|desktop> [--wait]     生成一次性配对邀请（需交互终端与开启开关）',
  '  approve [<pairingId-or-prefix>]     比对指纹并批准待确认设备（需交互终端）',
  '  cancel <pairingId-or-prefix> [--yes]',
  '  revoke <deviceId-or-prefix> [--yes]',
  '  desktop-off [--yes]',
  '  restart',
  '  login-start <enable|disable|status>'
].join('\n')

function requireTtyAndNotChild(ctx: HostCliServiceContext): number | null {
  if (isInsideHostChild(ctx.env)) {
    ctx.stderr('host_cli_inside_agent: 拒绝在 Scry 运行的 Agent 或终端内执行此操作，请使用普通终端或 SSH。\n')
    return EXIT_USAGE_OR_REFUSED
  }
  if (!ctx.stdinIsTTY || !ctx.stdoutIsTTY) {
    ctx.stderr('host_cli_requires_tty: 此命令必须在交互终端（TTY）中运行。\n')
    return EXIT_USAGE_OR_REFUSED
  }
  return null
}

function handleAdminFailure(reply: Extract<HostAdminReply, { ok: false }>, ctx: HostCliServiceContext): number {
  if (reply.error === 'daemon_not_running') {
    const installed = getLoginStartManager(ctx).canLaunchViaService()
    ctx.stderr(daemonNotRunningHint(ctx, installed))
    return EXIT_DAEMON_NOT_RUNNING
  }
  if (reply.error === 'daemon_version_mismatch') {
    const running = reply.daemon ? `${reply.daemon.version}${reply.daemon.build ? ` (${reply.daemon.build})` : ''}` : '未知'
    const expected = `${ctx.clientIdentity.version}${ctx.clientIdentity.build ? ` (${ctx.clientIdentity.build})` : ''}`
    ctx.stderr(`版本不一致：运行中的后台服务为 ${running}，当前 scry-host 为 ${expected}。请运行 scry-host restart。\n`)
    return EXIT_VERSION_MISMATCH
  }
  if (reply.error === 'host_cli_approval_disabled') {
    ctx.stderr('host_cli_approval_disabled: 命令行批准未开启。请在执行端 Scry App「设置 → 后台服务」中打开「允许命令行批准」。\n')
    return EXIT_APPROVAL_DISABLED
  }
  if (reply.error === 'host_cli_rate_limited') {
    const waitSec = Math.ceil((reply.retryAfterMs ?? 60_000) / 1000)
    ctx.stderr(`host_cli_rate_limited: 已达到每小时操作上限，请在约 ${waitSec} 秒后重试。\n`)
    return EXIT_RATE_LIMITED
  }
  ctx.stderr(`操作被拒绝（${reply.error}）。\n`)
  return EXIT_USAGE_OR_REFUSED
}

async function runApproveFlow(
  targetQuery: string | undefined,
  ctx: HostCliServiceContext,
  now: () => number
): Promise<number> {
  const stateDirectory = join(ctx.userDataDir, 'daemon')
  const pendingReply = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity: ctx.clientIdentity, method: 'pending' })
  if (!pendingReply.ok) return handleAdminFailure(pendingReply, ctx)
  const { enabled, pending } = pendingReply.result as { enabled: boolean; pending: RemotePendingPairing[] }
  if (!enabled) {
    ctx.stderr('远程访问未启用（remote_host_disabled）。\n')
    return EXIT_USAGE_OR_REFUSED
  }

  const awaiting = pending.filter((p) => p.state === 'awaiting_local_confirmation' && typeof p.publicKeySHA256 === 'string')
  const created = pending.filter((p) => p.state === 'created')
  if (awaiting.length === 0) {
    if (created.length > 0) ctx.stdout('当前配对仍在等待设备提交证明（created），请稍后重试。\n')
    else ctx.stdout('当前没有待确认配对。\n')
    return EXIT_USAGE_OR_REFUSED
  }

  let chosen: RemotePendingPairing
  if (targetQuery) {
    const resolved = resolveIdQuery(awaiting, (p) => p.pairingId, targetQuery, { allowPrefix: true })
    if (!resolved.ok) {
      ctx.stderr(`无法匹配配对标识（${resolved.error}）。\n`)
      return EXIT_USAGE_OR_REFUSED
    }
    chosen = resolved.item
  } else if (awaiting.length === 1) {
    chosen = awaiting[0]!
  } else {
    ctx.stderr('存在多个待确认配对，请指定至少 8 位唯一 pairingId 前缀。\n')
    ctx.stdout(formatPendingList(awaiting, now()))
    return EXIT_USAGE_OR_REFUSED
  }

  const fullFp = chosen.publicKeySHA256!
  ctx.stdout(
    `设备名:      ${chosen.deviceLabel ?? '未命名设备'}\n` +
    `pairingId:  ${chosen.pairingId.slice(0, 8)} (${chosen.pairingId})\n` +
    `指纹前 16 位: ${shortFingerprint16(fullFp)}\n` +
    `完整指纹:    ${groupFingerprint64(fullFp)}\n` +
    `剩余时间:    ${formatRemainingSeconds(chosen.expiresAt, now())}\n`
  )

  const enteredRaw = await ctx.prompt('请输入设备上显示的指纹（至少 16 位十六进制，忽略空格与大小写）: ')
  const entered = normalizeHexPrefix(enteredRaw)
  if (entered.length < 16 || !/^[0-9a-f]+$/.test(entered)) {
    ctx.stderr('指纹格式无效：必须输入至少 16 位十六进制字符。\n')
    return EXIT_USAGE_OR_REFUSED
  }
  const fpMatches = awaiting.filter((p) => p.publicKeySHA256!.toLowerCase().startsWith(entered))
  if (fpMatches.length > 1) {
    ctx.stderr('fingerprint_ambiguous: 输入的指纹前缀匹配多台待确认设备，已拒绝。\n')
    return EXIT_USAGE_OR_REFUSED
  }
  if (!fullFp.toLowerCase().startsWith(entered)) {
    ctx.stderr('local_confirmation_mismatch: 输入的指纹与该待确认配对不匹配，已拒绝。\n')
    return EXIT_USAGE_OR_REFUSED
  }

  ctx.stdout('后果说明：批准后该设备将成为 owner 设备（scope: remote），可按现有权限模式在本机运行 Provider。批准会通知本机 App 与所有已配对设备。\n')
  const confirm = (await ctx.prompt('输入 yes 确认批准该设备: ')).trim().toLowerCase()
  if (confirm !== 'yes') {
    ctx.stderr('已取消批准。\n')
    return EXIT_USER_CANCELLED
  }

  const approveReply = await callHostAdmin({
    daemonStateDirectory: stateDirectory,
    clientIdentity: ctx.clientIdentity,
    method: 'approve',
    args: { pairingId: chosen.pairingId, publicKeySHA256: fullFp }
  })
  if (!approveReply.ok) return handleAdminFailure(approveReply, ctx)
  const approved = approveReply.result as RemoteDevice
  ctx.stdout(`已批准设备「${approved.deviceLabel}」（deviceId: ${approved.deviceId}）。\n`)
  return EXIT_OK
}

export async function runHostCli(argv: readonly string[], io: HostCliIo): Promise<number> {
  const env = io.env ?? process.env
  const platform = io.platform ?? process.platform
  const homeDir = io.homeDir ?? homedir()
  const userDataDir = io.userDataDir ?? defaultHostUserDataDir(platform, homeDir, env)
  const clientIdentity = io.clientIdentity ?? buildIdentity(scryBundleVersion() ?? '0.0.0')
  const now = io.now ?? Date.now
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  if (env.SCRY_TEST_APP === '1' && !io.userDataDir) {
    io.stderr('scry-host 不支持测试实例（SCRY_TEST_APP=1）。\n')
    return EXIT_USAGE_OR_REFUSED
  }

  const ctx: HostCliServiceContext = {
    userDataDir,
    ...(io.executable ? { executable: io.executable } : {}),
    platform,
    homeDir,
    env,
    clientIdentity,
    stdinIsTTY: io.stdinIsTTY,
    stdoutIsTTY: io.stdoutIsTTY,
    stdout: io.stdout,
    stderr: io.stderr,
    prompt: io.prompt,
    ...(io.stopDeps ? { stopDeps: io.stopDeps } : {}),
    ...(io.loginStart ? { loginStart: io.loginStart } : {})
  }

  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    ctx.stdout(`${USAGE}\n`)
    return EXIT_OK
  }

  if (command === 'restart') return await runHostCliRestart(ctx)
  if (command === 'login-start') return await runHostCliLoginStart(rest[0], ctx)

  const stateDirectory = join(userDataDir, 'daemon')
  const experimental = isHostCliExperimentalEnabled(env)

  if (command === 'invite' || command === 'approve') {
    if (!experimental) {
      ctx.stderr('host_cli_experimental_disabled: 命令行批准功能未启用，需设置 SCRY_EXPERIMENTAL_HOST_CLI=1。\n')
      return EXIT_APPROVAL_DISABLED
    }
    const guard = requireTtyAndNotChild(ctx)
    if (guard !== null) return guard
  }

  if (command === 'status') {
    const json = rest.includes('--json')
    if (rest.some((a) => a !== '--json')) { ctx.stderr(`${USAGE}\n`); return EXIT_USAGE_OR_REFUSED }
    const reply = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method: 'status' })
    if (!reply.ok) return handleAdminFailure(reply, ctx)
    const status = reply.result as HostAdminStatusPayload
    const loginStart = await getLoginStartManager(ctx).status().catch(() => undefined)
    if (json) ctx.stdout(`${JSON.stringify({ ...status, ...(loginStart ? { loginStart } : {}) }, null, 2)}\n`)
    else ctx.stdout(formatStatusReport(status, loginStart))
    return EXIT_OK
  }

  if (command === 'pending') {
    const json = rest.includes('--json')
    if (rest.some((a) => a !== '--json')) { ctx.stderr(`${USAGE}\n`); return EXIT_USAGE_OR_REFUSED }
    const reply = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method: 'pending' })
    if (!reply.ok) return handleAdminFailure(reply, ctx)
    const data = reply.result as { enabled: boolean; pending: RemotePendingPairing[] }
    if (json) ctx.stdout(`${JSON.stringify(data, null, 2)}\n`)
    else ctx.stdout(data.enabled ? formatPendingList(data.pending, now()) : '远程访问未启用。\n')
    return EXIT_OK
  }

  if (command === 'devices') {
    const json = rest.includes('--json')
    if (rest.some((a) => a !== '--json')) { ctx.stderr(`${USAGE}\n`); return EXIT_USAGE_OR_REFUSED }
    const reply = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method: 'devices' })
    if (!reply.ok) return handleAdminFailure(reply, ctx)
    const data = reply.result as { enabled: boolean; devices: RemoteDevice[] }
    if (json) ctx.stdout(`${JSON.stringify(data, null, 2)}\n`)
    else ctx.stdout(data.enabled ? formatDeviceList(data.devices) : '远程访问未启用。\n')
    return EXIT_OK
  }

  if (command === 'invite') {
    const target = rest[0]
    const flags = rest.slice(1)
    if ((target !== 'phone' && target !== 'desktop') || flags.some((f) => f !== '--wait')) {
      ctx.stderr('用法: scry-host invite <phone|desktop> [--wait]（不支持 --json）\n')
      return EXIT_USAGE_OR_REFUSED
    }
    const wait = flags.includes('--wait')
    const existingPending = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method: 'pending' })
    if (!existingPending.ok) return handleAdminFailure(existingPending, ctx)
    const activePending = (existingPending.result as { pending: RemotePendingPairing[] }).pending
    if (activePending.length > 0) {
      ctx.stdout('注意：当前已有未完成的邀请，新邀请会取消它。\n')
      const answer = (await ctx.prompt('输入 yes 继续创建新邀请: ')).trim().toLowerCase()
      if (answer !== 'yes') { ctx.stderr('已取消。\n'); return EXIT_USER_CANCELLED }
    }

    const method = target === 'phone' ? 'invite_phone' : 'invite_desktop'
    const invReply = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method })
    if (!invReply.ok) return handleAdminFailure(invReply, ctx)

    let createdPairingId: string | undefined
    if (target === 'phone') {
      const code = invReply.result as RemotePairingCode
      createdPairingId = code.pairingId
      ctx.stdout(`pairingId: ${code.pairingId}\n`)
      if (code.deviceCode) ctx.stdout(`${code.deviceCode}\n`)
      else ctx.stdout(`中继未配置，一次性配对密钥: ${code.secret}\n`)
    } else {
      const { invitation } = invReply.result as { invitation: string }
      ctx.stdout(`${invitation}\n`)
    }

    if (!wait) return EXIT_OK
    ctx.stdout('等待设备提交证明…\n')
    const deadline = now() + 125_000
    while (now() < deadline) {
      await sleep(1_000)
      const poll = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method: 'pending' })
      if (!poll.ok) return handleAdminFailure(poll, ctx)
      const list = (poll.result as { pending: RemotePendingPairing[] }).pending
      const ready = list.find((p) => p.state === 'awaiting_local_confirmation' && (!createdPairingId || p.pairingId === createdPairingId))
      if (ready) return await runApproveFlow(ready.pairingId, ctx, now)
      if (createdPairingId && !list.some((p) => p.pairingId === createdPairingId)) {
        ctx.stderr('邀请已过期或被取消。\n')
        return EXIT_USAGE_OR_REFUSED
      }
    }
    ctx.stderr('等待设备提交证明超时。\n')
    return EXIT_USAGE_OR_REFUSED
  }

  if (command === 'approve') {
    if (rest.some((a) => a.startsWith('-')) || rest.length > 1) {
      ctx.stderr('用法: scry-host approve [<pairingId-or-prefix>]（不支持 --yes / --all / --fingerprint）\n')
      return EXIT_USAGE_OR_REFUSED
    }
    return await runApproveFlow(rest[0], ctx, now)
  }

  if (command === 'cancel' || command === 'revoke') {
    const yes = rest.includes('--yes')
    const positional = rest.filter((a) => a !== '--yes')
    if (positional.length !== 1 || positional[0]!.startsWith('-')) {
      ctx.stderr(`用法: scry-host ${command} <id-or-prefix> [--yes]\n`)
      return EXIT_USAGE_OR_REFUSED
    }
    const query = positional[0]!
    const listMethod = command === 'cancel' ? 'pending' : 'devices'
    const listReply = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method: listMethod })
    if (!listReply.ok) return handleAdminFailure(listReply, ctx)

    const resolved = command === 'cancel'
      ? resolveIdQuery((listReply.result as { pending: RemotePendingPairing[] }).pending, (p) => p.pairingId, query, { allowPrefix: !yes })
      : resolveIdQuery((listReply.result as { devices: RemoteDevice[] }).devices.filter((d) => !d.revoked), (d) => d.deviceId, query, { allowPrefix: !yes })
    if (!resolved.ok) {
      ctx.stderr(`无法匹配标识（${resolved.error}）。\n`)
      return EXIT_USAGE_OR_REFUSED
    }
    const id = command === 'cancel'
      ? (resolved.item as RemotePendingPairing).pairingId
      : (resolved.item as RemoteDevice).deviceId
    if (!yes) {
      if (!ctx.stdinIsTTY || !ctx.stdoutIsTTY) {
        ctx.stderr('host_cli_requires_tty: 非交互调用需提供完整 ID 与 --yes。\n')
        return EXIT_USAGE_OR_REFUSED
      }
      const answer = (await ctx.prompt(`输入 yes 确认${command === 'cancel' ? '取消配对' : '撤销设备'} ${id}: `)).trim().toLowerCase()
      if (answer !== 'yes') { ctx.stderr('已取消。\n'); return EXIT_USER_CANCELLED }
    }
    const reply = await callHostAdmin({
      daemonStateDirectory: stateDirectory,
      clientIdentity,
      method: command,
      args: command === 'cancel' ? { pairingId: id } : { deviceId: id }
    })
    if (!reply.ok) return handleAdminFailure(reply, ctx)
    ctx.stdout(command === 'cancel' ? `已取消配对 ${id}。\n` : `已撤销设备 ${id}。\n`)
    return EXIT_OK
  }

  if (command === 'desktop-off') {
    const yes = rest.includes('--yes')
    if (rest.some((a) => a !== '--yes')) { ctx.stderr('用法: scry-host desktop-off [--yes]\n'); return EXIT_USAGE_OR_REFUSED }
    if (!yes) {
      if (!ctx.stdinIsTTY || !ctx.stdoutIsTTY) {
        ctx.stderr('host_cli_requires_tty: 非交互调用需加 --yes。\n')
        return EXIT_USAGE_OR_REFUSED
      }
      const answer = (await ctx.prompt('输入 yes 确认关闭桌面远程访问（不撤销已配对设备）: ')).trim().toLowerCase()
      if (answer !== 'yes') { ctx.stderr('已取消。\n'); return EXIT_USER_CANCELLED }
    }
    const reply = await callHostAdmin({ daemonStateDirectory: stateDirectory, clientIdentity, method: 'desktop_off' })
    if (!reply.ok) return handleAdminFailure(reply, ctx)
    ctx.stdout('已关闭桌面远程访问。\n')
    return EXIT_OK
  }

  ctx.stderr(`未知命令: ${command}\n${USAGE}\n`)
  return EXIT_USAGE_OR_REFUSED
}
