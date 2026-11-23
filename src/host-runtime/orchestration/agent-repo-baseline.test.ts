import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentRepoBaselineStore,
  computeExtendedRepoConfigFingerprint
} from './agent-repo-baseline'

describe('P6-1 Agent repo-config baseline & extended fingerprint (security §S3)', () => {
  it('fails closed when no user run baseline exists and passes once user runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-p6-baseline-'))
    try {
      const store = new AgentRepoBaselineStore()
      const fp1 = computeExtendedRepoConfigFingerprint('qoder', dir, 'base-trust-fp-1')
      expect(store.verifyAgentRun('qoder', dir, fp1)).toMatchObject({
        ok: false,
        code: 'trust_gate_rejected',
        reason: 'no_user_run_baseline'
      })

      store.recordUserRun('qoder', dir, fp1)
      expect(store.verifyAgentRun('qoder', dir, fp1)).toEqual({ ok: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects provider project setting mutations (e.g. .qoder/settings.json or scry init) and recovers after next user run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-p6-baseline-mut-'))
    try {
      const store = new AgentRepoBaselineStore()
      const fpBefore = computeExtendedRepoConfigFingerprint('qoder', dir, 'trust-fp')
      store.recordUserRun('qoder', dir, fpBefore)
      expect(store.verifyAgentRun('qoder', dir, fpBefore)).toEqual({ ok: true })

      // Agent modifies .qoder/settings.json to pre-allow tools
      mkdirSync(join(dir, '.qoder'), { recursive: true })
      writeFileSync(join(dir, '.qoder', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__scry_orchestrator__*'] } }))

      const fpAfter = computeExtendedRepoConfigFingerprint('qoder', dir, 'trust-fp')
      expect(fpAfter).not.toBe(fpBefore)
      expect(store.verifyAgentRun('qoder', dir, fpAfter)).toMatchObject({
        ok: false,
        code: 'trust_gate_rejected',
        reason: 'repo_config_changed_since_user_run'
      })

      // User runs once -> baseline updated -> agent run allowed again
      store.recordUserRun('qoder', dir, fpAfter)
      expect(store.verifyAgentRun('qoder', dir, fpAfter)).toEqual({ ok: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('isolates baselines by (provider, canonicalCwd) and clears on restart (new store)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-p6-baseline-iso-'))
    try {
      const store = new AgentRepoBaselineStore()
      const codexFp = computeExtendedRepoConfigFingerprint('codex', dir, 'trust-fp')
      store.recordUserRun('codex', dir, codexFp)

      const qoderFp = computeExtendedRepoConfigFingerprint('qoder', dir, 'trust-fp')
      expect(store.verifyAgentRun('qoder', dir, qoderFp)).toMatchObject({
        ok: false,
        code: 'trust_gate_rejected',
        reason: 'no_user_run_baseline'
      })

      // Simulated daemon restart
      const freshStore = new AgentRepoBaselineStore()
      expect(freshStore.verifyAgentRun('codex', dir, codexFp)).toMatchObject({
        ok: false,
        code: 'trust_gate_rejected',
        reason: 'no_user_run_baseline'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
