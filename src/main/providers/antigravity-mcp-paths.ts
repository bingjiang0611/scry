import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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

/**
 * Derive `.gemini` root from a sanitized Antigravity launch env (B1).
 * If `rawEnv` is unsanitized, call `antigravityEffectiveGeminiRoot` so an unallowed
 * `GEMINI_HOME` can never diverge from what `agy acp` actually reads.
 */
export function antigravityGeminiRoot(homeDir: string, sanitizedEnv: NodeJS.ProcessEnv = {}): string {
  const configured = sanitizedEnv.GEMINI_HOME?.trim()
  if (configured && isAbsolute(configured)) return configured
  return join(homeDir, '.gemini')
}

/**
 * Derive `.gemini` root from a raw/mixed env by honoring `GEMINI_HOME` ONLY when
 * explicitly allowlisted via `SCRY_PROVIDER_ENV_ALLOW=antigravity:GEMINI_HOME` (B1).
 */
export function antigravityEffectiveGeminiRoot(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const allowed = explicitlyAllowedProviderEnvKeys(env.SCRY_PROVIDER_ENV_ALLOW, 'antigravity')
  if (allowed.has('GEMINI_HOME')) {
    const configured = env.GEMINI_HOME?.trim()
    if (configured && isAbsolute(configured)) return configured
  }
  return join(homeDir, '.gemini')
}

function fileHasPreToolUseHook(hooksPath: string): boolean {
  if (!existsSync(hooksPath)) return false
  try {
    const stat = lstatSync(hooksPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return false
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const pre = parsed.PreToolUse
    if (Array.isArray(pre) && pre.length > 0) return true
    if (pre && typeof pre === 'object' && Object.keys(pre).length > 0) return true
  } catch {
    return false
  }
  return false
}

/**
 * Detect whether workspace (`cwd..gitRoot` 4 alias dirs + inline plugins) or user-level
 * `~/.gemini/config/hooks.json` declares any `PreToolUse` hook (D12).
 */
export function hasAntigravityPreToolUseHooks(
  cwd: string | undefined,
  homeDir: string,
  sanitizedEnv: NodeJS.ProcessEnv = {}
): boolean {
  const userHooks = join(antigravityGeminiRoot(homeDir, sanitizedEnv), 'config', 'hooks.json')
  if (fileHasPreToolUseHook(userHooks)) return true
  if (!cwd) return false
  for (const root of antigravityScanRoots(cwd)) {
    for (const alias of ANTIGRAVITY_CONFIG_DIR_ALIASES) {
      const aliasDir = join(root, alias)
      if (fileHasPreToolUseHook(join(aliasDir, 'hooks.json'))) return true
      const pluginsDir = join(aliasDir, 'plugins')
      try {
        const stat = lstatSync(pluginsDir)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue
          if (fileHasPreToolUseHook(join(pluginsDir, entry.name, 'hooks.json'))) return true
        }
      } catch { /* ignore */ }
    }
  }
  return false
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
