import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Provider project settings files that can alter tool permissions or hooks (P6 security §S3,
 * verified in P6-0 Probe 7). Included in the extended repo-config fingerprint for agent runs.
 */
export const PROVIDER_PROJECT_SETTINGS_FILES: Readonly<Record<string, readonly string[]>> = {
  claude: ['.claude/settings.json', '.claude/settings.local.json'],
  qoder: ['.qoder/settings.json', '.qoder/settings.local.json'],
  codex: ['.codex/config.toml', '.codex/hooks.json']
}

function canonicalPath(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

function hashFileState(fullPath: string): string {
  try {
    const stat = lstatSync(fullPath)
    if (stat.isSymbolicLink()) {
      const target = realpathSync(fullPath)
      const content = readFileSync(target)
      return createHash('sha256').update('symlink\0').update(target).update('\0').update(content).digest('hex')
    }
    if (!stat.isFile()) return 'non_file'
    const content = readFileSync(fullPath)
    return createHash('sha256').update('file\0').update(content).digest('hex')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return 'absent'
    return `err:${code ?? 'unknown'}`
  }
}

/**
 * Extended repo-config fingerprint for P6 agent-initiated runs (D15 / security §S3):
 * combines the existing MCP/Hook/plugin execution trust fingerprint with provider project
 * setting files in the canonical cwd.
 */
export function computeExtendedRepoConfigFingerprint(
  provider: string,
  cwd: string,
  baseTrustFingerprint: string
): string {
  const canonical = canonicalPath(cwd)
  const files = PROVIDER_PROJECT_SETTINGS_FILES[provider] ?? []
  const h = createHash('sha256')
  h.update(`v1\0${provider}\0${canonical}\0${baseTrustFingerprint}\0`)
  for (const rel of files) {
    h.update(`${rel}=${hashFileState(join(canonical, rel))}\0`)
  }
  return h.digest('hex')
}

export type AgentBaselineVerification =
  | { ok: true }
  | {
      ok: false
      code: 'trust_gate_rejected'
      reason: 'no_user_run_baseline' | 'repo_config_changed_since_user_run'
      detail: string
    }

/**
 * In-memory daemon baseline keyed by `(provider, canonicalCwd)` (security §S3).
 * Intentionally non-persistent so daemon restarts clear all agent baselines until the user
 * personally runs that provider in that workspace again.
 */
export class AgentRepoBaselineStore {
  readonly #baselines = new Map<string, { fingerprint: string; recordedAt: number }>()

  private key(provider: string, cwd: string): string {
    return `${provider}\0${canonicalPath(cwd)}`
  }

  recordUserRun(provider: string, cwd: string, extendedFingerprint: string, at = Date.now()): void {
    this.#baselines.set(this.key(provider, cwd), { fingerprint: extendedFingerprint, recordedAt: at })
  }

  getBaseline(provider: string, cwd: string): { fingerprint: string; recordedAt: number } | undefined {
    return this.#baselines.get(this.key(provider, cwd))
  }

  verifyAgentRun(provider: string, cwd: string, currentExtendedFingerprint: string): AgentBaselineVerification {
    const baseline = this.#baselines.get(this.key(provider, cwd))
    if (!baseline) {
      return {
        ok: false,
        code: 'trust_gate_rejected',
        reason: 'no_user_run_baseline',
        detail: 'No user-initiated run baseline exists for this provider and workspace since daemon start'
      }
    }
    if (baseline.fingerprint !== currentExtendedFingerprint) {
      return {
        ok: false,
        code: 'trust_gate_rejected',
        reason: 'repo_config_changed_since_user_run',
        detail: 'Repository MCP/Hook/plugin or provider project settings changed since the last user run (including scry init); run once as user to re-establish baseline'
      }
    }
    return { ok: true }
  }

  clear(): void {
    this.#baselines.clear()
  }
}
