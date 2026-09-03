import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveRecorderEnablement, capturePolicyVersion } from '../core/turn-recorder/config.js'
import { resolveCommitHookActivation, commitHookEnv } from '../core/turn-recorder/commit-hook-grant.js'
import { readProviderActivity, type ProviderActivityFile } from '../core/turn-recorder/provider-activity.js'
import {
  RECORDER_VERSION,
  commitNotificationStatus,
  readArchiveState,
  readDrainStatus,
  readHealth,
  verifyStore
} from '../core/turn-recorder/store.js'
import { detectWorkspaceProviders, providerHookInstalled, type InitProvider } from './workspace-init.js'

/**
 * Sanitised diagnostics for maintainer support. It carries versions, detection results, config
 * fingerprints, counters and redacted log lines — never record bodies, file path lists or
 * environment values. Absolute paths are rewritten to <workspace>/<home> so a bundle can be
 * pasted into a ticket without leaking a project layout.
 */
const LOG_TAIL_LINES = 40

export interface SupportBundle {
  schemaVersion: 1
  generatedAt: string
  runtime: { recorderVersion: string; nodeVersion: string; platform: string }
  workspace: { idHash: string; configFingerprint: string | null; capturePolicy: string | null }
  recorder:
    | { enabled: false; reason: string }
    | {
        enabled: true
        health: { droppedEvents: number; orphanEvents: number; pendingCount: number; oldestPendingAgeMs: number; recoveredRecords: number; lastErrorAt: string | null; lastError: string | null }
        store: { ok: boolean; records: number; archivedThrough: number; errors: string[] }
        commitHook: { activation: string; ackedThrough: number | null; notifyBacklog: number | null; lastDrainTruncated: boolean }
        archives: number
      }
  providers: Array<{ provider: string; detected: boolean; configured: boolean; hookEvents: number; lastEventAt: string | null }>
  recorderLogTail: string[]
  omitted: string[]
}

function redactor(workspaceRoot: string): (value: string) => string {
  const home = homedir()
  return (value: string): string => value
    .split(workspaceRoot).join('<workspace>')
    .split(home).join('<home>')
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

export async function collectSupportBundle(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<SupportBundle> {
  const workspaceRoot = resolve(workspace)
  const redact = redactor(workspaceRoot)
  const enablement = await resolveRecorderEnablement(workspaceRoot, env)
  const configSource = await readFile(join(workspaceRoot, 'scry.config.json'), 'utf8').catch(() => null)
  const detected = new Set(await detectWorkspaceProviders(workspaceRoot, env).catch(() => []))

  const runtime = {
    recorderVersion: RECORDER_VERSION,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`
  }
  const omitted = [
    'record bodies (prompt, assistant, tool input/output, patches)',
    'file path lists',
    'environment variable values',
    'workspace path and workspace id (hashed only)',
    'commit hook entry contents'
  ]

  const emptyActivity: ProviderActivityFile = { schemaVersion: 1, providers: {} }
  const activity = enablement.enabled
    ? await readProviderActivity(enablement.dataRoot).catch(() => emptyActivity)
    : emptyActivity
  const providers: SupportBundle['providers'] = []
  for (const provider of ['claude', 'codex', 'qoder', 'opencode'] as InitProvider[]) {
    const seen = activity.providers[provider]
    providers.push({
      provider,
      detected: detected.has(provider),
      configured: await providerHookInstalled(workspaceRoot, provider).catch(() => false),
      hookEvents: seen?.events ?? 0,
      lastEventAt: seen?.lastEventAt ?? null
    })
  }

  const base = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    runtime,
    workspace: {
      idHash: hash(enablement.enabled ? enablement.config.workspaceId : workspaceRoot),
      configFingerprint: configSource ? hash(configSource) : null,
      capturePolicy: enablement.enabled ? capturePolicyVersion(enablement.config.capture) : null
    },
    providers,
    omitted
  }

  if (!enablement.enabled) {
    return { ...base, recorder: { enabled: false, reason: enablement.reason }, recorderLogTail: [] }
  }

  const [health, store, archive, drain] = await Promise.all([
    readHealth(enablement.dataRoot),
    verifyStore(enablement.dataRoot),
    readArchiveState(enablement.dataRoot),
    readDrainStatus(enablement.dataRoot)
  ])
  const activation = await resolveCommitHookActivation(workspaceRoot, enablement.config, env)
  const activated = activation.status === 'trusted' || activation.status === 'host-provided'
  const notifications = await commitNotificationStatus(enablement.dataRoot, commitHookEnv(activation, env))
  const logTail = await readFile(join(enablement.dataRoot, 'logs', 'recorder.log'), 'utf8')
    .then((text) => text.split('\n').filter(Boolean).slice(-LOG_TAIL_LINES).map(redact))
    .catch(() => [])

  return {
    ...base,
    recorder: {
      enabled: true,
      health: {
        droppedEvents: health.droppedEvents,
        orphanEvents: health.orphanEvents,
        pendingCount: health.pendingCount,
        oldestPendingAgeMs: health.oldestPendingAgeMs,
        recoveredRecords: health.recoveredRecords,
        lastErrorAt: health.lastError?.at ?? null,
        lastError: health.lastError ? redact(health.lastError.message) : null
      },
      store: {
        ok: store.ok,
        records: store.records,
        archivedThrough: store.archivedThrough,
        errors: store.errors.map(redact)
      },
      commitHook: {
        activation: activation.status,
        ackedThrough: activated ? notifications.ackedThrough : null,
        notifyBacklog: activated ? notifications.notifyBacklog : null,
        lastDrainTruncated: drain.truncated
      },
      archives: archive?.archives.length ?? 0
    },
    recorderLogTail: logTail
  }
}
