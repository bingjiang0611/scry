import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore } from './workflow-store'
import { observeWorkflowAgentInputs, reusableWorkflowAgentInputs } from './workflow-agent-inputs'
import { captureWorkflowInputs, saveWorkflowInputSnapshot } from './workflow-input-snapshot'
import { workflowSystemArtifactKey } from './workflow-system-ledger'

const execute = promisify(execFile)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-agent-observation-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'input.txt'), 'same bytes')
  return { root, workspace, store: new MemoryWorkflowStore(), cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('Agent repository evidence bound into manifest headers', () => {
  it('keeps per-phase source association without writing a second source artifact', async () => {
    const f = await fixture()
    try {
      const save = vi.spyOn(f.store, 'saveValue')
      const before = await observeWorkflowAgentInputs(f.store, 'root', 'old', f.workspace, 'before', () => ({}))
      const after = await observeWorkflowAgentInputs(f.store, 'root', 'old', f.workspace, 'after', () => ({}))
      const current = await observeWorkflowAgentInputs(f.store, 'root', 'current', f.workspace, 'before', () => ({}))
      expect(await reusableWorkflowAgentInputs(f.store, 'root', 'old', { before, after }, current)).toBe(true)
      expect(save.mock.calls.map(args => args[1])).not.toContain(workflowSystemArtifactKey('old', 'agent-source-before'))
      if (before.state !== 'available') throw new Error('missing before')
      expect(before.snapshot.repositorySource).toEqual({ kind: 'non_repository' })
      const altered = structuredClone(before)
      altered.snapshot.repositorySource = { kind: 'repository', root: f.workspace, head: 'a'.repeat(40) }
      await expect(reusableWorkflowAgentInputs(f.store, 'root', 'old', { before: altered, after }, current)).rejects.toThrow()
    } finally { await f.cleanup() }
  })

  it('reads original separate-source records but rejects a foreign phase reference', async () => {
    const f = await fixture()
    try {
      const captured = await captureWorkflowInputs(f.workspace, () => false)
      const old = async (phase: 'before' | 'after') => ({ state: 'available' as const,
        snapshot: await saveWorkflowInputSnapshot(f.store, 'root', 'old', phase, captured),
        sourceRef: await f.store.saveValue('root', workflowSystemArtifactKey('old', 'agent-source-' + phase), { state: 'known', value: { kind: 'non_repository' }, derivedFrom: [] }) })
      const before = await old('before'), after = await old('after')
      const current = await observeWorkflowAgentInputs(f.store, 'root', 'current', f.workspace, 'before', () => ({}))
      expect(await reusableWorkflowAgentInputs(f.store, 'root', 'old', { before, after }, current)).toBe(true)
      await expect(reusableWorkflowAgentInputs(f.store, 'root', 'old', { before: { ...before, sourceRef: after.sourceRef }, after }, current)).rejects.toThrow()
    } finally { await f.cleanup() }
  })

  it('does not reuse equal workspace bytes across a changed Git HEAD', async () => {
    const f = await fixture()
    const env = { PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(f.root, 'gitconfig') }
    const git = (args: string[]) => execute('git', args, { cwd: f.workspace, env })
    try {
      await writeFile(env.GIT_CONFIG_GLOBAL, '')
      await git(['init', '--template=', '--initial-branch=main'])
      const commit = (message: string) => git(['-c', 'user.name=bingjiang0611', '-c', 'user.email=307659028+bingjiang0611@users.noreply.github.com', 'commit', '--allow-empty', '-m', message])
      await commit('before')
      const before = await observeWorkflowAgentInputs(f.store, 'root', 'old', f.workspace, 'before', () => env)
      await commit('after')
      const after = await observeWorkflowAgentInputs(f.store, 'root', 'old', f.workspace, 'after', () => env)
      const current = await observeWorkflowAgentInputs(f.store, 'root', 'current', f.workspace, 'before', () => env)
      if (before.state !== 'available' || after.state !== 'available') throw new Error('missing Git evidence')
      expect(before.snapshot.inputHash).toBe(after.snapshot.inputHash)
      expect(before.snapshot.repositorySource).not.toEqual(after.snapshot.repositorySource)
      expect(await reusableWorkflowAgentInputs(f.store, 'root', 'old', { before, after }, current)).toBe(false)
    } finally { await f.cleanup() }
  })
})
