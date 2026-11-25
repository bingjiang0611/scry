import { sha256Hex } from '../orchestration/canonical-json'

export interface ProviderSessionKeyParts {
  /** Conversation/session binding the turn belongs to (app session key). */
  sessionBinding: string
  /** Provider continuation identity: same value means the native session can be resumed. */
  continuationKey: string
  /** Canonical digest of the MCP servers this session would launch with. */
  mcpFingerprint: string
  permissionMode: string
  /** Credential/proxy/PATH fingerprint of the launch environment. */
  environmentFingerprint: string
}

/**
 * C1: a Provider session is reusable only when every part of its identity matches. The key is
 * opaque so a credential refresh can only ever cheapen reuse, never widen it.
 */
export function providerSessionKey(parts: ProviderSessionKeyParts): string {
  return `psession:${sha256Hex(JSON.stringify([
    parts.sessionBinding,
    parts.continuationKey,
    parts.mcpFingerprint,
    parts.permissionMode,
    parts.environmentFingerprint
  ]))}`
}

/** Canonical fingerprint of the MCP server set: names, transports and endpoints, never secrets. */
export function mcpFingerprint(servers: Record<string, { type?: string; url?: string; command?: string; args?: readonly string[] }>): string {
  const canonical = Object.keys(servers)
    .sort()
    .map((name) => {
      const server = servers[name] ?? {}
      return [name, server.type ?? '', server.url ?? '', server.command ?? '', [...(server.args ?? [])]]
    })
  return sha256Hex(JSON.stringify(canonical))
}

/** Fingerprint of the launch environment without exposing values: names plus a digest per value. */
export function environmentFingerprint(env: Record<string, string | undefined>): string {
  const canonical = Object.keys(env)
    .sort()
    .map((name) => [name, sha256Hex(String(env[name] ?? ''))])
  return sha256Hex(JSON.stringify(canonical))
}
