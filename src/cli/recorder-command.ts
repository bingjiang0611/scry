import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { type ParsedArgs, workspaceOf, readStdin, flag, intFlag, providerOf, print, listFlags } from './command-args.js'
import { sendRecorderDaemonHook, startRecorderDaemon, serveRecorderDaemon, recorderDaemonStatus, stopRecorderDaemon, RecorderHookRejected } from '../core/turn-recorder/daemon.js'
import { captureCommand, sessionHookCommand } from './capture-command.js'
import { handleRecorderHook, recorderEnablement, recoverRecorder, refreshRecorderPendingHealth, type RecorderRecoveryScope } from '../core/turn-recorder/recorder.js'
import { recordError, drainCommitNotifications, retryCommitNotifications, RECORDER_VERSION, readHealth, commitNotificationStatus } from '../core/turn-recorder/store.js'
import { resolveCommitHookActivation, commitHookEnv, revokeCommitHookGrant, inspectCommitHookBundle, writeCommitHookGrant } from '../core/turn-recorder/commit-hook-grant.js'
import { runIdleAutoUpdate } from './update.js'
import { readHookSkips } from '../core/turn-recorder/hook-diagnostics.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'
import { repairRecordContent } from '../core/turn-recorder/content-repair.js'
import { appTraceContentRoots } from '../core/turn-recorder/app-trace-content.js'


export async function hookCommand(args: ParsedArgs): Promise<number> {
  if (flag(args, 'capture-mode') !== undefined) return sessionHookCommand(args)
  const quiet = args.flags.has('quiet')
  const verbose = args.flags.has('verbose') && !quiet
  const workspace = workspaceOf(args)
  let delegatedToCore = false
  try {
    const source = await readStdin()
    const payload = source.trim() ? JSON.parse(source) as Record<string, unknown> : {}
    const event = flag(args, 'event')
    if (!event) throw new Error('--event is required')
    const provider = providerOf(args)
    const managed = args.flags.has('managed')
    const daemonEnabled = !managed && process.env.SCRY_RECORDER_TRANSPORT !== 'direct'
    const daemonTried = daemonEnabled && process.env.SCRY_RECORDER_DAEMON_TRIED === '1'
    // The shell fast path already saw an explicit pre-apply refusal (404 on a legacy daemon, or the
    // version handshake): replace the owner and deliver once instead of repeating that attempt.
    const daemonRejected = daemonEnabled && !daemonTried && process.env.SCRY_RECORDER_DAEMON_REJECTED !== undefined
    let daemonUnknownDelivery = false
    const send = (): Promise<Record<string, unknown>> => sendRecorderDaemonHook({
      provider,
      event,
      workspace,
      payload,
      // A versioned endpoint answers immediately; the timeout only bounds the applied path.
      timeoutMs: event === 'UserPromptSubmit' || event === 'Stop' ? 4_000 : 1_000
    })
    const replaceDaemon = async (): Promise<boolean> => {
      const scriptPath = process.argv[1]
      if (!scriptPath) return false
      // Existing replacement path: stop the current owner, wait for the socket, start this CLI.
      return startRecorderDaemon({ workspace, scriptPath }).then(() => true, () => false)
    }
    // `delivered` 已应用；`not-applied` 有证据证明守护进程没收到或明确拒绝；`unknown` 可能是
    // “已经应用但响应没回来”。只有前两种能直接落到本进程，最后一种必须排队重放，绝不重发。
    type SendOutcome = 'delivered' | 'not-applied' | 'unknown'
    const classify = (error: unknown): SendOutcome => {
      // A completed non-2xx answer without a replacement hint is a refusal before apply only for the
      // pre-apply statuses the daemon uses; anything else (5xx, missing ACK) may follow a partial apply.
      if (error instanceof RecorderHookRejected) {
        return error.statusCode >= 500 ? 'unknown' : 'not-applied'
      }
      // Never connected: the request cannot have been applied.
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      return code === 'ENOENT' || code === 'ECONNREFUSED' ? 'not-applied' : 'unknown'
    }
    if (daemonEnabled && !daemonTried) {
      const redeliver = async (): Promise<SendOutcome> => {
        if (daemonRejected && !await replaceDaemon()) return 'not-applied'
        let outcome: SendOutcome
        try {
          const result = await send()
          if (verbose) print(result)
          return 'delivered'
        } catch (error) {
          outcome = classify(error)
          if (daemonRejected || outcome === 'unknown') return outcome
          // Only a completed 404/409 proves the event was not applied; replace the owner and resend
          // exactly once. A timeout stays unknown delivery and is never resent.
          if (!(error instanceof RecorderHookRejected) || !error.replaceDaemon) return outcome
          if (!await replaceDaemon()) return 'not-applied'
          try {
            const result = await send()
            if (verbose) print(result)
            return 'delivered'
          } catch (retryError) {
            return classify(retryError)
          }
        }
      }
      const outcome = await redeliver()
      if (outcome === 'delivered') return 0
      // The daemon may already hold this event: queue it for replay instead of applying it here.
      if (outcome === 'unknown') daemonUnknownDelivery = true
    }
    delegatedToCore = true
    const result = await handleRecorderHook({
      provider,
      event,
      workspace,
      payload,
      managed,
      queueOnly: daemonTried || daemonUnknownDelivery
    })
    // A failed curl response is unknown delivery, not permission to stop/restart a live peer.
    if (daemonEnabled && !daemonTried && result.status !== 'disabled') {
      const scriptPath = process.argv[1]
      if (scriptPath) await startRecorderDaemon({ workspace, scriptPath, waitForReady: false }).catch(() => undefined)
    }
    if (verbose) print(result)
  } catch (error) {
    const enablement = await recorderEnablement(workspace).catch(() => null)
    if (!delegatedToCore && enablement?.enabled) await recordError(enablement.dataRoot, error)
    if (!quiet) process.stderr.write(`scry recorder hook: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  // Hook mode is observational and must never block the Provider.
  return 0
}

export async function recorderCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  if (action === 'hook') return hookCommand(args)
  if (action === 'capture') return captureCommand(args)
  if (action === 'content') return contentCommand(args)
  if (action === 'recover') {
    const providerFlag = flag(args, 'provider')
    const sessionId = flag(args, 'session-id')
    if ((providerFlag === undefined) !== (sessionId === undefined)) {
      throw new Error('--provider and --session-id must be provided together for scoped recovery')
    }
    let scope: RecorderRecoveryScope | undefined
    if (providerFlag !== undefined && sessionId !== undefined) {
      const provider = providerOf(args)
      if (provider !== 'qoder') throw new Error('scoped recorder recovery is only supported for qoder')
      if (!sessionId.trim()) throw new Error('--session-id must not be empty')
      scope = { provider, sessionId }
    }
    const workspace = workspaceOf(args)
    if (scope) {
      const enablement = await recorderEnablement(workspace)
      if (!enablement.enabled) {
        print({ action, workspace, status: 'disabled', reason: enablement.reason })
        return 2
      }
    }
    const result = await recoverRecorder(workspace, process.env, undefined, scope)
    print(result)
    return scope && result.pending > 0 ? 3 : 0
  }
  if (action === 'notify-drain' || action === 'notify-retry') {
    const sequence = intFlag(args, 'sequence')
    if (action === 'notify-retry' && (args.positionals.length !== 2 || (sequence !== undefined) === args.flags.has('all-dead') || sequence === 0)) {
      throw new Error('notify-retry requires exactly one of --sequence N (positive integer) or --all-dead')
    }
    // Unbounded attempts, but deferred retries still respect their persisted due time.
    const workspace = workspaceOf(args)
    const enablement = await recorderEnablement(workspace)
    if (!enablement.enabled) {
      print({ action, workspace, status: 'disabled', reason: enablement.reason })
      return 2
    }
    const activation = await resolveCommitHookActivation(workspace, enablement.config)
    if (activation.status !== 'trusted' && activation.status !== 'host-provided') {
      print({ action, workspace, status: 'not-activated', activation })
      return activation.status === 'not-configured' ? 0 : 3
    }
    const env = commitHookEnv(activation, process.env)
    const result = action === 'notify-retry'
      ? await retryCommitNotifications(enablement.dataRoot, env, sequence)
      : await drainCommitNotifications(enablement.dataRoot, env)
    print({ action, workspace, activation: activation.status, ...result })
    // An unknown backlog (delivery state unreadable) is pending work, not success.
    return result.pending === null || result.pending > 0 ? 3 : 0
  }
  if (action === 'serve') {
    await serveRecorderDaemon({
      workspace: workspaceOf(args),
      socketPath: flag(args, 'socket'),
      // The daemon is the only trigger that reaches a machine nobody runs `scry` on by hand, and
      // its idle shutdown is the one moment where replacing the CLI cannot split a turn.
      idleUpdate: () => runIdleAutoUpdate(RECORDER_VERSION, process.argv[1])
    })
    return 0
  }
  if (action === 'status') {
    const workspace = workspaceOf(args)
    const enablement = await recorderEnablement(workspace)
    if (enablement.enabled) await refreshRecorderPendingHealth(enablement.dataRoot)
    print({
      ...await recorderDaemonStatus(workspace),
      health: enablement.enabled ? await readHealth(enablement.dataRoot) : null,
      hookSkips: await readHookSkips(workspace)
    })
    return 0
  }
  if (action === 'stop') {
    print({ stopped: await stopRecorderDaemon(workspaceOf(args)) })
    return 0
  }
  if (action === 'start' || action === 'restart') {
    const workspace = workspaceOf(args)
    if (action === 'restart') await stopRecorderDaemon(workspace)
    const scriptPath = process.argv[1]
    if (!scriptPath) throw new Error('cannot locate scry CLI entrypoint')
    const result = await startRecorderDaemon({ workspace, scriptPath })
    if (!args.flags.has('quiet')) print(result)
    return 0
  }
  throw new Error('usage: scry recorder hook|recover|notify-drain|notify-retry|start|serve|status|stop|restart ...')
}

/**
 * Exit codes: 0 ok (trusted, host-provided, or nothing configured), 2 storage/config
 * unavailable, 5 bundle invalid. Valid repository commit hooks are auto-authorized after
 * fingerprint validation; `--yes` remains accepted for backward-compatible scripts.
 */
export async function commitHookCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1] ?? 'status'
  if (!['status', 'trust', 'revoke'].includes(action)) {
    throw new Error('usage: scry commit-hook status|trust|revoke [--yes] [--show]')
  }
  const workspace = workspaceOf(args)
  const location = await resolveRecorderLocation(workspace)
  if (!location.valid) {
    print({
      action,
      workspace,
      status: 'unavailable',
      reason: location.reason,
      ...(location.detail ? { detail: location.detail } : {})
    })
    return 2
  }
  const { config, dataRoot, workspaceRoot } = location
  if (action === 'revoke') {
    const result = await revokeCommitHookGrant(workspaceRoot)
    print({ action, workspace: workspaceRoot, ...result })
    return 0
  }
  if (action === 'trust') {
    if (!config.commitHook) {
      print({ action, workspace: workspaceRoot, status: 'not-configured', detail: 'scry.config.json has no commitHook' })
      return 2
    }
    let bundle
    try {
      bundle = await inspectCommitHookBundle(workspaceRoot, config.commitHook)
    } catch (error) {
      print({
        action,
        workspace: workspaceRoot,
        status: 'bundle-invalid',
        detail: error instanceof Error ? error.message : String(error)
      })
      return 5
    }
    const written = await writeCommitHookGrant(workspaceRoot, bundle, process.env, 'auto')
    print({
      action,
      workspace: workspaceRoot,
      status: 'trusted',
      grantPath: written.grantPath,
      entryPath: bundle.entryPath,
      fingerprint: bundle.fingerprint,
      source: 'auto',
      next: 'run `scry recorder restart --workspace <root>` so a running daemon picks up the refreshed fingerprint'
    })
    return 0
  }
  const activation = await resolveCommitHookActivation(workspaceRoot, config)
  const notifications = await commitNotificationStatus(dataRoot, commitHookEnv(activation, process.env))
  print({
    action,
    workspace: workspaceRoot,
    configured: Boolean(config.commitHook),
    entry: config.commitHook?.entry ?? null,
    activation,
    notifications: {
      ackedThrough: notifications.ackedThrough,
      notifyBacklog: activation.status === 'trusted' || activation.status === 'host-provided'
        ? notifications.notifyBacklog
        : null,
      backlogEvidence: activation.status === 'trusted' || activation.status === 'host-provided'
        ? 'available'
        : 'unavailable: no activated commit hook, records are retained and never delivered'
    }
  })
  return activation.status === 'bundle-invalid' ? 5 : 0
}

/** App 的 userData 默认目录，与 Electron `app.getPath('userData')` 的平台规则一致。 */
export function defaultAppDataDir(platform: NodeJS.Platform = process.platform): string {
  const home = homedir()
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'scry')
  if (platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'scry')
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'scry')
}

/**
 * 修复记录引用、但本库缺失的正文。默认只读演练：报告汇总与未命中清单，`--apply` 才按 sha256 从
 * App trace 库复制（读时校验长度与摘要）。它不重写记录：记录语义仍由提交边界决定。
 */
async function contentCommand(args: ParsedArgs): Promise<number> {
  if (args.positionals[2] !== 'repair') {
    throw new Error('usage: scry recorder content repair [--apply] [--record-id <id>]... [--app-data <dir>] [--workspace <root>]')
  }
  const workspace = workspaceOf(args)
  const enablement = await recorderEnablement(workspace)
  if (!enablement.enabled) {
    print({ action: 'content-repair', workspace, status: 'unavailable', reason: enablement.reason })
    return 2
  }
  const appData = resolve(flag(args, 'app-data') ?? defaultAppDataDir())
  const report = await repairRecordContent({
    dataRoot: enablement.dataRoot,
    sourceRoots: await appTraceContentRoots(appData),
    recordIds: listFlags(args, 'record-id'),
    apply: args.flags.has('apply')
  })
  print({
    action: 'content-repair',
    workspace,
    appData,
    // 缺失与损坏是两件事：前者是“本库没有这份字节”，后者是“有这个名字的字节但不对”。两者都
    // 意味着引用仍无法兑现，所以都退出 3，但报告必须分开。
    status: report.missing > 0 && report.corrupt > 0
      ? (report.applied ? 'applied-with-unresolved' : 'unresolved')
      : report.missing > 0
        ? (report.applied ? 'applied-with-missing' : 'missing')
        : report.corrupt > 0
          ? (report.applied ? 'applied-with-corrupt' : 'corrupt')
          : report.applied ? 'applied' : 'planned',
    ...report
  })
  return report.missing > 0 || report.corrupt > 0 ? 3 : 0
}
