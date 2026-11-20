import type { ProviderId } from '../shared/provider.js'

export function sanitizeNestedAgentEnv(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...input }
  for (const key of Object.keys(out)) {
    if (
      key === 'CLAUDECODE' ||
      key === 'AI_AGENT' ||
      key === 'CLAUDE_EFFORT' ||
      key === 'SCRY_CODEX_SOURCE_HOME' ||
      key === 'CODEX_CI' ||
      key === 'CODEX_THREAD_ID' ||
      key.startsWith('CLAUDE_CODE_') ||
      key.startsWith('CODEX_INTERNAL_')
    ) delete out[key]
  }
  return out
}

const PROVIDER_FORBIDDEN_ENV = new Set([
  'OPENAI_ADMIN_API_KEY',
  'ANTHROPIC_ADMIN_API_KEY',
  'QODER_ADMIN_API_KEY',
  'QODER_ORGANIZATION_ID',
  'QODER_MEMBER_ID',
  'SCRY_RECORDER_COMMIT_HOOK',
  'SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT'
])

export const ANTIGRAVITY_DEFAULT_STRIPPED_VARS: readonly string[] = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ADC_AUTH',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'AGY_ACP_ENABLE_OAUTH',
  'AGY_ACP_CCPA_PROJECT',
  'GEMINI_HOME',
  'ANTIGRAVITY_HARNESS_PATH'
]

const ANTIGRAVITY_STRIPPED_SET: ReadonlySet<string> = new Set(ANTIGRAVITY_DEFAULT_STRIPPED_VARS)
const SSH_SESSION_VARS: ReadonlySet<string> = new Set(['SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY'])

export function explicitlyAllowedProviderEnvKeys(
  rawAllow: string | undefined,
  providerId?: ProviderId
): Set<string> {
  return new Set(
    rawAllow?.split(',')
      .map((value) => value.trim())
      .filter((value) => providerId != null && value.startsWith(`${providerId}:`))
      .map((value) => value.slice(value.indexOf(':') + 1))
      .filter(Boolean) ?? []
  )
}

/** Returns only stripped Antigravity credential/identity variable names (never values). */
export function detectStrippedAntigravityEnvNames(input: Record<string, string | undefined>): string[] {
  const allowed = explicitlyAllowedProviderEnvKeys(input.SCRY_PROVIDER_ENV_ALLOW, 'antigravity')
  return ANTIGRAVITY_DEFAULT_STRIPPED_VARS.filter(
    (name) => Boolean(input[name]) && !allowed.has(name)
  )
}

export function sanitizeProviderEnv(input: Record<string, string>, providerId?: ProviderId): Record<string, string> {
  const out = sanitizeNestedAgentEnv(input)
  const explicitlyAllowed = explicitlyAllowedProviderEnvKeys(input.SCRY_PROVIDER_ENV_ALLOW, providerId)
  delete out.SCRY_PROVIDER_ENV_ALLOW
  const forbiddenPrefixes = ['AWS_', 'AZURE_', 'GOOGLE_', 'GCP_']
  const providerPrefixes: Partial<Record<ProviderId, string[]>> = {
    claude: ['OPENAI_', 'CODEX_', 'QODER_', 'OPENCODE_', 'GEMINI_', 'AGY_', 'ANTIGRAVITY_'],
    codex: ['ANTHROPIC_', 'CLAUDE_', 'QODER_', 'OPENCODE_', 'GEMINI_', 'AGY_', 'ANTIGRAVITY_'],
    qoder: ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'OPENCODE_', 'GEMINI_', 'AGY_', 'ANTIGRAVITY_'],
    opencode: ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'QODER_', 'GEMINI_', 'AGY_', 'ANTIGRAVITY_'],
    pi: ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'QODER_', 'OPENCODE_', 'GEMINI_', 'AGY_', 'ANTIGRAVITY_'],
    antigravity: ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'QODER_', 'OPENCODE_']
  }
  const keepSshForFileStorage = providerId === 'antigravity' && explicitlyAllowed.has('AGY_ACP_FORCE_FILE_STORAGE')
  for (const key of Object.keys(out)) {
    if (
      PROVIDER_FORBIDDEN_ENV.has(key) ||
      (!explicitlyAllowed.has(key) && forbiddenPrefixes.some((prefix) => key.startsWith(prefix))) ||
      (!explicitlyAllowed.has(key) && (providerId ? providerPrefixes[providerId] ?? [] : []).some((prefix) => key.startsWith(prefix))) ||
      (providerId === 'antigravity' && ANTIGRAVITY_STRIPPED_SET.has(key) && !explicitlyAllowed.has(key)) ||
      (providerId === 'antigravity' && SSH_SESSION_VARS.has(key) && !keepSshForFileStorage)
    ) {
      delete out[key]
    }
  }
  return out
}
