import type { DaemonForwardTable, DaemonLocalOpTable } from './types'

// Read-only queries: usage, LLM performance, git diff, recorder content, skills, commands.
// Every entry here changes nothing, so a read lost to a reconnect may be asked again.
// Not served yet, each refused by name:
// - agent:recorderContentPage reads the content of the window's current workspace (main's
//   currentCwd, set by agent:setCwd). The daemon never learns that selection and the
//   renderer's request does not carry it, so the daemon cannot authorize the read.
// - agent:listCommands (forward `commands`): that op answers paired devices with a
//   sanitized `{ commands, reason }`, not main's CapabilityEnvelope; an unavailable
//   catalog would reach the renderer as an empty list. Needs the scope: local answer.
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
  'agent:listSkills': { op: 'skills', method: 'listSkills', read: true }
}

export const QUERY_FORWARDS: DaemonForwardTable = {}
