import { sha256Hex } from '../../host-runtime/orchestration/canonical-json'
import { environmentFingerprint, providerSessionKey, type ProviderSessionKeyParts } from '../../host-runtime/provider-sessions/session-key'

/**
 * R4: the key of a reusable Antigravity session. A fresh conversation is its own session — keying
 * every new conversation on `'fresh'` made the second one collide with the first, and the host used
 * to close the live process to "make room". A continuation is keyed by the native session it
 * resumes; the host aliases the native id, so the next turn finds the process it already owns.
 */
export function antigravitySessionKey(input: {
  cwd: string
  runId: string
  resume?: string
  mcp: unknown
  permissionMode: string
  baseEnv?: Record<string, string>
}): { key: string; parts: ProviderSessionKeyParts } {
  const parts: ProviderSessionKeyParts = {
    sessionBinding: input.cwd,
    continuationKey: input.resume ?? input.runId,
    mcpFingerprint: sha256Hex(JSON.stringify(input.mcp)),
    permissionMode: input.permissionMode,
    environmentFingerprint: environmentFingerprint(input.baseEnv ?? {})
  }
  return { key: providerSessionKey(parts), parts }
}
