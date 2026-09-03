import { resolve } from 'node:path'
import { evidenceStatusMap, type AgentTurnRecord } from '../shared/turn-record.js'
import { resolveRecorderEnablement } from '../core/turn-recorder/config.js'
import { readProviderActivity } from '../core/turn-recorder/provider-activity.js'
import { refreshRecorderPendingHealth } from '../core/turn-recorder/recorder.js'
import { recorderHasOpenTurn } from '../core/turn-recorder/runtime-state.js'
import { exportRecords, readHealth } from '../core/turn-recorder/store.js'

/**
 * Proof-of-capture for a fresh install. `scry init` only proves configuration was written;
 * this waits for a real turn and reports which stage actually failed, so an adopting team
 * never has to read source to find out why nothing was recorded.
 */
export type VerifyCaptureReason =
  | 'ok'
  | 'missing_config'
  | 'disabled'
  | 'no_hook_event'
  | 'pending_open_turn'
  | 'events_without_record'

const POLL_INTERVAL_MS = 500

export interface VerifyCaptureEvidence {
  /** A turn is still in flight (open state on disk) — distinct from needing recovery. */
  openTurnInFlight: boolean
  /** Provider lifecycle events observed while waiting, by provider. */
  hookEvents: Record<string, { event: string; at: string; delta: number }>
  /**
   * Any lifecycle event ever recorded for this workspace. Distinguishes "this provider has
   * never reached the recorder" from "it did before, but nothing arrived during this wait".
   */
  hookEventsEverSeen: Record<string, { event: string; at: string; events: number }>
  openTurnsPending: number
  droppedEvents: number
  orphanEvents: number
  waitedMs: number
}

export interface VerifyCaptureResult {
  schemaVersion: 1
  workspace: string
  reason: VerifyCaptureReason
  detail: string
  remediation?: string
  record: {
    recordId: string
    sequence: number
    provider: string
    sessionId: string
    status: AgentTurnRecord['status']
    /** Per-section evidence status, so a green result cannot hide unavailable sections. */
    evidence: Record<string, string>
  } | null
  evidence: VerifyCaptureEvidence
}

function activityDelta(
  before: Record<string, { events: number } | undefined>,
  after: Record<string, { lastEvent: string; lastEventAt: string; events: number } | undefined>
): VerifyCaptureEvidence['hookEvents'] {
  const events: VerifyCaptureEvidence['hookEvents'] = {}
  for (const [provider, entry] of Object.entries(after)) {
    if (!entry) continue
    const delta = entry.events - (before[provider]?.events ?? 0)
    if (delta > 0) events[provider] = { event: entry.lastEvent, at: entry.lastEventAt, delta }
  }
  return events
}

export async function verifyCapture(
  workspace: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<VerifyCaptureResult> {
  const workspaceRoot = resolve(workspace)
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? 120_000
  const enablement = await resolveRecorderEnablement(workspaceRoot, env)
  const empty: VerifyCaptureEvidence = {
    openTurnInFlight: false,
    hookEvents: {},
    hookEventsEverSeen: {},
    openTurnsPending: 0,
    droppedEvents: 0,
    orphanEvents: 0,
    waitedMs: 0
  }
  if (!enablement.enabled) {
    const missing = enablement.reason === 'missing_config' || enablement.reason === 'invalid_config'
    return {
      schemaVersion: 1,
      workspace: workspaceRoot,
      reason: missing ? 'missing_config' : 'disabled',
      detail: enablement.detail ? `${enablement.reason}: ${enablement.detail}` : enablement.reason,
      remediation: missing
        ? 'run `scry init` in the Git repository root'
        : 'recorder is switched off by config, `.scry-disabled`, or SCRY_RECORDER_ENABLED=0',
      record: null,
      evidence: empty
    }
  }

  const dataRoot = enablement.dataRoot
  const baselineActivity = (await readProviderActivity(dataRoot)).providers
  const baseline = (await exportRecords(dataRoot, { limit: 1 })).snapshotMaxSequence
  const startedAt = Date.now()

  let latest: AgentTurnRecord | null = null
  while (Date.now() - startedAt < timeoutMs) {
    const page = await exportRecords(dataRoot, { after: baseline, limit: 1 })
    if (page.records.length > 0) {
      latest = page.records[0]
      break
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }

  // Stored counters only advance on start/end events; recompute so a turn opened before this
  // command started is still reported as pending instead of looking like "no hook event".
  await refreshRecorderPendingHealth(dataRoot).catch(() => undefined)
  const health = await readHealth(dataRoot)
  const activity = (await readProviderActivity(dataRoot)).providers
  const everSeen: VerifyCaptureEvidence['hookEventsEverSeen'] = {}
  for (const [provider, entry] of Object.entries(activity)) {
    if (entry) everSeen[provider] = { event: entry.lastEvent, at: entry.lastEventAt, events: entry.events }
  }
  const evidence: VerifyCaptureEvidence = {
    openTurnInFlight: await recorderHasOpenTurn(dataRoot).catch(() => false),
    hookEvents: activityDelta(baselineActivity, activity),
    hookEventsEverSeen: everSeen,
    openTurnsPending: health.pendingCount,
    droppedEvents: health.droppedEvents,
    orphanEvents: health.orphanEvents,
    waitedMs: Date.now() - startedAt
  }

  if (latest) {
    return {
      schemaVersion: 1,
      workspace: workspaceRoot,
      reason: 'ok',
      detail: `committed record ${latest.sequence} for ${latest.provider.id}`,
      record: {
        recordId: latest.recordId,
        sequence: latest.sequence,
        provider: latest.provider.id,
        sessionId: latest.sessionId,
        status: latest.status,
        evidence: evidenceStatusMap(latest)
      },
      evidence
    }
  }
  if (evidence.openTurnInFlight || evidence.openTurnsPending > 0) {
    return {
      schemaVersion: 1,
      workspace: workspaceRoot,
      reason: 'pending_open_turn',
      detail: evidence.openTurnInFlight
        ? 'hook events reached the recorder but the turn is still in flight'
        : 'hook events reached the recorder but a previous turn awaits recovery',
      remediation: 'finish the turn, then re-run; `scry recorder recover` finalizes stuck turns',
      record: null,
      evidence
    }
  }
  if (Object.keys(evidence.hookEvents).length === 0) {
    const everSeen = Object.keys(evidence.hookEventsEverSeen)
    return {
      schemaVersion: 1,
      workspace: workspaceRoot,
      reason: 'no_hook_event',
      detail: everSeen.length === 0
        ? 'no provider lifecycle event has ever reached the recorder in this workspace'
        : `no lifecycle event arrived while waiting; previously seen from ${everSeen.join(', ')}`,
      remediation: 'run one real turn while this command waits; check `scry status`, and Codex additionally needs `/hooks` approved inside the agent',
      record: null,
      evidence
    }
  }
  return {
    schemaVersion: 1,
    workspace: workspaceRoot,
    reason: 'events_without_record',
    detail: 'hook events arrived but no record was committed and no turn is pending',
    remediation: 'inspect .scry/logs/recorder.log; dropped/orphan counters above show discarded events',
    record: null,
    evidence
  }
}
