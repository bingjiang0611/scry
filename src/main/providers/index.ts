import type { ProviderAdapter } from './types'
import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import { createQoderAdapter } from './qoder'
import { createOpenCodeAdapter } from './opencode'
import { selectProviderTransports } from './legacy-cli'

export function createBuiltInProviderAdapters(homeDir: string, transportSpec?: string): ProviderAdapter[] {
  return selectProviderTransports(
    [createClaudeAdapter(homeDir), createCodexAdapter(), createQoderAdapter(), createOpenCodeAdapter()],
    transportSpec
  )
}
