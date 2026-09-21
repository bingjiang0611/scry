#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderId } from '../shared/provider.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'
import { recorderDaemonStatus, sendRecorderDaemonHook, serveRecorderDaemon, startRecorderDaemon, stopRecorderDaemon } from '../core/turn-recorder/daemon.js'
import {
  handleRecorderHook,
  OPEN_TURN_EXPIRY_MS,
  recoverRecorder,
  recorderEnablement,
  refreshRecorderPendingHealth
} from '../core/turn-recorder/recorder.js'
import { recorderStaleOpenTurns } from '../core/turn-recorder/runtime-state.js'
import { RECORDER_VERSION, archiveRecords, commitNotificationStatus, drainCommitNotifications, exportRecordBundle, exportRecords, lastRecordVersion, listRecords, readArchiveState, readHealth, recordContentItem, recordError, showRecord, verifyStore } from '../core/turn-recorder/store.js'
import { readRecorderContentPage } from '../core/turn-recorder/content-store.js'
import { maintainRecorderStore } from '../core/turn-recorder/maintenance.js'
import {
  commitHookEnv,
  inspectCommitHookBundle,
  resolveCommitHookActivation,
  revokeCommitHookGrant,
  writeCommitHookGrant
} from '../core/turn-recorder/commit-hook-grant.js'
import { compactModelTiming, summarizeTurnRecords, turnTimeline } from '../core/turn-recorder/turns-summary.js'
import { installPiIntegration, piIntegrationStatus } from './pi-integration.js'
import { workspaceStatus } from './status.js'
import { collectSupportBundle } from './support-bundle.js'
import { initWorkspace, integrationsDiff, integrationsRepair, integrationsUninstall, providerHookScriptState } from './workspace-init.js'
import {
  consumeUpdateNotice,
  runBackgroundUpdate,
  runIdleAutoUpdate,
  scheduleBackgroundUpdate,
  shouldScheduleAutoUpdate,
  upgradeCli
} from './update.js'

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

const VALUE_FLAGS = new Set(['workspace', 'providers', 'provider', 'event', 'socket', 'after', 'limit', 'offset', 'snapshot', 'before', 'out'])
const BOOLEAN_FLAGS = new Set(['all', 'apply', 'check', 'help', 'json', 'managed', 'no-update-check', 'force', 'quiet', 'start-daemon', 'stdin', 'verbose', 'version', 'yes'])

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '-h') {
      flags.set('help', true)
      continue
    }
    if (value.startsWith('-') && !value.startsWith('--')) throw new Error(`unknown option: ${value}`)
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const equals = value.indexOf('=')
    const key = value.slice(2, equals > 2 ? equals : undefined)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equals > 2) throw new Error(`--${key} does not accept a value`)
      flags.set(key, true)
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown option: --${key}`)
    const next = equals > 2 ? value.slice(equals + 1) : argv[index + 1]
    if (!next || (equals < 0 && next.startsWith('--'))) throw new Error(`missing value for --${key}`)
    flags.set(key, next)
    if (equals < 0) index++
  }
  return { positionals, flags }
}

function flag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key)
  return typeof value === 'string' ? value : undefined
}

function intFlag(args: ParsedArgs, key: string): number | undefined {
  const value = flag(args, key)
  if (value == null) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`--${key} must be a non-negative integer`)
  return number
}

function workspaceOf(args: ParsedArgs): string {
  const workspace = resolve(flag(args, 'workspace') ?? process.cwd())
  try {
    return realpathSync(workspace)
  } catch {
    return workspace
  }
}

function providerOf(args: ParsedArgs): ProviderId {
  const value = flag(args, 'provider')
  if (!value || !['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(value)) throw new Error('--provider must be claude|codex|qoder|opencode|pi')
  return value as ProviderId
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function helpText(): string {
  return `Scry CLI\n\nUsage:\n  scry init [--providers claude,codex,qoder,opencode]\n  scry status [--workspace <root>]\n  scry commit-hook status|trust|revoke [--yes]\n  scry records archive --before <30d|ISO> [--out <dir>] [--yes]
  scry records maintain [--apply]\n  scry recorder hook|recover|notify-drain|start|serve|status|stop|restart [options]\n  scry turns list|show|timeline|summary|export|content|verify [options]\n  scry doctor [--workspace <root>]\n  scry support-bundle create [--out <path>]\n  scry integrations install-pi|status-pi|diff|repair|uninstall [--yes]\n  scry upgrade [--check]\n  scry version\n\nOptions:\n  --workspace <root>   Workspace root (also accepts --workspace=<root>)\n  --providers <list>   Providers configured by init; otherwise auto-detected\n  --help, -h           Show help\n  --version            Show version\n`
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

async function dataRootOf(workspace: string): Promise<string> {
  const location = await resolveRecorderLocation(workspace)
  if (!location.valid) throw new Error(`recorder storage unavailable: ${location.reason}${location.detail ? ` (${location.detail})` : ''}`)
  return location.dataRoot
}

async function hookCommand(args: ParsedArgs): Promise<number> {
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
    if (daemonEnabled) {
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
      managed
    })
    if (daemonEnabled && result.status !== 'disabled') {
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

async function initCommand(args: ParsedArgs): Promise<number> {
  const scriptPath = process.argv[1]
  if (!scriptPath) throw new Error('cannot locate scry CLI entrypoint')
  const result = await initWorkspace({
    workspace: workspaceOf(args),
    providers: flag(args, 'providers'),
    cliPath: scriptPath
  })
  const enablement = await recorderEnablement(result.workspace)
  if (!enablement.enabled) throw new Error(`recorder 初始化后仍不可用：${enablement.reason}${enablement.detail ? ` (${enablement.detail})` : ''}`)
  await refreshRecorderPendingHealth(enablement.dataRoot)
  const [health, store] = await Promise.all([readHealth(enablement.dataRoot), verifyStore(enablement.dataRoot)])
  const healthy = store.ok && !health.lastError && health.pendingCount === 0
  if (args.flags.has('json')) {
    print({ ...result, doctor: { healthy, health, store } })
    return store.ok ? 0 : 4
  }
  process.stdout.write(`Scry 已初始化：${result.workspace}\n`)
  process.stdout.write(`已配置 Provider：${result.providers.join('、')}\n`)
  process.stdout.write(`本次写入 ${result.changedFiles.length} 个文件，保留 ${result.unchangedFiles.length} 个未变化文件。\n`)
  for (const path of result.changedFiles) process.stdout.write(`  - ${relative(result.workspace, path) || path}\n`)
  if (!healthy) process.stdout.write('提醒：已有 pending 或错误记录；初始化已完成，请再运行 scry doctor 查看详情。\n')
  process.stdout.write('当前只确认配置和本地存储可用；Provider 是否真正加载 Hook，要在重启后执行一轮任务验证。\n')
  if (result.codexTrustRequired) process.stdout.write('Codex：重启后在这个项目中执行 /hooks，并信任项目 Hook。\n')
  process.stdout.write(`验证命令：scry turns list --workspace "${result.workspace}"\n`)
  return store.ok ? 0 : 4
}

/**
 * Six-stage provider matrix. Exit codes: 0 capturing or nothing to report, 2 recorder not
 * enabled for this workspace, 3 configured providers exist but no hook event has ever
 * arrived (or events arrived without a committed record).
 */
async function statusCommand(args: ParsedArgs): Promise<number> {
  const report = await workspaceStatus(workspaceOf(args))
  print(report)
  if (!report.recorder.enabled) return 2
  const configured = report.providers.filter((row) => row.configured !== 'no')
  if (configured.length === 0) return 2
  return configured.some((row) => row.state === 'capturing') ? 0 : 3
}

/**
 * Exit codes: 0 ok (trusted, host-provided, or nothing configured), 2 storage/config
 * unavailable, 5 bundle invalid. Valid repository commit hooks are auto-authorized after
 * fingerprint validation; `--yes` remains accepted for backward-compatible scripts.
 */
async function commitHookCommand(args: ParsedArgs): Promise<number> {
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

function cutoffFrom(value: string): string {
  const relative = /^(\d+)d$/.exec(value.trim())
  if (relative) return new Date(Date.now() - Number(relative[1]) * 86_400_000).toISOString()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('--before must be an ISO timestamp or <N>d')
  return new Date(parsed).toISOString()
}

/**
 * Archive a contiguous prefix of records. Refuses to archive anything the configured commit hook
 * has not acknowledged, because moving an undelivered record would silently drop it. Exit codes:
 * 0 done, 2 recorder unavailable, 3 approval required or nothing to archive, 5 refused.
 */
/** Report the capture settings actually in force, including defaults the config omits. */
/**
 * Sanitised diagnostics for a maintainer. Writes to --out when given, otherwise stdout; the
 * payload lists what it deliberately omits so a recipient can see the boundary.
 */
async function supportBundleCommand(args: ParsedArgs): Promise<number> {
  if (args.positionals[1] !== 'create') throw new Error('usage: scry support-bundle create [--out <path>]')
  const workspace = workspaceOf(args)
  const bundle = await collectSupportBundle(workspace)
  const out = flag(args, 'out')
  if (!out) {
    print(bundle)
    return bundle.recorder.enabled ? 0 : 2
  }
  const target = resolve(out)
  await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 })
  print({ action: 'support-bundle', status: 'written', path: target, omitted: bundle.omitted })
  return bundle.recorder.enabled ? 0 : 2
}

async function recordsCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  if (action !== 'archive' && action !== 'maintain') {
    throw new Error('usage: scry records archive --before <30d|ISO> [--out <dir>] [--yes] | scry records maintain [--apply]')
  }
  const workspace = workspaceOf(args)
  const enablement = await recorderEnablement(workspace)
  if (!enablement.enabled) {
    print({ action: 'archive', workspace, status: 'unavailable', reason: enablement.reason })
    return 2
  }
  if (action === 'maintain') {
    const report = await maintainRecorderStore(enablement.dataRoot, enablement.config, { apply: args.flags.has('apply') })
    print({ action: 'maintain', workspace, status: report.blockedBy.length ? 'blocked' : report.applied ? 'applied' : 'planned', ...report })
    return report.blockedBy.length ? 5 : report.overQuotaBytes > 0 || report.retentionEligible.length > 0 ? 3 : 0
  }
  const before = flag(args, 'before')
  if (!before) throw new Error('--before is required, e.g. --before 30d')
  const cutoff = cutoffFrom(before)
  const records = await listRecords(enablement.dataRoot)
  // Only a contiguous prefix may go: an interior hole cannot be explained by an archive floor.
  const candidates: typeof records = []
  for (const record of records) {
    if (record.completedAt >= cutoff) break
    candidates.push(record)
  }
  const activation = await resolveCommitHookActivation(workspace, enablement.config)
  const notifications = await commitNotificationStatus(enablement.dataRoot, commitHookEnv(activation, process.env))
  const activated = activation.status === 'trusted' || activation.status === 'host-provided'
  const throughSequence = candidates.at(-1)?.sequence ?? 0
  if (candidates.length === 0) {
    print({ action: 'archive', workspace, status: 'nothing-to-archive', cutoff, records: records.length })
    return 3
  }
  if (activation.status !== 'not-configured' && !args.flags.has('force')) {
    const acked = activated ? notifications.ackedThrough ?? 0 : 0
    if (throughSequence > acked) {
      print({
        action: 'archive',
        workspace,
        status: 'refused',
        reason: 'undelivered-records',
        detail: `commit hook has acknowledged through ${activated ? acked : 'nothing (hook not activated)'}, but archiving would move sequence ${throughSequence}`,
        remediation: 'run `scry recorder notify-drain`, or pass --force to archive undelivered records anyway',
        cutoff
      })
      return 5
    }
  }
  const target = flag(args, 'out') ?? join(enablement.dataRoot, 'archive', `${cutoff.replace(/[:.]/g, '-')}`)
  if (!args.flags.has('yes')) {
    print({
      action: 'archive',
      workspace,
      status: 'approval-required',
      cutoff,
      target,
      willArchive: { from: candidates[0].sequence, to: throughSequence, count: candidates.length },
      willRetain: records.length - candidates.length,
      note: 'records are moved, not deleted; the archive floor keeps `turns verify` and `doctor` honest',
      next: 're-run with --yes'
    })
    return 3
  }
  const result = await archiveRecords(enablement.dataRoot, { throughSequence, target })
  const store = await verifyStore(enablement.dataRoot)
  print({
    action: 'archive',
    workspace,
    status: 'done',
    cutoff,
    target: result.target,
    archived: result.archived.length,
    archivedThrough: result.archivedThrough,
    remaining: store.records,
    storeOk: store.ok,
    archiveState: await readArchiveState(enablement.dataRoot)
  })
  return 0
}

async function recorderCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  if (action === 'hook') return hookCommand(args)
  if (action === 'recover') {
    print(await recoverRecorder(workspaceOf(args)))
    return 0
  }
  if (action === 'notify-drain') {
    // Unbounded on purpose: the hook path drains within a budget, this flushes the rest.
    const workspace = workspaceOf(args)
    const enablement = await recorderEnablement(workspace)
    if (!enablement.enabled) {
      print({ action: 'notify-drain', workspace, status: 'disabled', reason: enablement.reason })
      return 2
    }
    const activation = await resolveCommitHookActivation(workspace, enablement.config)
    if (activation.status !== 'trusted' && activation.status !== 'host-provided') {
      print({ action: 'notify-drain', workspace, status: 'not-activated', activation })
      return activation.status === 'not-configured' ? 0 : 3
    }
    const result = await drainCommitNotifications(
      enablement.dataRoot,
      commitHookEnv(activation, process.env)
    )
    print({ action: 'notify-drain', workspace, activation: activation.status, ...result })
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
    print(await recorderDaemonStatus(workspaceOf(args)))
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
  throw new Error('usage: scry recorder hook|recover|start|serve|status|stop|restart ...')
}

async function turnsCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  const dataRoot = await dataRootOf(workspaceOf(args))
  if (action === 'list') {
    const records = await listRecords(dataRoot)
    print(records.map((record) => ({
      sequence: record.sequence,
      recordId: record.recordId,
      provider: record.provider.id,
      sessionId: record.sessionId,
      turnIndex: record.turnIndex,
      status: record.status,
      durationMs: record.durationMs,
      endReason: record.termination?.value?.reason ?? null,
      completedAtSource: record.termination?.value?.completedAtSource ?? null,
      compactions: record.compactions?.value?.length ?? null,
      modelTiming: compactModelTiming(record),
      startedAt: record.startedAt,
      completedAt: record.completedAt
    })))
    return 0
  }
  if (action === 'show') {
    const selector = args.positionals[2]
    if (!selector) throw new Error('usage: scry turns show <sequence|recordId> --workspace <root>')
    const record = await showRecord(dataRoot, selector)
    if (!record) {
      print({ found: false, selector })
      return 1
    }
    print(record)
    return 0
  }
  if (action === 'timeline') {
    const selector = args.positionals[2]
    if (!selector) throw new Error('usage: scry turns timeline <sequence|recordId> --workspace <root>')
    const record = await showRecord(dataRoot, selector)
    if (!record) {
      print({ found: false, selector })
      return 1
    }
    print(turnTimeline(record))
    return 0
  }
  if (action === 'summary') {
    if (args.positionals[2] && args.flags.has('all')) {
      throw new Error('scry turns summary accepts either <sessionId> or --all, not both')
    }
    const records = await listRecords(dataRoot)
    const sessionId = args.positionals[2] ?? (args.flags.has('all') ? undefined : records.at(-1)?.sessionId)
    print(summarizeTurnRecords(records, sessionId, args.flags.has('all') ? { scope: 'workspace' } : {}))
    return 0
  }
  if (action === 'export') {
    print(await exportRecords(dataRoot, {
      after: intFlag(args, 'after'),
      limit: intFlag(args, 'limit'),
      snapshotMaxSequence: intFlag(args, 'snapshot')
    }))
    return 0
  }
  if (action === 'export-bundle') {
    const target = args.positionals[2]
    if (!target) throw new Error('usage: scry turns export-bundle <directory> --workspace <root>')
    print(await exportRecordBundle(dataRoot, target))
    return 0
  }
  if (action === 'content') {
    const [selector, ...contentPath] = args.positionals.slice(2)
    if (!selector || contentPath.length === 0) {
      throw new Error('usage: scry turns content <sequence|recordId> <content-path...> [--offset <bytes>] [--limit <bytes>]')
    }
    const legacy = ['tools', 'skills', 'mcps'].includes(contentPath[0] ?? '') && /^\d+$/.test(contentPath[1] ?? '') && ['input', 'output'].includes(contentPath[2] ?? '')
    const path = legacy
      ? `${contentPath[0]}.${Number(contentPath[1])}.${contentPath[2]}`
      : contentPath.join('.')
    const record = await showRecord(dataRoot, selector)
    const item = record ? recordContentItem(record, path) : undefined
    if (!record || !item) {
      print({ found: false, selector, path })
      return 1
    }
    const page = await readRecorderContentPage(dataRoot, item.ref, {
      offset: intFlag(args, 'offset'),
      limit: intFlag(args, 'limit')
    })
    print({
      found: true,
      selector,
      path,
      ref: item.ref,
      ...page
    })
    return 0
  }
  if (action === 'verify') {
    const result = await verifyStore(dataRoot)
    // Integrity (sequence/dedup/readability) alone decides `ok` and the exit code — that contract
    // is frozen for team CI. Identity coverage and unsettled open turns are advisory: `turns verify`
    // used to answer only "are the record files internally consistent?", which stays silent about
    // records that are intact yet carry unobserved model/role/task identity, and about a turn that
    // was interrupted before it sealed. Those are surfaced without changing the pass/fail contract.
    const [records, health] = await Promise.all([
      listRecords(dataRoot).catch(() => []),
      readHealth(dataRoot).catch(() => null)
    ])
    const identity = records.length > 0
      ? summarizeTurnRecords(records, undefined, { scope: 'workspace' }).identity
      : null
    const advisories: string[] = []
    if (identity) {
      if (!identity.model.coverage.complete) advisories.push(`model identity incomplete: ${JSON.stringify(identity.model.statusCounts)}`)
      if (!identity.role.coverage.complete) advisories.push(`turn role incomplete: ${JSON.stringify(identity.role.statusCounts)}`)
      if (!identity.taskLink.coverage.complete) advisories.push(`task link incomplete: ${JSON.stringify(identity.taskLink.statusCounts)}`)
    }
    if (health && health.pendingCount > 0) advisories.push(`open turns pending recovery: ${health.pendingCount}`)
    print({ ...result, openTurnsPending: health?.pendingCount ?? null, identity, advisories })
    return result.ok ? 0 : 4
  }
  throw new Error('usage: scry turns list|show|timeline|summary [sessionId|--all]|export|export-bundle|content|verify ...')
}

/**
 * Stable schema for team CI: `schemaVersion`, `status`, `checks[]`, `runtime`, `evidence`.
 * Exit codes are a frozen contract: 0 healthy, 2 recorder disabled, 3 config missing/invalid,
 * 4 store corrupt, 5 degraded (pending turns or a recorded error).
 */
async function doctorCommand(args: ParsedArgs): Promise<number> {
  const workspace = workspaceOf(args)
  const enablement = await recorderEnablement(workspace)
  const runtime = {
    recorderVersion: RECORDER_VERSION,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`
  }
  type Check = { id: string; status: 'pass' | 'fail' | 'warn'; detail: string; remediation?: string }
  if (!enablement.enabled) {
    const missing = enablement.reason === 'invalid_config' || enablement.reason === 'missing_config'
    const checks: Check[] = [{
      id: 'recorder.enabled',
      status: 'fail',
      detail: enablement.detail ? `${enablement.reason}: ${enablement.detail}` : enablement.reason,
      remediation: missing ? 'run `scry init` in the Git repository root' : 'remove `.scry-disabled` or set SCRY_RECORDER_ENABLED=1'
    }]
    print({
      schemaVersion: 1,
      status: 'unavailable',
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
  const [health, store, staleOpenTurns, recordingVersion, hookScript] = await Promise.all([
    readHealth(enablement.dataRoot),
    verifyStore(enablement.dataRoot),
    recorderStaleOpenTurns(enablement.dataRoot, OPEN_TURN_EXPIRY_MS),
    lastRecordVersion(enablement.dataRoot),
    providerHookScriptState(enablement.workspaceRoot)
  ])
  // Stale open turns need investigation, not a fabricated interruption. Warn separately from
  // pendingCount (managed/closing/quarantined); elapsed time does not prove the Provider stopped.
  const degraded = !!health.lastError || health.pendingCount > 0 || staleOpenTurns.length > 0
  const checks: Check[] = [
    { id: 'recorder.enabled', status: 'pass', detail: 'workspace has a valid recorder config' },
    {
      id: 'store.integrity',
      status: store.ok ? 'pass' : 'fail',
      detail: store.ok ? `${store.records} records, sequence contiguous` : store.errors.join('; '),
      ...(store.ok ? {} : { remediation: 'do not delete individual record files; run `scry turns verify` for detail' })
    },
    {
      id: 'turns.pending',
      status: health.pendingCount > 0 ? 'warn' : 'pass',
      detail: `${health.pendingCount} turn(s) awaiting recovery`,
      ...(health.pendingCount > 0 ? { remediation: 'run `scry recorder recover`' } : {})
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
    status: !store.ok ? 'corrupt' : degraded ? 'degraded' : 'healthy',
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

async function integrationsCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  if (action === 'install-pi') {
    print(await installPiIntegration())
    return 0
  }
  if (action === 'status-pi') {
    const status = await piIntegrationStatus()
    print(status)
    return status.installed ? 0 : 1
  }
  if (action === 'diff') {
    const workspace = workspaceOf(args)
    const result = await integrationsDiff(workspace)
    print(result)
    const drift = result.providers.some((row) => row.duplicateEvents.length > 0 || (row.present && row.managedEvents.length > 0 && row.missingEvents.length > 0))
    return drift ? 3 : 0
  }
  if (action === 'repair') {
    const workspace = workspaceOf(args)
    if (!args.flags.has('yes')) {
      print({ action: 'repair', status: 'approval-required', ...await integrationsDiff(workspace), next: 're-run with --yes' })
      return 3
    }
    const scriptPath = process.argv[1]
    if (!scriptPath) throw new Error('cannot locate scry CLI entrypoint')
    const result = await integrationsRepair({ workspace, cliPath: scriptPath })
    print({ action: 'repair', status: result.providers.length === 0 ? 'nothing-installed' : 'done', ...result })
    return result.providers.length === 0 ? 3 : 0
  }
  if (action === 'uninstall') {
    const workspace = workspaceOf(args)
    if (!args.flags.has('yes')) {
      const plan = await integrationsDiff(workspace)
      print({
        action: 'uninstall',
        status: 'approval-required',
        ...plan,
        willRemove: 'managed hook entries, .opencode plugin (if managed), .scry/provider-hook.sh, .scry/cli-path, .scry/node-bin-dir',
        willRetain: 'scry.config.json, .scry/records, Git exclude entry, Pi user-global extension',
        next: 're-run with --yes'
      })
      return 3
    }
    print({ action: 'uninstall', status: 'done', ...await integrationsUninstall(workspace) })
    return 0
  }
  throw new Error('usage: scry integrations install-pi|status-pi|diff|repair|uninstall [--yes]')
}

async function upgradeCommand(args: ParsedArgs): Promise<number> {
  if (process.env.SCRY_CLI_BUNDLED === '1') {
    print({
      status: 'managed_by_app',
      currentVersion: RECORDER_VERSION,
      message: 'Scry App 内置 CLI 随 App 一起升级'
    })
    return 0
  }
  const result = await upgradeCli({
    currentVersion: RECORDER_VERSION,
    entryPath: process.argv[1],
    checkOnly: args.flags.has('check'),
    allowBreaking: !args.flags.has('check')
  })
  print(result)
  return result.status === 'error' ? 1 : 0
}

export async function runScryCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.flags.has('version') || args.positionals[0] === 'version') {
    process.stdout.write(`${RECORDER_VERSION}\n`)
    return 0
  }
  if (args.flags.has('help') || args.positionals[0] === 'help' || args.positionals.length === 0) {
    process.stdout.write(helpText())
    return 0
  }
  switch (args.positionals[0]) {
    case '__auto_update':
      {
        const result = await runBackgroundUpdate(
          process.env.SCRY_UPDATE_CURRENT_VERSION ?? RECORDER_VERSION,
          process.argv[1]
        )
        if (result?.status === 'updated' && result.latestVersion) {
          process.stderr.write(`Scry CLI 已自动更新：${result.currentVersion} → ${result.latestVersion}\n`)
        }
        return 0
      }
    case 'init': return initCommand(args)
    case 'status': return statusCommand(args)
    case 'commit-hook': return commitHookCommand(args)
    case 'records': return recordsCommand(args)
    case 'support-bundle': return supportBundleCommand(args)
    case 'recorder': return recorderCommand(args)
    case 'turns': return turnsCommand(args)
    case 'doctor': return doctorCommand(args)
    case 'integrations': return integrationsCommand(args)
    case 'upgrade': return upgradeCommand(args)
    default:
      throw new Error('usage: scry init|status|commit-hook|records|support-bundle|recorder|turns|doctor|integrations|upgrade ...')
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsedCliArgs: ParsedArgs
  try {
    parsedCliArgs = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`scry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  const autoUpdateEligible = shouldScheduleAutoUpdate({
    command: parsedCliArgs.positionals[0],
    action: parsedCliArgs.positionals[1],
    noUpdateCheck: parsedCliArgs.flags.has('no-update-check'),
    stderrIsTTY: process.stderr.isTTY === true
  })
  try {
    if (autoUpdateEligible) {
      const notice = await consumeUpdateNotice()
      if (notice) process.stderr.write(`${notice}\n`)
    }
    process.exitCode = await runScryCli(argv)
  } catch (error) {
    process.stderr.write(`scry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    if (autoUpdateEligible) await scheduleBackgroundUpdate(RECORDER_VERSION, process.argv[1])
  }
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {}
if (isMain) await main()
