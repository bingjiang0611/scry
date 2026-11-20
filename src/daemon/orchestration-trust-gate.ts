import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { shellEnv, warmShellEnv } from '../main/claude-locate'
import { providerMcpConfigPaths } from '../main/mcp-config'
import { buildMcpExecutionSnapshot, type McpExecutionSnapshot } from '../main/mcp-execution-trust'
import type { ProviderId } from '../shared/provider'

// Aligns with `run-admission.ts:199` (pi skips repo MCP execution authorization).
const TRUST_GATE_PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'antigravity'])
const MAX_PREPARED_ENTRIES = 4_096
const MAX_CONTEXT_CACHE = 256

interface CachedTrustSnapshot {
  providerId: ProviderId
  cwd: string
  fingerprint: string
  errors: string[]
  /** Set only when a target used bare PATH lookup; absolute commands do not invalidate on PATH warm-up. */
  pathUsed: string | null
  /** Candidate config paths & resolved executables + dual link/target stat stamps. */
  stamps: Map<string, string>
}

interface PreparedTrustEntry {
  providerId: ProviderId
  cwd: string
  fingerprint: string
  errors: string[]
  stamps: Map<string, string>
}

/**
 * Records BOTH symlink metadata (`lstatSync`) AND resolved target metadata (`realpathSync` + `statSync`)
 * so modifying a symlink target in place OR retargeting/breaking a symlink always invalidates the cache
 * (W9 Round-3 Must-Fix 3).
 */
export function fileStatStamp(filePath: string): string {
  try {
    const link = lstatSync(filePath)
    const linkPart = `L:${link.dev}:${link.ino}:${link.size}:${link.mtimeMs}:${link.ctimeMs}:${link.mode}`
    if (!link.isSymbolicLink()) return linkPart
    const target = statSync(filePath)
    const real = realpathSync(filePath)
    return `${linkPart}|T:${real}:${target.dev}:${target.ino}:${target.size}:${target.mtimeMs}:${target.ctimeMs}:${target.mode}`
  } catch {
    return 'missing'
  }
}

function extractExecutablePaths(snapshot: McpExecutionSnapshot, cwd: string): string[] {
  const paths: string[] = []
  for (const target of snapshot.targets) {
    const cmd = typeof target.config.command === 'string' ? target.config.command.trim() : ''
    if (cmd) {
      if (isAbsolute(cmd)) paths.push(cmd)
      else if (cmd.includes('/') || cmd.includes('\\')) paths.push(resolve(cwd, cmd))
    }
    const id = target.executableIdentity ?? ''
    if (id.startsWith('unverified:') || id.startsWith('blocked:')) {
      const candidate = id.slice(id.indexOf(':') + 1)
      if (isAbsolute(candidate)) paths.push(candidate)
    }
  }
  return paths
}

function collectStamps(
  providerId: ProviderId,
  cwd: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
  executablePaths: Iterable<string>
): Map<string, string> {
  const stamps = new Map<string, string>()
  for (const configPath of providerMcpConfigPaths(providerId, cwd, homeDir, env)) {
    stamps.set(configPath, fileStatStamp(configPath))
  }
  for (const execPath of executablePaths) {
    if (execPath) stamps.set(execPath, fileStatStamp(execPath))
  }
  return stamps
}

function stampsMatchCurrent(
  cached: Map<string, string>,
  providerId: ProviderId,
  cwd: string,
  homeDir: string,
  env: NodeJS.ProcessEnv
): boolean {
  const candidateConfigs = providerMcpConfigPaths(providerId, cwd, homeDir, env)
  for (const configPath of candidateConfigs) {
    if (!cached.has(configPath)) return false
  }
  for (const [path, expected] of cached) {
    if (fileStatStamp(path) !== expected) return false
  }
  return true
}

function canonicalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * Aligns P4-2 `beforeDispatch` MCP trust gate with `run-admission.ts` / `bootstrap/trust.ts`:
 * - Skips `pi` (`run-admission.ts:199`) and uses `shellEnv()` (`bootstrap/trust.ts:203`).
 * - Caches verified MCP snapshots ACROSS runs keyed by `(providerId, canonicalCwd, settingSources, PATH)`
 *   validated by dual `lstatSync` + `statSync`/`realpathSync` stamps on every candidate config file and
 *   executable binary (W9 Round-3 Must-Fixes 2 & 3). Unchanged configs/executables skip redundant SHA-256
 *   hashing (~0.2 ms instead of ~92 ms for a 125 MB binary); any config, symlink, target, or executable
 *   change immediately misses the cache, re-hashes, and fails closed.
 */
export class AuthorityMcpTrustGate {
  readonly #contextCache = new Map<string, CachedTrustSnapshot>()
  readonly #prepared = new Map<string, PreparedTrustEntry>()
  readonly #buildSnapshot: typeof buildMcpExecutionSnapshot
  #rehashCount = 0

  constructor(options?: { buildSnapshot?: typeof buildMcpExecutionSnapshot }) {
    this.#buildSnapshot = options?.buildSnapshot ?? buildMcpExecutionSnapshot
    // Eagerly warm login-shell PATH so PATH-resolved MCP commands don't miss cache on run #2.
    void warmShellEnv()
  }

  /** Test/diagnostic counter: how many times full SHA-256 snapshot hashing actually ran. */
  rehashCount(): number {
    return this.#rehashCount
  }

  #resolveOrBuild(
    providerId: ProviderId,
    rawCwd: string
  ): { ok: true; entry: CachedTrustSnapshot } | { ok: false; detail: string } {
    const cwd = canonicalizeCwd(rawCwd)
    const env = shellEnv()
    const homeDir = homedir()
    const settingSources = providerId === 'claude' ? (env.SCRY_CLAUDE_SETTING_SOURCES ?? '') : ''
    const cacheKey = `${providerId}\0${cwd}\0${settingSources}`
    const cached = this.#contextCache.get(cacheKey)
    if (
      cached &&
      (cached.pathUsed === null || cached.pathUsed === (env.PATH ?? '')) &&
      stampsMatchCurrent(cached.stamps, providerId, cwd, homeDir, env)
    ) {
      return { ok: true, entry: cached }
    }

    try {
      this.#rehashCount += 1
      const snapshot = this.#buildSnapshot({
        providerId,
        cwd,
        homeDir,
        settingSources: providerId === 'claude' ? env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
        env
      })
      const stamps = collectStamps(providerId, cwd, homeDir, env, extractExecutablePaths(snapshot, cwd))
      const hasUnverifiedBareCmd = snapshot.targets.some((t) => {
        const id = t.executableIdentity ?? ''
        return id.startsWith('unverified:') && !id.slice('unverified:'.length).includes('/')
      })
      const entry: CachedTrustSnapshot = {
        providerId,
        cwd,
        fingerprint: snapshot.fingerprint,
        errors: snapshot.errors,
        pathUsed: hasUnverifiedBareCmd ? (env.PATH ?? '') : null,
        stamps
      }
      this.#contextCache.delete(cacheKey)
      this.#contextCache.set(cacheKey, entry)
      while (this.#contextCache.size > MAX_CONTEXT_CACHE) {
        const oldest = this.#contextCache.keys().next().value
        if (oldest === undefined) break
        this.#contextCache.delete(oldest)
      }
      return { ok: true, entry }
    } catch (error) {
      this.#contextCache.delete(cacheKey)
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  #rememberPrepared(runId: string, entry: CachedTrustSnapshot): void {
    this.#prepared.delete(runId)
    this.#prepared.set(runId, {
      providerId: entry.providerId,
      cwd: entry.cwd,
      fingerprint: entry.fingerprint,
      errors: entry.errors,
      stamps: entry.stamps
    })
    while (this.#prepared.size > MAX_PREPARED_ENTRIES) {
      const oldest = this.#prepared.keys().next().value
      if (oldest === undefined) break
      this.#prepared.delete(oldest)
    }
  }

  prepare(runId: string, provider: string | null | undefined, cwd: string | null | undefined): void {
    const providerId = (provider ?? '') as ProviderId
    if (!cwd || !TRUST_GATE_PROVIDERS.has(providerId)) return
    const resolved = this.#resolveOrBuild(providerId, cwd)
    if (resolved.ok) this.#rememberPrepared(runId, resolved.entry)
    else this.#prepared.delete(runId)
  }

  prepareAndVerify(
    runId: string,
    provider: string | null | undefined,
    cwd: string | null | undefined
  ): { ok: true } | { ok: false; detail: string } {
    const providerId = (provider ?? '') as ProviderId
    if (!cwd || !TRUST_GATE_PROVIDERS.has(providerId)) return { ok: true }
    const resolved = this.#resolveOrBuild(providerId, cwd)
    if (!resolved.ok) {
      this.#prepared.delete(runId)
      return resolved
    }
    this.#rememberPrepared(runId, resolved.entry)
    if (resolved.entry.errors.length > 0) {
      return { ok: false, detail: `MCP 配置无法安全执行：${resolved.entry.errors.join('；')}` }
    }
    return { ok: true }
  }

  verify(
    runId: string,
    provider: string | null | undefined,
    cwd: string | null | undefined
  ): { ok: true } | { ok: false; detail: string } {
    const providerId = (provider ?? '') as ProviderId
    if (!cwd || !TRUST_GATE_PROVIDERS.has(providerId)) return { ok: true }
    const canonicalCwd = canonicalizeCwd(cwd)
    const prepared = this.#prepared.get(runId)
    const resolved = this.#resolveOrBuild(providerId, canonicalCwd)
    if (!resolved.ok) return resolved
    if (resolved.entry.errors.length > 0) {
      return { ok: false, detail: `MCP 配置无法安全执行：${resolved.entry.errors.join('；')}` }
    }
    if (
      prepared &&
      prepared.providerId === providerId &&
      prepared.cwd === canonicalCwd &&
      resolved.entry.fingerprint !== prepared.fingerprint
    ) {
      return { ok: false, detail: 'MCP 配置在授权后发生变化，已拒绝执行' }
    }
    return { ok: true }
  }

  delete(runId: string): void {
    this.#prepared.delete(runId)
  }
}
