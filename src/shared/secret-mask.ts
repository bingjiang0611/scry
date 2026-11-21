// Credential/config display helper only; captured output is now stored verbatim.
// Do not use this helper in evidence sinks: masking there irreversibly changes Provider text.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic API key
  /\bsk-[A-Za-z0-9]{20,}/g, // OpenAI 等 sk- key
  /\bghp_[A-Za-z0-9]{36}\b/g, // GitHub PAT
  /\bgho_[A-Za-z0-9]{36}\b/g, // GitHub OAuth
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm token
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, // Authorization: Bearer
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bAIza[A-Za-z0-9_-]{20,}/g // Google / Gemini API key
]

export function maskSecrets(s: string | undefined): string | undefined {
  if (!s) return s
  let out = s
  out = out.replace(
    /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|aws_secret_access_key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]*)/gi,
    '$1«REDACTED»'
  )
  out = out.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '«REDACTED PRIVATE KEY»')
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi, '$1«REDACTED»$2')
  out = out.replace(/([?&](?:code|state|id_token|access_token)=)[^&\s"'<>]+/gi, '$1«REDACTED»')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«REDACTED»')
  return out
}
