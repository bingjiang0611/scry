import type { DaemonForwardTable, DaemonLocalOpTable } from './types'

// Read-only queries: usage, LLM performance, git diff, recorder content, skills, commands.
// Every entry here changes nothing, so a read lost to a reconnect may be asked again.
export const QUERY_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:usageStats': { op: 'usage', method: 'usageStats', read: true },
  'agent:usageAnalytics': { op: 'usage', method: 'usageAnalytics', read: true },
  'agent:usageCredits': { op: 'usage', method: 'usageCredits', read: true },
  'agent:stats': { op: 'usage', method: 'stats', read: true },
  'agent:llmPerformanceHistory': { op: 'llmPerformance', method: 'llmPerformanceHistory', read: true },
  'agent:llmPerformanceSummary': { op: 'llmPerformance', method: 'llmPerformanceSummary', read: true },
  'agent:gitDiff': { op: 'workspaceDiff', method: 'gitDiff', read: true },
  'agent:gitDiffSnapshot': { op: 'workspaceDiff', method: 'gitDiffSnapshot', read: true },
  'agent:gitDiffCommits': { op: 'workspaceDiff', method: 'gitDiffCommits', read: true },
  'agent:gitCommitDiffSnapshot': { op: 'workspaceDiff', method: 'gitCommitDiffSnapshot', read: true },
  // Queued with the Provider's auth operations as in main; listing starts no run.
  'agent:listSkills': { op: 'skills', method: 'listSkills', read: true },
  // Main's CapabilityEnvelope as it is. Not the device op `commands`: that answers a
  // sanitized `{ commands, reason }` in which an unavailable catalog is an empty list.
  'agent:listCommands': { op: 'providerCommands', method: 'listCommands', read: true },
  // Read for this window's workspace (main's agent:setCwd): the App appends it after the
  // request (recorder-content-daemon.ts) and the daemon re-validates it.
  'agent:recorderContentPage': { op: 'recorderContent', method: 'recorderContentPage', read: true }
}

export const QUERY_FORWARDS: DaemonForwardTable = {}
