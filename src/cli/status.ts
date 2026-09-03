import { resolve } from 'node:path'
import type { ProviderId } from '../shared/provider.js'
import { resolveRecorderEnablement } from '../core/turn-recorder/config.js'
import { resolveCommitHookActivation, type CommitHookActivation } from '../core/turn-recorder/commit-hook-grant.js'
import { readProviderActivity, type ProviderActivityFile } from '../core/turn-recorder/provider-activity.js'
import {
  commitNotificationStatus,
  listRecords,
  readHealth
} from '../core/turn-recorder/store.js'
import { commitHookEnv } from '../core/turn-recorder/commit-hook-grant.js'
import { detectWorkspaceProviders, providerHookInstalled, type InitProvider } from './workspace-init.js'
import { piIntegrationStatus } from './pi-integration.js'

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'qoder', 'opencode', 'pi']

// The CLI cannot observe whether a provider trusts our hook: Codex requires an interactive
// `/hooks` approval, and the others expose no trust state at all. Reporting `n/a` would
// assert "no trust needed", so every provider reports `unknown` with a reason instead.
const TRUST_UNOBSERVABLE = 'unknown: provider does not expose hook trust state to the CLI'

export interface ProviderStatusRow {
  provider: ProviderId
  detected: 'yes' | 'no'
  /** `workspace` for project hooks, `global` for Pi's user-level extension. */
  configured: 'workspace' | 'global' | 'no'
  trusted: 'unknown'
  hookSeen: { at: string; event: string; events: number } | null
  recordSeen: { at: string; sequence: number } | null
  state: 'capturing' | 'configured-no-events' | 'events-without-record' | 'not-configured'
}

export interface CommitHookStatusSection {
  configured: boolean
  entry: string | null
  activation: CommitHookActivation['status']
  ackedThrough: number | null
  /** Null when no hook is activated: the backlog is unobservable, not empty. */
  notifyBacklog: number | null
  backlogEvidence: string
}

export interface WorkspaceStatusReport {
  schemaVersion: 1
  workspace: string
  recorder:
    | { enabled: false; reason: string; detail?: string }
    | {
        enabled: true
        dataRoot: string
        /** Open turns awaiting convergence — not the commit-hook backlog. Full health counters
         * live in `scry doctor`; duplicating them here would create a second same-meaning surface. */
        openTurnsPending: number
      }
  providers: ProviderStatusRow[]
  /** Stated once instead of per row: the CLI can never observe provider hook trust. */
  trustEvidence: string
  commitHook: CommitHookStatusSection | null
}

function stateOf(row: Omit<ProviderStatusRow, 'state'>): ProviderStatusRow['state'] {
  if (row.configured === 'no') return 'not-configured'
  if (!row.hookSeen) return 'configured-no-events'
  return row.recordSeen ? 'capturing' : 'events-without-record'
}

async function configuredOf(
  workspace: string,
  provider: ProviderId,
  env: NodeJS.ProcessEnv
): Promise<ProviderStatusRow['configured']> {
  if (provider === 'pi') {
    // Pi is a user-global lifecycle extension, never a workspace hook.
    const status = await piIntegrationStatus({ home: env.HOME }).catch(() => null)
    return status?.installed ? 'global' : 'no'
  }
  return await providerHookInstalled(workspace, provider as InitProvider).catch(() => false) ? 'workspace' : 'no'
}

export async function workspaceStatus(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<WorkspaceStatusReport> {
  const workspaceRoot = resolve(workspace)
  const enablement = await resolveRecorderEnablement(workspaceRoot, env)
  const detected = new Set<string>(await detectWorkspaceProviders(workspaceRoot, env).catch(() => []))

  const emptyActivity: ProviderActivityFile = { schemaVersion: 1, providers: {} }
  const activity = enablement.enabled
    ? await readProviderActivity(enablement.dataRoot).catch(() => emptyActivity)
    : emptyActivity
  // Records are the only proof a turn was committed. This walks the whole store, which is
  // acceptable for an operator-invoked command but must not be copied onto the hook path.
  const records = enablement.enabled ? await listRecords(enablement.dataRoot).catch(() => []) : []
  const latestRecord = new Map<string, { at: string; sequence: number }>()
  for (const record of records) {
    const previous = latestRecord.get(record.provider.id)
    if (!previous || record.sequence > previous.sequence) {
      latestRecord.set(record.provider.id, { at: record.completedAt ?? record.startedAt, sequence: record.sequence })
    }
  }

  const providers: ProviderStatusRow[] = []
  for (const provider of PROVIDERS) {
    const seen = activity.providers[provider]
    const configured = await configuredOf(workspaceRoot, provider, env)
    const base = {
      provider,
      // Pi has no project marker to probe: the installed global extension is the only signal.
      detected: (provider === 'pi' ? configured === 'global' : detected.has(provider)) ? 'yes' as const : 'no' as const,
      configured,
      trusted: 'unknown' as const,
      hookSeen: seen ? { at: seen.lastEventAt, event: seen.lastEvent, events: seen.events } : null,
      recordSeen: latestRecord.get(provider) ?? null
    }
    providers.push({ ...base, state: stateOf(base) })
  }

  if (!enablement.enabled) {
    return {
      schemaVersion: 1,
      workspace: workspaceRoot,
      recorder: { enabled: false, reason: enablement.reason, ...(enablement.detail ? { detail: enablement.detail } : {}) },
      providers,
      trustEvidence: TRUST_UNOBSERVABLE,
      commitHook: null
    }
  }

  const health = await readHealth(enablement.dataRoot)
  const activation = await resolveCommitHookActivation(workspaceRoot, enablement.config, env)
  const activated = activation.status === 'trusted' || activation.status === 'host-provided'
  const notifications = await commitNotificationStatus(enablement.dataRoot, commitHookEnv(activation, env))
  return {
    schemaVersion: 1,
    workspace: workspaceRoot,
    recorder: {
      enabled: true,
      dataRoot: enablement.dataRoot,
      openTurnsPending: health.pendingCount
    },
    providers,
    trustEvidence: TRUST_UNOBSERVABLE,
    commitHook: {
      configured: Boolean(enablement.config.commitHook),
      entry: enablement.config.commitHook?.entry ?? null,
      activation: activation.status,
      ackedThrough: activated ? notifications.ackedThrough : null,
      notifyBacklog: activated ? notifications.notifyBacklog : null,
      backlogEvidence: activated
        ? 'available'
        : 'unavailable: no activated commit hook, records are retained and never delivered'
    }
  }
}
