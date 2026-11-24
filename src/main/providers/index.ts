import { withSessionCapabilities } from './session-capabilities'
import type { ProviderAdapter } from './types'
import type { ProviderSessionHost } from '../../host-runtime/provider-sessions/session-host'
import type { AntigravityProcessSession } from './antigravity-session'
import { isExperimentalProviderEnabled } from '../../shared/experimental-providers'
import { createAntigravityAdapter } from './antigravity'
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
    /** C1: Pi's pool reports open/release so the host can store the reason. */
    sessions?: {
      onOpened?: (key: string, provider: 'pi', at: number) => void
      onNativeSessionId?: (key: string, nativeSessionId: string) => void
      onReleased?: (key: string, reason: string, at: number) => void
    }
  },
  userDataDir?: string,
  /** Scry C1: daemon-owned Provider session host shared by adapters that can keep a process. */
  providerSessions?: ProviderSessionHost<AntigravityProcessSession>,
  /** C1: Codex keeps one app-server per session key and reports open/release here. */
  codexSessions?: {
    onOpened?: (key: string, provider: 'codex', at: number) => void
    onNativeSessionId?: (key: string, nativeSessionId: string) => void
    onReleased?: (key: string, reason: string, at: number) => void
  }
): ProviderAdapter[] {
  return withDeclaredCapabilities([
    createClaudeAdapter(homeDir),
    createCodexAdapter(codexHomeDir, homeDir, codexSessions),
    createQoderAdapter(homeDir),
    createOpenCodeAdapter(homeDir, openCodeMcpAuthDirectory, openCodeSessionStateDirectory),
    ...(piProfiles ? [createPiAdapter(piProfiles)] : []),
    ...(isExperimentalProviderEnabled('antigravity')
      ? [createAntigravityAdapter(homeDir, { userDataDir, sessions: providerSessions })]
      : [])
  ])
}

function withDeclaredCapabilities(adapters: ProviderAdapter[]): ProviderAdapter[] {
  return adapters.map(withSessionCapabilities)
}
