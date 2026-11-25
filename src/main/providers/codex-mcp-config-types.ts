/** The argv/env codex-mcp-config hands the app-server, plus the temp files it owns. */
export interface CodexMcpConfig {
  args: string[]
  /** Added to the app-server env: header values `env_http_headers` refers to by name. */
  env: Record<string, string>
  /** Removes the stdio env files; present when there are any. Codex reads them on each server (re)start. */
  dispose?: () => void
}

