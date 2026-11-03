import { PerformanceTrace, performanceRecordingEnabled } from '../performance-timing'

// Segmented timing for the device-facing request path. Today a slow remote read is
// one number, so a 1.9 s Pi catalog read and a 30 ms run status look alike. These
// traces split the same request into transport (handshake, first byte), host
// dispatch and, in the Provider adapters, cold vs reused work, without recording
// any prompt, path or credential.
//
// The operation label comes from a fixed allowlist. A request body is untrusted
// before dispatch validates it, so an unknown or malformed `op` collapses to
// `other` instead of becoming a free-text telemetry channel.
const measuredOperations = new Set([
  'answerQuestion', 'attachmentChunk', 'attachmentCommit', 'attachmentStart',
  'catalogSnapshot', 'commands', 'desktop', 'desktopDirectory', 'desktopWorkbench',
  'directories', 'directoriesPage', 'executionTargets', 'fileDownload', 'history',
  'historyPage', 'historyPreview', 'historyTurnsPage', 'historyVersion', 'intentStatus',
  'liveRuns', 'output', 'poll', 'projects', 'providers', 'questions', 'resolveIntent',
  'runState', 'sessionAction', 'sessionDelete', 'sessionFork', 'sessions', 'sessionsPage',
  'stop', 'submit', 'target', 'toolPanel', 'watch', 'workspace'
])

export function remoteOperationLabel(request: unknown): string {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'other'
  const op = (request as { op?: unknown }).op
  return typeof op === 'string' && measuredOperations.has(op) ? op : 'other'
}

/** Counters for one measured remote request; keys stay inside the label allowlist. */
export function remoteOperationCounters(request: unknown): Readonly<Record<string, number>> {
  return { [`op.${remoteOperationLabel(request)}`]: 1 }
}

// remote.desktop.request: one-shot pairing exchange. remote.client.request: one
// request on a persistent run-channel lane.
export type RemoteTimingName = 'remote.host.connection' | 'remote.host.request' | 'remote.desktop.request' | 'remote.client.request'

export function remoteRequestTrace(name: RemoteTimingName): PerformanceTrace | undefined {
  if (!performanceRecordingEnabled()) return undefined
  return new PerformanceTrace(name, {}, undefined)
}
