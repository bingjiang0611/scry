import { spawnSync } from 'node:child_process'

// The former single Electron process exceeded its 30s deadline while running
// unrelated fixtures. Keep every check, using the existing focused entrypoints
// and the unchanged deadline for each independently owned Electron process.
export const defaultCapabilityCampaigns = [
  '--motion-tokens-only', '--sidebar-activity-only', '--cache-only',
  '--meta-prompts-only', '--performance-only', '--summary-only',
  '--pi-commands-only', '--overview-only', '--selection-only',
  '--pi-permission-only', '--models-only', '--terminals-only'
]

export function runCapabilityCampaigns(script) {
  for (const mode of defaultCapabilityCampaigns) {
    console.log(`UI campaign: ${mode}`)
    const result = spawnSync(process.execPath, [script, mode], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}
