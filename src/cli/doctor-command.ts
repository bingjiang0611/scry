import { type ParsedArgs, workspaceOf, print } from './command-args.js'
import { recorderEnablement, refreshRecorderPendingHealth, OPEN_TURN_EXPIRY_MS } from '../core/turn-recorder/recorder.js'
import { readHookSkips, readUserHookSkips } from '../core/turn-recorder/hook-diagnostics.js'
import { RECORDER_VERSION, readHealth, verifyStore, lastRecordVersion, commitNotificationStatus } from '../core/turn-recorder/store.js'
import { readSequenceWatermark } from '../core/turn-recorder/sequence-watermark.js'
import { UnresolvedDeliveryPrefixError } from '../core/turn-recorder/commit-delivery-ledger.js'
import { recorderStaleOpenTurns } from '../core/turn-recorder/runtime-state.js'
import { providerHookScriptState } from './workspace-init.js'
import { discoverRepositories } from '../core/turn-recorder/config.js'
import { relative } from 'node:path'
import { commitHookEnv, resolveCommitHookActivation } from '../core/turn-recorder/commit-hook-grant.js'


/**
 * Stable schema for team CI: `schemaVersion`, `status`, `checks[]`, `runtime`, `evidence`.
 * Exit codes are a frozen contract: 0 healthy, 2 recorder disabled, 3 config missing/invalid,
 * 4 store corrupt, 5 degraded (pending turns or a recorded error).
 */
export async function doctorCommand(args: ParsedArgs): Promise<number> {
  const workspace = workspaceOf(args)
  const enablement = await recorderEnablement(workspace)
  const [hookSkips, userHookSkips] = await Promise.all([readHookSkips(workspace), readUserHookSkips()])
  const runtime = {
    recorderVersion: RECORDER_VERSION,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`
  }
  type Check = { id: string; status: 'pass' | 'fail' | 'warn'; detail: string; remediation?: string }
  const userSummary = userHookSkips.value
  const userWindowEmpty = userHookSkips.status === 'available' && userSummary?.count === 0
  // This log cannot identify a workspace. Show the warning without changing this
  // workspace's health/exit code or adding its rows to workspace failure counters.
  const userHookCheck: Check = {
    id: 'hook.userBridgeSkips',
    status: userWindowEmpty ? 'pass' : 'warn',
    detail: userSummary
      ? `user-global bridge_not_found; workspace unknown; ${userSummary.recentCount} within 24h or with unknown time; ${userSummary.count} in retained log window` +
        (userSummary.truncated ? '; bounded tail only' : '')
      : `user-global bridge_not_found; workspace unknown; unavailable: ${userHookSkips.omissionReason}`,
    ...(userWindowEmpty ? {} : {
      remediation: 'inspect the user state scry/hook-skip.log, identify the originating repository, then init or repair its bridge; no workspace identity is stored in this log'
    })
  }
  if (!enablement.enabled) {
    const missing = enablement.reason === 'invalid_config' || enablement.reason === 'missing_config'
    const checks: Check[] = [{
      id: 'recorder.enabled',
      status: 'fail',
      detail: enablement.detail ? `${enablement.reason}: ${enablement.detail}` : enablement.reason,
      remediation: missing ? 'run `scry init` in the Git repository root' : 'remove `.scry-disabled` or set SCRY_RECORDER_ENABLED=1'
    }, userHookCheck]
    print({
      schemaVersion: 1,
      status: enablement.reason === 'invalid_config' ? 'error' : 'unavailable',
      hookSkips,
      userHookSkips,
      healthy: false,
      enabled: false,
      ...runtime,
      workspace,
      reason: enablement.reason,
      detail: enablement.detail,
      checks
    })
    return missing ? 3 : 2
  }
  await refreshRecorderPendingHealth(enablement.dataRoot)
  const [health, store, staleOpenTurns, recordingVersion, hookScript, discovery, activation] = await Promise.all([
    readHealth(enablement.dataRoot),
    verifyStore(enablement.dataRoot),
    recorderStaleOpenTurns(enablement.dataRoot, OPEN_TURN_EXPIRY_MS),
    lastRecordVersion(enablement.dataRoot),
    providerHookScriptState(enablement.workspaceRoot),
    discoverRepositories(enablement.workspaceRoot, enablement.config, true),
    resolveCommitHookActivation(enablement.workspaceRoot, enablement.config)
  ])
  let delivery: Awaited<ReturnType<typeof commitNotificationStatus>> | undefined
  let deliveryError = activation.status === 'bundle-invalid' ? activation.detail : undefined
  if (activation.status === 'trusted' || activation.status === 'host-provided') {
    try { delivery = await commitNotificationStatus(enablement.dataRoot, commitHookEnv(activation, process.env)) } catch (error) {
      // A lost delivery outcome is recoverable on request, so name the blocked sequence and the
      // exact command instead of a generic "unavailable".
      deliveryError = error instanceof UnresolvedDeliveryPrefixError
        ? `sequence ${error.sequence} has a record file but no delivery outcome, so the ACK cannot advance; run \`scry recorder notify-retry --sequence ${error.sequence}\` to re-deliver it (the receiver dedupes by recordId)`
        : 'commit notification state unavailable; inspect notifications/commit-hooks, notifications/delivery-outcomes and notifications/dead-letters'
    }
  }
  const deadCount = delivery?.deadLetterCount ?? 0
  const failure = delivery?.failure
  const retry = delivery?.retries?.[0] ?? failure
  const retryDetail = retry ? `retrying sequence ${retry.sequence}: ${retry.attempts} failed attempts${retry.reason ? ` (${retry.reason})` : ''}; next retry ${retry.nextRetryAt ?? 'quarantine recovery pending'}` : undefined
  const absent = delivery?.absentCount ? `; ${delivery.absentCount} absent sequence(s) acknowledged with no record file: ` +
    delivery.absentRanges!.map(([from, to]) => from === to ? `${from}` : `${from}-${to}`).join(', ') +
    (delivery.absentTruncated ? ' (range sample truncated)' : '') : ''
  const deliveryCheck: Check = {
    id: 'commitHook.delivery',
    status: deliveryError || deadCount > 0 ? 'fail' : retry ? 'warn' : 'pass',
    detail: deliveryError ?? (deadCount > 0
      ? `${deadCount} recorder dead letter(s); latest ${delivery!.deadLetters!.length}: ` +
        delivery!.deadLetters!.map(item => `sequence ${item.sequence}: ${item.attempts} failed attempts (${item.reason})`).join('; ') +
        (retryDetail ? `; ${retryDetail}` : '')
      : retryDetail ? retryDetail
      : delivery ? `${delivery.notifyBacklog} notification(s) pending; no recorded delivery failure${absent}` : 'commit hook not configured'),
    ...(deliveryError || deadCount > 0 || retry ? {
      remediation: 'inspect the callback and sequence diagnostics; repair the cause before `scry recorder notify-retry --sequence N` or `--all-dead`; dead letters are not ACKs'
    } : {})
  }
  // The issued watermark proves which sequence numbers were handed out; the live store cannot. A
  // difference means record files were deleted (or moved) without `scry turns archive`.
  let issuedWatermark: number | null = null
  let sequenceError: string | undefined
  try {
    issuedWatermark = (await readSequenceWatermark(enablement.dataRoot))?.lastIssued ?? null
  } catch (error) {
    sequenceError = error instanceof Error ? error.message : String(error)
  }
  const acknowledged = Number.isSafeInteger(delivery?.ackedThrough) ? delivery?.ackedThrough ?? 0 : 0
  const issuedSequence = Math.max(issuedWatermark ?? 0, acknowledged)
  const recordsDeletedOutsideArchive = !sequenceError && issuedSequence > Math.max(store.maxSequence, store.archivedThrough)
  // Stale open turns need investigation, not a fabricated interruption. Warn separately from
  // pendingCount (managed/closing/quarantined); elapsed time does not prove the Provider stopped.
  const degraded = !!health.lastError || health.pendingCount > 0 || staleOpenTurns.length > 0 || hookSkips.recentCount > 0 ||
    !!deliveryError || !!retry || deadCount > 0 || !!sequenceError || recordsDeletedOutsideArchive
  const checks: Check[] = [
    { id: 'recorder.enabled', status: 'pass', detail: 'workspace has a valid recorder config' },
    {
      id: 'repositories.depth',
      status: discovery.nextDepth?.repositories.length ? 'warn' : 'pass',
      detail: enablement.config.repositories.mode === 'workspace-only'
        ? `${discovery.repositories.length} workspace-root repository; nested discovery not requested`
        : `${discovery.repositories.length} repositories discovered now; ${discovery.depthLimitedDirectories} directories not traversed at maxDepth=${discovery.maxDepth}; ` +
          `repositories observed one level deeper: ${discovery.nextDepth?.repositories.map(path => relative(enablement.workspaceRoot, path)).join(', ') || 'none observed'}` +
          (discovery.nextDepth?.incomplete ? '; next-level probe incomplete (bounded to 32 directories / 128 entries, or unreadable)' : ''),
      ...(discovery.nextDepth?.repositories.length ? { remediation: 'review repositories.maxDepth or add intentional exclusions to repositories.exclude; this probe does not expand capture scope' } : {})
    },
    {
      id: 'hook.skips', status: hookSkips.recentCount > 0 ? 'fail' : hookSkips.count > 0 ? 'warn' : 'pass',
      detail: `${hookSkips.recentCount} hook failure(s) within 24h or with unknown time; ${hookSkips.count} in retained log window; latest ${hookSkips.lastAt ?? 'unavailable'}`,
      ...(hookSkips.count > 0 ? { remediation: 'inspect .scry/logs/hook-skip.log and repair the CLI/Node paths with `scry integrations repair --yes`' } : {})
    },
    userHookCheck,
    deliveryCheck,
    {
      id: 'store.integrity',
      status: store.ok ? 'pass' : 'fail',
      detail: store.ok ? `${store.records} records, sequence contiguous` : store.errors.join('; '),
      ...(store.ok ? {} : { remediation: 'do not delete individual record files; run `scry turns verify` for detail' })
    },
    {
      // Deleting the newest record leaves no gap for `store.integrity` (contiguity is only checked
      // between the archive floor and the live maximum). Only the issued watermark can prove that a
      // record is missing, so this warns instead of reporting healthy.
      id: 'records.sequence',
      status: sequenceError ? 'fail' : recordsDeletedOutsideArchive ? 'warn' : 'pass',
      detail: sequenceError ?? (recordsDeletedOutsideArchive
        ? `issued sequence ${issuedSequence} is above live records (max ${store.maxSequence}) and archivedThrough ${store.archivedThrough}: records were deleted outside \`scry turns archive\`, or a commit was interrupted after reserving its number`
        : `issued through sequence ${issuedSequence}; live records reach ${store.maxSequence}`),
      ...(sequenceError
        ? { remediation: 'inspect .scry/sequence-watermark.json; never hand-edit or delete it — sequence allocation and delivery ordering depend on it' }
        : recordsDeletedOutsideArchive
          ? { remediation: 'restore the deleted record files from a backup or `scry turns export` and re-run doctor; new turns keep allocating above the issued sequence, but deleted turns are never redelivered, and `scry turns archive` is the only supported way to move records out. A reserved-only number can also come from an interrupted commit that wrote no record — confirm with `scry turns list` before assuming data loss' }
          : {})
    },
    {
      id: 'turns.pending',
      status: health.pendingCount > 0 ? 'warn' : 'pass',
      detail: `${health.pendingCount} pending item(s): turns or queued hooks`,
      ...(health.pendingCount > 0 ? { remediation: 'run `scry recorder recover`; for exhausted or unreadable inbox-failed sidecars see scry-turn-recorder README: Retry quarantined hooks' } : {})
    },
    {
      // Upgrading the CLI leaves this file alone, so an old script keeps running silently. It still
      // records correctly, only without the newer fast path, so this warns without degrading.
      id: 'hook.script',
      status: hookScript === 'outdated' ? 'warn' : 'pass',
      detail: {
        current: 'managed hook script matches this CLI',
        outdated: 'managed hook script was written by an older CLI',
        unmanaged: 'hook script is not managed by Scry; leaving it untouched',
        absent: 'no managed hook script in this workspace'
      }[hookScript],
      ...(hookScript === 'outdated' ? { remediation: 'run `scry integrations repair --yes`' } : {})
    },
    {
      id: 'turns.stale',
      status: staleOpenTurns.length > 0 ? 'warn' : 'pass',
      detail: staleOpenTurns.length > 0
        ? `${staleOpenTurns.length} open turn(s) without recent activity; termination unconfirmed; oldest ${Math.round(Math.max(...staleOpenTurns.map((turn) => turn.ageMs)) / 3_600_000)}h`
        : 'no stale open turn',
      ...(staleOpenTurns.length > 0
        ? { remediation: 'inspect the Provider session/process; `scry recorder recover` only finalizes turns with terminal evidence, never from silence alone' }
        : {})
    },
    {
      // Warn only: right after an upgrade this is expected until the next turn is recorded, so it
      // must not flip the exit code. It exists to catch the case where the hook keeps using an
      // older install that a shell-level `scry upgrade` never touched.
      id: 'recorder.version',
      status: recordingVersion && recordingVersion !== RECORDER_VERSION ? 'warn' : 'pass',
      detail: recordingVersion == null
        ? 'no record yet'
        : recordingVersion === RECORDER_VERSION
          ? `records written by ${recordingVersion}`
          : `newest record written by ${recordingVersion}, this CLI is ${RECORDER_VERSION}`,
      ...(recordingVersion && recordingVersion !== RECORDER_VERSION
        ? { remediation: 'hook 与你升级的可能不是同一份安装：检查 SCRY_CLI_PATH 与 .scry/cli-path 指向的 CLI' }
        : {})
    },
    {
      id: 'recorder.lastError',
      status: health.lastError ? 'warn' : 'pass',
      detail: health.lastError ? `${health.lastError.at}: ${health.lastError.message}` : 'no recorded error',
      ...(health.lastError ? { remediation: 'inspect .scry/logs/recorder.log' } : {})
    }
  ]
  print({
    schemaVersion: 1,
    // An unreadable delivery/activation state is an error: the recorder cannot tell whether
    // records were handed over, so this must never read as merely degraded or healthy.
    status: !store.ok ? 'corrupt' : hookSkips.recentCount > 0 || !!deliveryError ? 'error' : degraded ? 'degraded' : 'healthy',
    hookSkips,
    userHookSkips,
    healthy: store.ok && !degraded,
    enabled: true,
    ...runtime,
    workspace: enablement.workspaceRoot,
    dataRoot: enablement.dataRoot,
    checks,
    /** Resolved capture settings, including defaults the config file may omit. Turning off
     *  prompt/assistant/toolOutput does not remove tool inputs, file paths or diff patches. */
    capture: enablement.config.capture,
    hookScript,
    commitNotifications: delivery,
    recorderVersions: { thisCli: RECORDER_VERSION, lastRecord: recordingVersion },
    health,
    store,
    staleOpenTurns: staleOpenTurns.map((turn) => ({
      provider: turn.provider,
      sessionId: turn.sessionId,
      startedAt: turn.startedAt,
      ageMs: turn.ageMs
    }))
  })
  if (!store.ok) return 4
  return degraded ? 5 : 0
}
