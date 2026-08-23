import type { ProviderAdapter } from './types'
import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import { createQoderAdapter } from './qoder'
import { createOpenCodeAdapter } from './opencode'
import { createPiAdapter } from './pi'
import { selectProviderTransports } from './legacy-cli'
import type { PiAgentProfile } from '../pi-agent-profiles'

export function createBuiltInProviderAdapters(
  homeDir: string,
  transportSpec?: string,
  codexHomeDir?: string,
  codexSessionIds: () => readonly string[] = () => [],
  openCodeMcpAuthDirectory?: string,
  openCodeSessionStateDirectory?: string,
  piProfiles?: {
    listProfiles: () => Promise<PiAgentProfile[]>
    resolveProfile: (id: string) => Promise<PiAgentProfile | undefined>
  }
): ProviderAdapter[] {
  return selectProviderTransports(
    [
      createClaudeAdapter(homeDir),
      createCodexAdapter(codexHomeDir, codexSessionIds, homeDir),
      createQoderAdapter(homeDir),
      createOpenCodeAdapter(homeDir, openCodeMcpAuthDirectory, openCodeSessionStateDirectory),
      ...(piProfiles ? [createPiAdapter(piProfiles)] : [])
    ],
    transportSpec
  )
}
