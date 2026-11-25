/**
 * Keeps a Codex stdio MCP server's `env` values off the app-server argv.
 *
 * Codex (verified in 0.160.1 source: rmcp-client `create_env_for_mcp_server`, spawned
 * through `codex_utils_pty::Command`, whose constructor calls `env_clear`) starts a
 * local stdio server with a cleared environment holding only: its default names
 * (HOME, LOGNAME, PATH, SHELL, USER, __CF_USER_TEXT_ENCODING, LANG, LC_ALL, TERM,
 * TMPDIR, TZ) and its CA bundle names, copied from the app-server env; then the
 * server's `env` on top; then minus a few names it never passes on. Scry sends no
 * `env_vars`. So when Codex starts `/bin/sh` without `env`, the shell receives that
 * same set minus `env`; the launcher below adds `env` back from a private file and
 * execs the original command, which then sees exactly the env Codex would have built.
 *
 * The launcher is a fixed `sh -c` script, not a file: it holds no secret, so it can sit
 * on argv, and no extra file has to outlive the server. Each step, for dash and for
 * bash as sh (macOS ships bash 3.2.57 there):
 * - `unset PWD OLDPWD SHLVL; readonly SHLVL`: both shells export PWD, and bash's
 *   `exec` re-exports SHLVL (builtins/exec.def `adjust_shell_level`); an unset readonly
 *   SHLVL stays out of the child env. Bash prints one "SHLVL: readonly variable" line
 *   to the server's stderr, which Codex only logs.
 * - `set -a; . "$1"; set +a`: the file holds `NAME='value'` lines, so `.` reads values
 *   verbatim. A missing file makes the special builtin fail and the shell exit, so
 *   the server does not start (fail closed). `.` behaves the same in bash's POSIX mode.
 * - `shift; exec "$@"`: replaces the shell, keeping pid and process group, which Codex
 *   signals; the command is looked up with the same PATH Codex would have used.
 */
export const CODEX_STDIO_ENV_LAUNCHER = 'unset PWD OLDPWD SHLVL; readonly SHLVL; set -a; . "$1"; set +a; shift; exec "$@"'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const LONE_SURROGATE = /\p{Cs}/u

// Names the launcher shell refuses, recomputes or never exports (measured with dash
// and bash 5.2 in its sh mode), plus PWD/OLDPWD that the shell maintains itself.
const SHELL_MANAGED = new Set([
  '_', 'PWD', 'OLDPWD', 'SHLVL', 'OPTIND', 'PPID', 'UID', 'EUID', 'GROUPS', 'LINENO', 'RANDOM', 'SRANDOM',
  'SECONDS', 'HISTCMD', 'FUNCNAME', 'DIRSTACK', 'PIPESTATUS', 'SHELLOPTS', 'EPOCHREALTIME', 'EPOCHSECONDS',
  'COMP_WORDBREAKS'
])

// Codex 0.160.1 drops these (case-insensitively) from the env it builds...
const CODEX_NON_INHERITABLE = new Set([
  'codex_exec_server_noise_auth_token', 'node_repl_auth_token', 'openai_federation_rule_id',
  'openai_identity_token_file', 'openai_workload_identity_context'
])
// ...consumes this one itself in its newer stdio protocol mode...
const CODEX_CONSUMED = 'CODEX_MCP_PROTOCOL_VERSION'
// ...and lets `env` replace its CA names case-insensitively, which a second copy from
// the shell's own env would not.
const CODEX_CA_NAMES = [
  'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO', 'CARGO_HTTP_CAINFO', 'PIP_CERT', 'BUNDLE_SSL_CA_CERT', 'npm_config_cafile', 'NPM_CONFIG_CAFILE'
]

function launcherReproduces(name: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\0') || LONE_SURROGATE.test(value)) return false
  if (!ENV_NAME.test(name) || SHELL_MANAGED.has(name) || name.startsWith('BASH')) return false
  if (CODEX_NON_INHERITABLE.has(name.toLowerCase()) || name === CODEX_CONSUMED) return false
  const ca = CODEX_CA_NAMES.filter((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return ca.length === 0 || (ca.length === 1 && ca[0] === name)
}

/**
 * The env a stdio server can take through the launcher, or undefined to keep the
 * server inline exactly as before (values on argv): no env, a non-string or
 * unreproducible entry, or a command the shell would read as an `exec` option.
 * A server is never dropped or partly rewritten.
 */
export function codexStdioLauncherEnv(config: Record<string, unknown>): Record<string, string> | undefined {
  const env = config.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined
  const entries = Object.entries(env)
  if (entries.length === 0 || !entries.every(([name, value]) => launcherReproduces(name, value))) return undefined
  if (typeof config.command !== 'string' || config.command === '' || config.command.startsWith('-')) return undefined
  if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every((arg) => typeof arg === 'string'))) {
    return undefined
  }
  return Object.fromEntries(entries) as Record<string, string>
}

export function codexStdioEnvFile(env: Record<string, string>): string {
  return Object.entries(env).map(([name, value]) => `${name}='${value.replaceAll("'", "'\\''")}'\n`).join('')
}

export function codexStdioLauncher(config: Record<string, unknown>, envFile: string): Record<string, unknown> {
  const { env: _env, command, args, ...rest } = config
  return {
    command: '/bin/sh',
    args: ['-c', CODEX_STDIO_ENV_LAUNCHER, 'sh', envFile, command, ...((args as string[] | undefined) ?? [])],
    ...rest
  }
}
