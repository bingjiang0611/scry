import type { ProviderAdapter } from './types'
import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import { createQoderAdapter } from './qoder'
import { createOpenCodeAdapter } from './opencode'
import { createPiAdapter } from './pi'
import type { PiRunDiagnostics } from './pi-run-diagnostics'
import type { PiAgentProfile } from '../pi-agent-profiles'

export function createBuiltInProviderAdapters(
  homeDir: string,
  codexHomeDir?: string,
  openCodeMcpAuthDirectory?: string,
  openCodeSessionStateDirectory?: string,
  piProfiles?: {
    listProfiles: () => Promise<PiAgentProfile[]>
    resolveProfile: (id: string) => Promise<PiAgentProfile | undefined>
    historyExtensionPath?: string
    diagnostics?: PiRunDiagnostics
  }
): ProviderAdapter[] {
  return [
    createClaudeAdapter(homeDir),
    createCodexAdapter(codexHomeDir, homeDir),
    createQoderAdapter(homeDir),
    createOpenCodeAdapter(homeDir, openCodeMcpAuthDirectory, openCodeSessionStateDirectory),
    ...(piProfiles ? [createPiAdapter(piProfiles)] : [])
  ]
}
