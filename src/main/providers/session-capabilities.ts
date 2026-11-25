import type { ProviderAdapter, ProviderSessionCapabilities } from './types'

/**
 * C1/C2: what each Provider can do inside one live session, declared in one table instead of being
 * assumed by the dispatcher. A Provider that cannot steer mid-turn must be interrupted and
 * restarted for a follow-up; a Provider whose permission mode is a launch flag must be recreated,
 * not reconfigured, when the mode changes.
 */
/**
 * `nativeSteer` means the run really has a steer path that admits input into the live turn, and that its
 * capability event says `available`: Codex sends `turn/steer`, Pi sends over its RPC, Qoder pushes a
 * `priority: 'next'` message onto the kept session's input stream. Claude has no such path yet — its CLI
 * accepts input, but Scry does not admit mid-turn — so it says false instead of promising what a user
 * would only find out by trying. A Provider without it is interrupted and restarted, never silently
 * reported as steered.
 */
export const PROVIDER_SESSION_CAPABILITIES: Record<string, ProviderSessionCapabilities> = {
  claude: { persistentProcess: true, nativeSteer: false, onlineModelSwitch: true, permissionModeInLaunchFlags: false },
  qoder: { persistentProcess: true, nativeSteer: true, onlineModelSwitch: true, permissionModeInLaunchFlags: false },
  codex: { persistentProcess: true, nativeSteer: true, onlineModelSwitch: false, permissionModeInLaunchFlags: false },
  opencode: { persistentProcess: true, nativeSteer: false, onlineModelSwitch: false, permissionModeInLaunchFlags: false },
  pi: { persistentProcess: true, nativeSteer: true, onlineModelSwitch: false, permissionModeInLaunchFlags: false },
  antigravity: { persistentProcess: true, nativeSteer: false, onlineModelSwitch: true, permissionModeInLaunchFlags: true }
}

/** Attaches the declared capabilities so `ProviderAdapter.sessionCapabilities` is never absent. */
export function withSessionCapabilities(adapter: ProviderAdapter): ProviderAdapter {
  const capabilities = PROVIDER_SESSION_CAPABILITIES[adapter.id]
  if (!capabilities) throw new Error(`Provider ${adapter.id} 缺少会话能力声明`)
  return adapter.sessionCapabilities ? adapter : { ...adapter, sessionCapabilities: capabilities }
}
