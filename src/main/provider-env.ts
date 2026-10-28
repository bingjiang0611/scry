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
    ) {
      delete out[key]
    }
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

export function sanitizeProviderEnv(input: Record<string, string>, providerId?: ProviderId): Record<string, string> {
  const out = sanitizeNestedAgentEnv(input)
  const explicitlyAllowed = new Set(
    input.SCRY_PROVIDER_ENV_ALLOW?.split(',')
      .map((value) => value.trim())
      .filter((value) => providerId != null && value.startsWith(`${providerId}:`))
      .map((value) => value.slice(value.indexOf(':') + 1))
      .filter(Boolean) ?? []
  )
  delete out.SCRY_PROVIDER_ENV_ALLOW
  const forbiddenPrefixes = ['AWS_', 'AZURE_', 'GOOGLE_', 'GCP_']
  const providerPrefixes: Partial<Record<ProviderId, string[]>> = {
    claude: ['OPENAI_', 'CODEX_', 'QODER_', 'OPENCODE_', 'PI_'],
    codex: ['ANTHROPIC_', 'CLAUDE_', 'QODER_', 'OPENCODE_', 'PI_'],
    qoder: ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'OPENCODE_', 'PI_'],
    opencode: ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'QODER_', 'PI_'],
    pi: ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'QODER_', 'OPENCODE_']
  }
  for (const key of Object.keys(out)) {
    if (PROVIDER_FORBIDDEN_ENV.has(key) ||
      (!explicitlyAllowed.has(key) && forbiddenPrefixes.some((prefix) => key.startsWith(prefix))) ||
      (!explicitlyAllowed.has(key) && (providerId ? providerPrefixes[providerId] ?? [] : []).some((prefix) => key.startsWith(prefix)))) {
      delete out[key]
    }
  }
  return out
}
