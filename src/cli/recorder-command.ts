import { type ParsedArgs, workspaceOf, readStdin, flag, intFlag, providerOf, print } from './command-args.js'
import { sendRecorderDaemonHook, startRecorderDaemon, serveRecorderDaemon, recorderDaemonStatus, stopRecorderDaemon } from '../core/turn-recorder/daemon.js'
import { handleRecorderHook, recorderEnablement, recoverRecorder, refreshRecorderPendingHealth } from '../core/turn-recorder/recorder.js'
import { recordError, drainCommitNotifications, retryCommitNotifications, RECORDER_VERSION, readHealth, commitNotificationStatus } from '../core/turn-recorder/store.js'
import { resolveCommitHookActivation, commitHookEnv, revokeCommitHookGrant, inspectCommitHookBundle, writeCommitHookGrant } from '../core/turn-recorder/commit-hook-grant.js'
import { runIdleAutoUpdate } from './update.js'
import { readHookSkips } from '../core/turn-recorder/hook-diagnostics.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'


export async function hookCommand(args: ParsedArgs): Promise<number> {
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
    if (daemonEnabled && !daemonTried) {
      try {
        const result = await sendRecorderDaemonHook({
          provider,
          event,
          workspace,
          payload,
          timeoutMs: event === 'UserPromptSubmit' || event === 'Stop' ? 4_000 : 1_000
        })
        if (verbose) print(result)
        return 0
      } catch {
        // Cold start or stale socket: record this event directly, then start the daemon.
      }
    }
    delegatedToCore = true
    const result = await handleRecorderHook({
      provider,
      event,
      workspace,
      payload,
      managed,
      queueOnly: daemonTried
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
  if (action === 'recover') {
    print(await recoverRecorder(workspaceOf(args)))
    return 0
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
    return result.pending > 0 ? 3 : 0
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
