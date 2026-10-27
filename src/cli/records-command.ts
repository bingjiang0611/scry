import { join } from 'node:path'
import { type ParsedArgs, workspaceOf, print, flag, dataRootOf, intFlag } from './command-args.js'
import { recorderEnablement } from '../core/turn-recorder/recorder.js'
import { maintainRecorderStore } from '../core/turn-recorder/maintenance.js'
import { listRecords, commitNotificationStatus, archiveRecords, verifyStore, readArchiveState, showRecord, exportRecords, exportRecordBundle, recordContentItem, readHealth } from '../core/turn-recorder/store.js'
import { resolveCommitHookActivation, commitHookEnv } from '../core/turn-recorder/commit-hook-grant.js'
import { compactModelTiming, turnTimeline, summarizeTurnRecords, summarizeIdentity } from '../core/turn-recorder/turns-summary.js'
import { readRecorderContentPage } from '../core/turn-recorder/content-store.js'


export function cutoffFrom(value: string): string {
  const relative = /^(\d+)d$/.exec(value.trim())
  if (relative) return new Date(Date.now() - Number(relative[1]) * 86_400_000).toISOString()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('--before must be an ISO timestamp or <N>d')
  return new Date(parsed).toISOString()
}

export async function recordsCommand(args: ParsedArgs): Promise<number> {
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

export async function turnsCommand(args: ParsedArgs): Promise<number> {
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
    const identities: Parameters<typeof summarizeIdentity>[0] = []
    const result = await verifyStore(dataRoot, ({ provider, turnRoleStatus, turnRole, taskLinkStatus }) => {
      identities.push({ provider, turnRoleStatus, turnRole, taskLinkStatus })
    })
    // Integrity (sequence/dedup/readability) alone decides `ok` and the exit code — that contract
    // is frozen for team CI. Identity coverage and unsettled open turns are advisory: `turns verify`
    // used to answer only "are the record files internally consistent?", which stays silent about
    // records that are intact yet carry unobserved model/role/task identity, and about a turn that
    // was interrupted before it sealed. Those are surfaced without changing the pass/fail contract.
    const health = await readHealth(dataRoot).catch(() => null)
    // A failed record read makes identity coverage unknown, not a partial success. Sequence
    // errors alone do not: readable records still carry identity evidence, as before.
    const identity = identities.length > 0 && identities.length === result.records
      ? summarizeIdentity(identities)
      : null
    const advisories: string[] = []
    if (identity) {
      if (!identity.model.coverage.complete) advisories.push(`model identity incomplete: ${JSON.stringify(identity.model.statusCounts)}`)
      if (!identity.role.coverage.complete) advisories.push(`turn role incomplete: ${JSON.stringify(identity.role.statusCounts)}`)
      if (!identity.taskLink.coverage.complete) advisories.push(`task link incomplete: ${JSON.stringify(identity.taskLink.statusCounts)}`)
    }
    if (health && health.pendingCount > 0) advisories.push(`open turns pending recovery: ${health.pendingCount}`)
    // `maxSequence` is internal allocation evidence for doctor; keep this frozen CLI shape unchanged.
    const { maxSequence: _maxSequence, ...visible } = result
    print({ ...visible, openTurnsPending: health?.pendingCount ?? null, identity, advisories })
    return result.ok ? 0 : 4
  }
  throw new Error('usage: scry turns list|show|timeline|summary [sessionId|--all]|export|export-bundle|content|verify ...')
}
