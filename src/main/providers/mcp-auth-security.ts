const AUTH_HEADER = /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)[^\r\n]*/gi
const AUTH_VALUE = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi
const AUTH_URL_VALUE = /([?&#](?:code|state|access_token|refresh_token|id_token|client_secret)=)[^&#\s"']*/gi
const AUTH_NAMED_ASSIGNMENT = /\b((?:access|refresh|id)[_-]?token|authorization[_-]?code|client[_-]?secret|api[_-]?key|oauth[_-]?state|state)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const AUTH_ASSIGNMENT = /\b((?:[A-Z0-9]+_)*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|CLIENT[_-]?SECRET))["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi

export function sanitizeMcpAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(AUTH_HEADER, '$1[redacted]')
    .replace(AUTH_VALUE, '$1 [redacted]')
    .replace(AUTH_URL_VALUE, '$1[redacted]')
    .replace(AUTH_NAMED_ASSIGNMENT, '$1=[redacted]')
    .replace(AUTH_ASSIGNMENT, '$1=[redacted]')
    .slice(-2_000)
}
