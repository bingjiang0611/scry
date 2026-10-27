import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type PiRunDiagnosticPhase =
  | 'profile_lookup' | 'environment' | 'pool_lookup' | 'initial_state' | 'setup'
  | 'prompt_response' | 'user_entry' | 'agent_settlement' | 'final_state'
  | 'rpc_cleanup' | 'provider_returned' | 'provider_rejected'
  | 'main_preparing' | 'main_registration' | 'main_registered'
  | 'main_finalization' | 'main_settlement' | 'main_settled'

export type PiRunDiagnosticDetails = {
  rpcPid?: number
  agentStarted?: boolean
  agentEnded?: boolean
  agentSettled?: boolean
  lastNativeLifecycle?: 'agent_start' | 'agent_end' | 'agent_settled'
  lastNativeLifecycleAt?: string
  nativeIdle?: boolean
  backgroundPending?: boolean
  stopRequested?: boolean
  providerStatus?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  mainDone?: boolean
  mainSettled?: boolean
}

type Snapshot = PiRunDiagnosticDetails & {
  runId: string
  phase: PiRunDiagnosticPhase
  updatedAt: string
  history: Array<{ phase: PiRunDiagnosticPhase; at: string }>
}

/** Stage-only troubleshooting evidence, not an authority for run completion.
 * No prompts, paths, RPC payloads, stderr or credentials enter this file.
 * Retain the latest 64 runs and 16 phase changes each; old/missing runs are an
 * evidence gap, never proof of settlement. Writes coalesce off the send path.
 */
export class PiRunDiagnostics {
  private readonly runs = new Map<string, Snapshot>()
  private readonly startedAt = new Date().toISOString()
  private dirty = false
  private directoryReady = false
  private pending?: Promise<void>

  constructor(private readonly path: string) {}

  record(runId: string, phase: PiRunDiagnosticPhase, details: PiRunDiagnosticDetails = {}): void {
    const previous = this.runs.get(runId)
    const at = new Date().toISOString()
    const history = previous?.history ?? []
    this.runs.delete(runId)
    this.runs.set(runId, {
      ...previous, ...details, runId, phase, updatedAt: at,
      history: previous?.phase === phase ? history : [...history, { phase, at }].slice(-16)
    })
    if (this.runs.size > 64) this.runs.delete(this.runs.keys().next().value!)
    this.dirty = true
    this.schedule()
  }

  private schedule(): void {
    if (this.pending) return
    this.pending = this.persist().catch((error: unknown) => {
      // Observation must not block or change Provider execution. Do not retry a
      // failed write; a later diagnostic update can attempt a fresh snapshot.
      this.dirty = false
      console.warn('[scry] Pi run diagnostics unavailable:', error)
    }).finally(() => {
      this.pending = undefined
      if (this.dirty) this.schedule()
    })
  }

  private async persist(): Promise<void> {
    if (!this.directoryReady) {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      this.directoryReady = true
    }
    while (this.dirty) {
      this.dirty = false
      const data = JSON.stringify({
        schemaVersion: 1, appPid: process.pid, startedAt: this.startedAt,
        coverage: 'partial', maxRuns: 64, maxPhaseChanges: 16,
        runs: [...this.runs.values()]
      })
      await writeFile(`${this.path}.tmp`, data, { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
    }
  }

  async flush(): Promise<void> {
    while (this.pending) await this.pending
  }
}
