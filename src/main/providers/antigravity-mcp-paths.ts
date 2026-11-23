import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { explicitlyAllowedProviderEnvKeys } from '../provider-environment'

/** All four workspace config directory aliases empirically loaded by `agy acp 1.5.12`. */
export const ANTIGRAVITY_CONFIG_DIR_ALIASES = ['.agents', '.agent', '_agents', '_agent'] as const

/** Walk `cwd` upward through its enclosing `.git` root (inclusive), or just `[cwd]` outside a repo. */
export function antigravityScanRoots(cwd: string): string[] {
  const start = resolve(cwd)
  const visited: string[] = []
  let current = start
  while (true) {
    visited.push(current)
    if (existsSync(join(current, '.git'))) return visited
    const parent = dirname(current)
    if (parent === current) return [start]
    current = parent
  }
}

export class AntigravityInvalidGeminiHomeError extends Error {
  constructor(configured: string) {
    super(`已拒绝启动 Antigravity：GEMINI_HOME 必须是绝对路径（当前为相对路径 "${configured}"）`)
    this.name = 'AntigravityInvalidGeminiHomeError'
  }
}

function assertAbsoluteGeminiHome(configured: string): string {
  if (!isAbsolute(configured)) {
    throw new AntigravityInvalidGeminiHomeError(configured)
  }
  return configured
}

/**
 * Derive `.gemini` root from a sanitized Antigravity launch env (B1).
 * Uses the exact raw `GEMINI_HOME` value passed to `agy` (no implicit trimming) and
 * rejects relative paths fail-closed so Scry and `agy` never disagree on resolution.
 */
export function antigravityGeminiRoot(homeDir: string, sanitizedEnv: NodeJS.ProcessEnv = {}): string {
  const configured = sanitizedEnv.GEMINI_HOME
  if (configured !== undefined && configured.length > 0) return assertAbsoluteGeminiHome(configured)
  return join(homeDir, '.gemini')
}

/**
 * Derive `.gemini` root from a raw/mixed env by honoring `GEMINI_HOME` ONLY when
 * explicitly allowlisted via `SCRY_PROVIDER_ENV_ALLOW=antigravity:GEMINI_HOME` (B1).
 */
export function antigravityEffectiveGeminiRoot(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const allowed = explicitlyAllowedProviderEnvKeys(env.SCRY_PROVIDER_ENV_ALLOW, 'antigravity')
  if (allowed.has('GEMINI_HOME')) {
    const configured = env.GEMINI_HOME
    if (configured !== undefined && configured.length > 0) return assertAbsoluteGeminiHome(configured)
  }
  return join(homeDir, '.gemini')
}

const HOOK_ALLOW_DECISION_PATTERN = /decision["']?\s*[:=]\s*["']?allow\b/i
const MAX_HOOK_SCRIPT_INSPECT_BYTES = 64 * 1024
const MAX_HOOK_MATCHER_LENGTH = 128

function canonicalAllowedHookRoots(geminiRoot: string, scanRoots: readonly string[]): string[] {
  const realRoots: string[] = []
  for (const root of [geminiRoot, ...scanRoots]) {
    try {
      realRoots.push(realpathSync(root))
    } catch { /* non-existent root cannot contain real files */ }
  }
  return [...new Set(realRoots)]
}

function isWithinRealRoots(realPath: string, allowedRealRoots: readonly string[]): boolean {
  return allowedRealRoots.some((root) => {
    const rel = relative(root, realPath)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  })
}

function commandCanReturnAllowDecision(
  command: string,
  hookFileDir: string,
  cwd: string | undefined,
  allowedRealRoots: readonly string[]
): boolean {
  if (HOOK_ALLOW_DECISION_PATTERN.test(command)) return true
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  for (const rawToken of tokens.slice(0, 3)) {
    const cleaned = rawToken.replace(/^["']|["']$/g, '')
    if (!cleaned || cleaned.startsWith('-')) continue
    const candidates = isAbsolute(cleaned)
      ? [cleaned]
      : [resolve(hookFileDir, cleaned), ...(cwd ? [resolve(cwd, cleaned)] : [])]
    for (const candidate of candidates) {
      try {
        const stat = lstatSync(candidate)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_HOOK_SCRIPT_INSPECT_BYTES) continue
        const realCandidate = realpathSync(candidate)
        if (!isWithinRealRoots(realCandidate, allowedRealRoots)) continue
        if (HOOK_ALLOW_DECISION_PATTERN.test(readFileSync(realCandidate, 'utf8'))) return true
      } catch {  }
    }
  }
  return false
}

function extractAllowMatchersFromPreToolUse(
  pre: unknown,
  hookFileDir: string,
  cwd: string | undefined,
  allowedRealRoots: readonly string[]
): string[] {
  if (!Array.isArray(pre)) return []
  const matchers: string[] = []
  for (const group of pre) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    const g = group as Record<string, unknown>
    const hooks = Array.isArray(g.hooks) ? g.hooks : []
    const allowCapable = hooks.some((h) => {
      if (!h || typeof h !== 'object' || Array.isArray(h)) return false
      const cmd = (h as Record<string, unknown>).command
      return typeof cmd === 'string' && cmd.trim().length > 0 && commandCanReturnAllowDecision(cmd, hookFileDir, cwd, allowedRealRoots)
    })
    if (!allowCapable) continue
    const matcher = typeof g.matcher === 'string' ? g.matcher.trim() : '*'
    if (matcher.length > MAX_HOOK_MATCHER_LENGTH) continue
    matchers.push(matcher || '*')
  }
  return matchers
}

function allowMatchersInHooksFile(
  hooksPath: string,
  cwd: string | undefined,
  allowedRealRoots: readonly string[]
): string[] {
  if (!existsSync(hooksPath)) return []
  try {
    const stat = lstatSync(hooksPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return []
    const realHooksPath = realpathSync(hooksPath)
    if (!isWithinRealRoots(realHooksPath, allowedRealRoots)) return []
    const parsed = JSON.parse(readFileSync(realHooksPath, 'utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const hookFileDir = dirname(hooksPath)
    const out = extractAllowMatchersFromPreToolUse(parsed.PreToolUse, hookFileDir, cwd, allowedRealRoots)
    // Real agy hooks.json schema: top-level keys are hook names mapping to { enabled?, PreToolUse?, ... }.
    for (const entry of Object.values(parsed)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const named = entry as Record<string, unknown>
      if (named.enabled === false) continue
      out.push(...extractAllowMatchersFromPreToolUse(named.PreToolUse, hookFileDir, cwd, allowedRealRoots))
    }
    return out
  } catch {
    return []
  }
}

/**
 * Collect matchers for `PreToolUse` hooks that can plausibly return `decision: "allow"` (D12 / N5).
 * Log-only hooks (no `decision: allow` in inline command or script) are excluded so they never
 * trigger false「由 hook 放行」labels. Script inspection is strictly confined to canonical
 * `antigravityScanRoots(cwd)` and `.gemini` roots via `realpathSync`.
 */
export function collectAllowCapablePreToolUseMatchers(
  cwd: string | undefined,
  homeDir: string,
  sanitizedEnv: NodeJS.ProcessEnv = {}
): string[] {
  const matchers: string[] = []
  const geminiRoot = antigravityGeminiRoot(homeDir, sanitizedEnv)
  const scanRoots = cwd ? antigravityScanRoots(cwd) : []
  const allowedRealRoots = canonicalAllowedHookRoots(geminiRoot, scanRoots)
  const userHooks = join(geminiRoot, 'config', 'hooks.json')
  matchers.push(...allowMatchersInHooksFile(userHooks, cwd, allowedRealRoots))
  if (!cwd) return [...new Set(matchers)]
  for (const root of scanRoots) {
    for (const alias of ANTIGRAVITY_CONFIG_DIR_ALIASES) {
      const aliasDir = join(root, alias)
      matchers.push(...allowMatchersInHooksFile(join(aliasDir, 'hooks.json'), cwd, allowedRealRoots))
      const pluginsDir = join(aliasDir, 'plugins')
      try {
        const stat = lstatSync(pluginsDir)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue
          matchers.push(...allowMatchersInHooksFile(join(pluginsDir, entry.name, 'hooks.json'), cwd, allowedRealRoots))
        }
      } catch {  }
    }
  }
  return [...new Set(matchers)]
}

function inlinePluginMcpPaths(aliasDir: string): string[] {
  const pluginsDir = join(aliasDir, 'plugins')
  const paths: string[] = []
  try {
    const stat = lstatSync(pluginsDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return paths
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const candidate = join(pluginsDir, entry.name, 'mcp_config.json')
      if (existsSync(candidate)) paths.push(candidate)
    }
  } catch {
    // Missing or unreadable plugins directory yields no extra MCP paths here; A6 trust gate fails closed.
  }
  return paths
}

function pluginsJsonMcpPaths(aliasDir: string): string[] {
  const manifest = join(aliasDir, 'plugins.json')
  if (!existsSync(manifest)) return []
  const paths: string[] = []
  try {
    const stat = lstatSync(manifest)
    if (!stat.isFile() || stat.isSymbolicLink()) return paths
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      entries?: unknown
      inherits?: unknown
    }
    const candidates: string[] = []
    if (Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        if (typeof entry === 'string') candidates.push(entry)
        else if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
          candidates.push((entry as { path: string }).path)
        }
      }
    }
    if (Array.isArray(parsed.inherits)) {
      for (const item of parsed.inherits) {
        if (typeof item === 'string') candidates.push(item)
      }
    }
    for (const raw of candidates) {
      const target = isAbsolute(raw) ? raw : resolve(aliasDir, raw)
      const mcp = join(target, 'mcp_config.json')
      if (existsSync(mcp)) paths.push(mcp)
    }
  } catch {
    // Parse errors are enforced fail-closed by A6 antigravity-config-trust.
  }
  return paths
}

function isEmptyUserPlaceholder(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === 0
  } catch {
    return false
  }
}

/**
 * Explicit MCP config paths for Antigravity (`agy acp`), covering:
 * - User-level `~/.gemini/config/mcp_config.json` (0-byte placeholder created by `agy` is skipped; non-empty files still fail closed)
 * - `cwd` up to `.git` root across all four alias dirs `{.agents,.agent,_agents,_agent}/mcp_config.json`
 * - Inline plugins under `{alias}/plugins/<name>/mcp_config.json` and `plugins.json` targets
 */
export function antigravityMcpConfigPaths(
  cwd: string | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { sanitized?: boolean } = {}
): string[] {
  const geminiRoot = options.sanitized
    ? antigravityGeminiRoot(homeDir, env)
    : antigravityEffectiveGeminiRoot(homeDir, env)
  const userMcpPath = join(geminiRoot, 'config', 'mcp_config.json')
  const paths = isEmptyUserPlaceholder(userMcpPath) ? [] : [userMcpPath]
  if (!cwd) return paths
  for (const root of antigravityScanRoots(cwd)) {
    for (const alias of ANTIGRAVITY_CONFIG_DIR_ALIASES) {
      const aliasDir = join(root, alias)
      paths.push(join(aliasDir, 'mcp_config.json'))
      paths.push(...inlinePluginMcpPaths(aliasDir))
      paths.push(...pluginsJsonMcpPaths(aliasDir))
    }
  }
  return [...new Set(paths)]
}
