import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { shellEnv } from '../main/claude-locate'
import { providerMcpConfigPaths } from '../main/mcp-config'
import { buildMcpExecutionSnapshot } from '../main/mcp-execution-trust'
import type { ProviderId } from '../shared/provider'

// Aligns with `run-admission.ts:199` (pi skips repo MCP execution authorization).
const TRUST_GATE_PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'antigravity'])
const MAX_PREPARED_ENTRIES = 4_096

interface PreparedTrustEntry {
  providerId: ProviderId
  cwd: string
  fingerprint: string
  errors: string[]
  /** Canonical config & executable paths + stat stamps observed at prepare time. */
  stamps: Map<string, string>
}

function statStamp(filePath: string): string {
  try {
    const info = lstatSync(filePath)
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`
  } catch {
    return 'missing'
  }
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
    stamps.set(configPath, existsSync(configPath) ? statStamp(configPath) : 'missing')
  }
  for (const execPath of executablePaths) {
    if (execPath) stamps.set(execPath, statStamp(execPath))
  }
  return stamps
}

function stampsMatch(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, val] of a) {
    if (b.get(key) !== val) return false
  }
  return true
}

/**
 * Aligns P4-2 `beforeDispatch` MCP trust gate with `run-admission.ts` / `bootstrap/trust.ts`:
 * - Skips `pi` (exact match with `run-admission.ts:199`)
 * - Uses `shellEnv()` (exact match with `bootstrap/trust.ts:203`)
 * - Captures prepared snapshot fingerprint at submit time and compares stat stamps on dispatch
 *   so unchanged configs avoid redundant synchronous SHA-256 hashing pre-first-token, while any
 *   config/executable mutation or post-restart dispatch re-hashes and fails closed.
 */
export class AuthorityMcpTrustGate {
  readonly #prepared = new Map<string, PreparedTrustEntry>()

  prepare(runId: string, provider: string | null | undefined, cwd: string | null | undefined): void {
    const providerId = (provider ?? '') as ProviderId
    if (!cwd || !TRUST_GATE_PROVIDERS.has(providerId)) return
    const env = shellEnv()
    const homeDir = homedir()
    try {
      const snapshot = buildMcpExecutionSnapshot({
        providerId,
        cwd,
        homeDir,
        settingSources: providerId === 'claude' ? env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
        env
      })
      const executablePaths = snapshot.targets
        .map((t) => (typeof t.config.command === 'string' ? t.config.command : ''))
        .filter((cmd) => cmd.startsWith('/'))
      const stamps = collectStamps(providerId, cwd, homeDir, env, executablePaths)
      this.#prepared.delete(runId)
      this.#prepared.set(runId, {
        providerId,
        cwd,
        fingerprint: snapshot.fingerprint,
        errors: snapshot.errors,
        stamps
      })
      while (this.#prepared.size > MAX_PREPARED_ENTRIES) {
        const oldest = this.#prepared.keys().next().value
        if (oldest === undefined) break
        this.#prepared.delete(oldest)
      }
    } catch {
      // Fail closed on verify() if prepare could not inspect cleanly.
      this.#prepared.delete(runId)
    }
  }

  verify(
    runId: string,
    provider: string | null | undefined,
    cwd: string | null | undefined
  ): { ok: true } | { ok: false; detail: string } {
    const providerId = (provider ?? '') as ProviderId
    if (!cwd || !TRUST_GATE_PROVIDERS.has(providerId)) return { ok: true }
    const env = shellEnv()
    const homeDir = homedir()
    const prepared = this.#prepared.get(runId)

    if (prepared && prepared.providerId === providerId && prepared.cwd === cwd) {
      if (prepared.errors.length > 0) {
        return { ok: false, detail: `MCP 配置无法安全执行：${prepared.errors.join('；')}` }
      }
      const currentStamps = new Map<string, string>()
      for (const path of prepared.stamps.keys()) {
        currentStamps.set(path, existsSync(path) ? statStamp(path) : 'missing')
      }
      for (const configPath of providerMcpConfigPaths(providerId, cwd, homeDir, env)) {
        if (!currentStamps.has(configPath)) {
          currentStamps.set(configPath, existsSync(configPath) ? statStamp(configPath) : 'missing')
        }
      }
      if (stampsMatch(prepared.stamps, currentStamps)) {
        return { ok: true }
      }
    }

    try {
      const verified = buildMcpExecutionSnapshot({
        providerId,
        cwd,
        homeDir,
        settingSources: providerId === 'claude' ? env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
        env
      })
      if (verified.errors.length > 0) {
        return { ok: false, detail: `MCP 配置无法安全执行：${verified.errors.join('；')}` }
      }
      if (prepared && prepared.providerId === providerId && prepared.cwd === cwd && verified.fingerprint !== prepared.fingerprint) {
        return { ok: false, detail: 'MCP 配置在授权后发生变化，已拒绝执行' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  delete(runId: string): void {
    this.#prepared.delete(runId)
  }
}
