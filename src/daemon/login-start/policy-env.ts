import type {
  BackgroundServiceConfigField,
  BackgroundServiceRelayMode,
  BackgroundServiceRemoteConfig
} from '../../shared/background-service'
import type { ProviderId } from '../../shared/provider'
import { EXPERIMENTAL_PROVIDERS } from '../../shared/experimental-providers'
import { remoteHostEnabled } from '../../shared/remote-host-policy'
import { isAgentPermissionMode } from '../../shared/runtime-types'

// Non-secret remote policy environment variables forwarded into a login-start service
// file (P5-headless-host §2.2 & decision 11). Plain Node only (no Electron dependency).

export const LOGIN_START_POLICY_ENV_KEYS = [
  'SCRY_REMOTE_HOST',
  'SCRY_REMOTE_PERMISSION_MODE',
  'SCRY_REMOTE_RELAY_ENABLED',
  'SCRY_DISABLED_PROVIDERS',
  'SCRY_EXPERIMENTAL_PROVIDERS',
  'SCRY_EXPERIMENTAL_HOST_CLI',
  'SCRY_RUN_CONTROLS',
  'SCRY_PROVIDER_MANIFEST_URL'
] as const

export type LoginStartPolicyEnvKey = (typeof LOGIN_START_POLICY_ENV_KEYS)[number]

const POLICY_KEY_SET: ReadonlySet<string> = new Set(LOGIN_START_POLICY_ENV_KEYS)
const KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set(['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity'])
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export function isLoginStartPolicyEnvKey(key: string): key is LoginStartPolicyEnvKey {
  return POLICY_KEY_SET.has(key)
}

export type PolicyEnvCollection =
  | { ok: true; entries: Array<[LoginStartPolicyEnvKey, string]> }
  | { ok: false; reason: string }

/**
 * Validates one policy value against its real runtime reader without trimming or
 * rewriting: if the App's own env carries leading/trailing whitespace that a real reader
 * would ignore (e.g. `SCRY_REMOTE_HOST=" 1"`), writing a trimmed value into the service
 * file would silently widen policy (W2 review B1).
 */
function validatePolicyEntry(key: LoginStartPolicyEnvKey, raw: string): string | undefined {
  if (CONTROL.test(raw) || raw !== raw.trim() || raw.length === 0) return undefined
  switch (key) {
    case 'SCRY_REMOTE_HOST':
    case 'SCRY_REMOTE_RELAY_ENABLED':
    case 'SCRY_EXPERIMENTAL_HOST_CLI':
    case 'SCRY_RUN_CONTROLS':
      return raw === '0' || raw === '1' ? raw : undefined
    case 'SCRY_REMOTE_PERMISSION_MODE':
      return isAgentPermissionMode(raw) ? raw : undefined
    case 'SCRY_DISABLED_PROVIDERS': {
      const tokens = raw.split(',').map((item) => item.trim())
      if (tokens.length === 0 || tokens.some((item) => item.length === 0 || !KNOWN_PROVIDERS.has(item.toLowerCase() as ProviderId))) {
        return undefined
      }
      // Preserve raw spelling/case verbatim so the service file matches the App's env.
      return raw
    }
    case 'SCRY_EXPERIMENTAL_PROVIDERS': {
      const tokens = raw.split(',').map((item) => item.trim())
      if (tokens.length === 0 || tokens.some((item) => item.length === 0 || !EXPERIMENTAL_PROVIDERS.has(item.toLowerCase() as ProviderId))) {
        return undefined
      }
      return raw
    }
    case 'SCRY_PROVIDER_MANIFEST_URL': {
      try {
        const url = new URL(raw)
        if (url.protocol !== 'https:' || url.username || url.password) return undefined
        return raw
      } catch {
        return undefined
      }
    }
  }
}

/**
 * Validates the App's current environment against P5 §2.2 before writing a service file.
 * Refuses `SCRY_REMOTE_RELAY_WS` (carries a token) and any malformed/untrimmed policy
 * value; ignores diagnostic variables (`SCRY_DAEMON_SMOKE_PROVIDER`, `SCRY_RUN_TIMING`).
 */
export function collectLoginStartPolicyEnv(env: NodeJS.ProcessEnv): PolicyEnvCollection {
  if (env.SCRY_REMOTE_RELAY_WS) return { ok: false, reason: 'login_start_secret_env' }
  const entries: Array<[LoginStartPolicyEnvKey, string]> = []
  for (const key of LOGIN_START_POLICY_ENV_KEYS) {
    const raw = env[key]
    if (raw === undefined) continue
    const valid = validatePolicyEntry(key, raw)
    if (valid === undefined) return { ok: false, reason: `login_start_invalid_env:${key}` }
    entries.push([key, valid])
  }
  return { ok: true, entries }
}

/** Re-validates policy entries parsed from an existing service file before reusing them. */
export function validateParsedPolicyEntries(
  entries: ReadonlyArray<{ key: string; value: string }>
): Array<[LoginStartPolicyEnvKey, string]> | undefined {
  const result: Array<[LoginStartPolicyEnvKey, string]> = []
  const seen = new Set<string>()
  for (const { key, value } of entries) {
    if (!isLoginStartPolicyEnvKey(key) || seen.has(key)) return undefined
    const valid = validatePolicyEntry(key, value)
    if (valid === undefined) return undefined
    seen.add(key)
    result.push([key, valid])
  }
  return result
}

function relayModeOf(env: NodeJS.ProcessEnv): BackgroundServiceRelayMode {
  if (env.SCRY_REMOTE_RELAY_ENABLED === '0') return 'disabled'
  if (env.SCRY_REMOTE_RELAY_WS) return 'custom_ws'
  // Legacy SCRY_REMOTE_RELAY is not in supervisor's FORWARDED_ENV (daemon mode ignores
  // it), so deriving custom_tcp here would create false config-mismatch notices.
  return 'public'
}

function disabledProvidersOf(raw: string | undefined): ProviderId[] {
  const seen = new Set<ProviderId>()
  for (const part of raw?.split(',') ?? []) {
    const token = part.trim().toLowerCase()
    if (KNOWN_PROVIDERS.has(token as ProviderId)) seen.add(token as ProviderId)
  }
  return [...seen].sort()
}

/**
 * Effective non-secret remote policy derived from an environment (daemon or App).
 * Never exposes relay tokens or credentials.
 */
export function computeEffectiveRemoteConfig(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean
): BackgroundServiceRemoteConfig {
  const permissionRaw = env.SCRY_REMOTE_PERMISSION_MODE
  const manifestRaw = env.SCRY_PROVIDER_MANIFEST_URL?.trim()
  return {
    remoteHostEnabled: remoteHostEnabled(env.SCRY_REMOTE_HOST, isPackaged),
    relayMode: relayModeOf(env),
    permissionModeOverride: isAgentPermissionMode(permissionRaw) ? permissionRaw : null,
    disabledProviders: disabledProvidersOf(env.SCRY_DISABLED_PROVIDERS),
    runControlsEnabled: env.SCRY_RUN_CONTROLS?.trim() !== '0',
    providerManifestUrl: manifestRaw ? manifestRaw : null
  }
}

export function diffRemoteConfigs(
  expected: BackgroundServiceRemoteConfig,
  actual: BackgroundServiceRemoteConfig
): BackgroundServiceConfigField[] {
  const diffs: BackgroundServiceConfigField[] = []
  if (expected.remoteHostEnabled !== actual.remoteHostEnabled) diffs.push('remoteHostEnabled')
  if (expected.relayMode !== actual.relayMode) diffs.push('relayMode')
  if (expected.permissionModeOverride !== actual.permissionModeOverride) diffs.push('permissionModeOverride')
  if (expected.disabledProviders.join(',') !== actual.disabledProviders.join(',')) diffs.push('disabledProviders')
  if (expected.runControlsEnabled !== actual.runControlsEnabled) diffs.push('runControlsEnabled')
  if (expected.providerManifestUrl !== actual.providerManifestUrl) diffs.push('providerManifestUrl')
  return diffs
}
