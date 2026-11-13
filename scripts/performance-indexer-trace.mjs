import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep only counters, never raw paths or trace lines. A matching path is evidence
// of workspace access, not a complete I/O audit or proof of latency causality.
export async function countIndexerEvents(lines, workspace) {
  const counts = { eventLines: 0, workspaceNodeModules: 0, workspaceOther: 0, withoutWorkspacePath: 0 }
  const prefix = `${workspace}/`
  for await (const line of lines) {
    if (!/^\d{2}:\d{2}:\d{2}\.\d+\s/.test(line)) continue
    counts.eventLines++
    if (!line.includes(prefix)) counts.withoutWorkspacePath++
    else if (line.includes('/node_modules/')) counts.workspaceNodeModules++
    else counts.workspaceOther++
  }
  return counts
}

export function finalizeIndexerTrace(counts, collectorExit) {
  if (collectorExit !== 0 || counts.eventLines === 0) return { schema: 1, status: 'unavailable', collectorExit,
    reason: collectorExit !== 0 ? 'Indexer tracing failed; no security controls were changed.' : 'No indexer events were observed.' }
  return { schema: 1, status: 'available', collectorExit, counts,
    source: '15-second fs_usage filesys trace filtered to Spotlight processes; path-matched event counts only' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_WORKSPACE) throw new Error('GITHUB_WORKSPACE is required for bounded path matching')
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  console.log(JSON.stringify(await countIndexerEvents(lines, process.env.GITHUB_WORKSPACE)))
}
