import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { runNativeRevision } from '../../scripts/fixtures/workflow-native-recovery-process'
import type { WorkflowPlanPreview } from '../shared/workflow'
import { workflowFrameCopy } from '../shared/constants/copy'
import { effects, launch, roots } from './workflow-recovery-process.fixture'
import { workflowFrameId } from './workflow-frames'
import { FileWorkflowStore } from './workflow-store'
import { valueName } from './workflow-store-artifacts'
import { WorkflowSystemHost } from './workflow-system-host'

const modes = ['native-revision-crash', 'native-revision-resume'] as const satisfies readonly Parameters<typeof runNativeRevision>[1][]

describe('same-root native revision across real controller processes, no account', () => {
  it.each([false, true])('recovers the sealed branch/native/child facts without redispatch; corrupted canonical bytes=%s', async corrupt => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'scry native recovery ')))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'input.txt'), 'baseline')
    await writeFile(join(workspace, 'check.cjs'), `const fs = require('node:fs');
const finish = () => {
  const n = fs.existsSync('native-count') ? Number(fs.readFileSync('native-count','utf8')) : 0;
  fs.writeFileSync('native-count', String(n+1)); console.log('checked');
};
if (process.platform === 'darwin') {
  const server = require('node:net').createServer();
  server.once('error', error => { if (error.code !== 'EPERM') throw error; fs.writeFileSync('native-network',error.code); finish(); });
  server.listen(0, '127.0.0.1', () => server.close(() => { throw new Error('check network unexpectedly allowed'); }));
} else finish();`)
    const crashed = await launch(root, modes[0])
    expect(await crashed.closed, crashed.stderr()).toEqual({ code: 73, signal: null })
    const trace = crashed.stderr().split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; code?: number })
    expect(trace.filter(item => item.event === 'native_child_close').map(item => item.code)).toEqual([0, 0])
    expect(trace.some(item => item.event === 'native_parent_checkpoint_exit')).toBe(true)

    const preview: WorkflowPlanPreview = JSON.parse(await readFile(join(root, 'preview.json'), 'utf8'))
    const store = new FileWorkflowStore(root), before = (await store.load(preview.workflowId))!
    const segment = before.execution!.segments.at(-1)!, scope = ['revision:' + preview.programRevision]
    const marker: { pid: number; frameId: string } = JSON.parse(await readFile(join(root, 'native-checkpoint.json'), 'utf8'))
    expect(before.execution!.owner).toMatchObject({ pid: marker.pid, state: 'active' })
    expect(before.execution!.segments.map(item => item.mode)).toEqual(['start', 'revision'])
    expect(before.revisions).toHaveLength(2)
    expect(before.progress).toMatchObject({ state: 'running', dispatchAttempts: 2 })
    expect(before.systemIntents).toHaveLength(2)
    expect(before.systemOutcomes!.every(item => item.state === 'completed' && item.settled)).toBe(true)
    const independent = (await store.loadFrame(preview.workflowId, workflowFrameId('independent', scope, segment.generationId)))!
    expect(independent.callReuse?.attemptId).toBe(before.intents[0].attemptId)
    const gate = (await store.loadFrame(preview.workflowId, workflowFrameId('gate', scope, segment.generationId)))!
    expect(gate.arm).toBe('then')
    const branchScope = [...scope, 'gate:then:' + gate.decisionRef!.hash]
    expect(marker.frameId).toBe(workflowFrameId('terminal-parent', branchScope, segment.generationId))
    const parent = (await store.loadFrame(preview.workflowId, marker.frameId))!
    expect(parent.phase).toBe('entered')
    expect(parent.cursor ?? 0).toBe(0)
    expect(parent.children ?? []).toEqual([])
    expect(parent.resultRef).toBeUndefined()
    const leaf = (await store.loadFrame(preview.workflowId, workflowFrameId('scoped', branchScope, segment.generationId)))!
    expect(leaf.phase).toBe('completed')
    expect(await store.loadValue(preview.workflowId, leaf.resultRef!)).toMatchObject({ state: 'known', value: 'scoped-result' })
    const preparation = before.systemIntents!.find(item => item.kind === 'prepare_replica')!
    const copy = before.systemOutcomes!.find(item => item.stepId === preparation.stepId)!
    expect((await store.loadFrame(preview.workflowId, workflowFrameId('candidate', scope, segment.generationId)))?.resultRef).toEqual(copy.resultRef)
    const host = new WorkflowSystemHost(join(root, 'replicas'), store)
    const receipt = await host.replicas.resolve(copy.replica!)
    expect(await readFile(join(receipt.directory, 'native-count'), 'utf8')).toBe('1')
    await expect(readFile(join(workspace, 'native-count'))).rejects.toHaveProperty('code', 'ENOENT')
    const firstEffects = await effects(root)
    expect(firstEffects.map(item => item.node)).toEqual(['independent', 'scoped'])
    expect(firstEffects.map(item => item.cwd)).toEqual([workspace, receipt.directory])
    if (process.platform === 'darwin') {
      expect(firstEffects.map(item => item.network)).toEqual(['EPERM', 'EPERM'])
      expect(await readFile(join(receipt.directory, 'native-network'), 'utf8')).toBe('EPERM')
      expect(JSON.parse(await readFile(join(root, 'controller-network-proof.json'), 'utf8'))).toEqual({ pid: marker.pid, network: 'EPERM' })
    }

    // Valid JSON with identical semantic data but the wrong content hash must
    // fail in the fresh process; this cannot be hidden by a warm value cache.
    if (corrupt) await appendFile(join(root, 'workflows', valueName(copy.resultRef!)), ' ', { flush: true })
    const resumed = await launch(root, modes[1])
    expect(await resumed.closed, resumed.stderr()).toEqual({ code: corrupt ? 2 : 0, signal: null })
    const after = (await new FileWorkflowStore(root).load(preview.workflowId))!
    expect(after.intents).toEqual(before.intents)
    expect(after.outcomes).toEqual(before.outcomes)
    expect(after.systemIntents).toEqual(before.systemIntents)
    expect(after.systemOutcomes).toEqual(before.systemOutcomes)
    expect(after.progress.dispatchAttempts).toBe(2)
    expect(after.execution!.segments.map(item => item.mode)).toEqual(['start', 'revision', 'continue'])
    expect(after.revisions).toHaveLength(2)
    if (process.platform === 'darwin') expect(JSON.parse(await readFile(join(root, 'controller-network-proof.json'), 'utf8')).network).toBe('EPERM')
    expect(await effects(root)).toEqual(firstEffects)
    expect(await readFile(join(receipt.directory, 'native-count'), 'utf8')).toBe('1')
    expect(await store.loadFrame(preview.workflowId, marker.frameId)).toEqual(parent)
    if (corrupt) {
      expect(after.progress.state).toBe('failed')
      expect(JSON.parse(await readFile(join(root, 'result.json'), 'utf8')).error).toBe(workflowFrameCopy.digest)
    } else {
      expect(after.progress).toMatchObject({ state: 'completed', finalReport: JSON.stringify({ arm: 'then', value: 'scoped-result' }) })
      const generation = after.execution!.segments.at(-1)!.generationId
      const recoveredGate = (await store.loadFrame(preview.workflowId, workflowFrameId('gate', scope, generation)))!
      expect(recoveredGate.arm).toBe('then')
      expect(recoveredGate.decisionRef!.hash).toBe(gate.decisionRef!.hash)
      const recovered = (await store.loadFrame(preview.workflowId, workflowFrameId('terminal-parent', branchScope, generation)))!
      expect(recovered).toMatchObject({ phase: 'completed', cursor: 1 })
      expect(recovered.children).toHaveLength(1)
      expect(await store.loadValue(preview.workflowId, recovered.resultRef!)).toMatchObject({ state: 'known', value: 'scoped-result' })
    }
  })

  it('refuses a controller after its root admission has been retired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry retired controller '))
    roots.push(root)
    roots.pop()
    try {
      await expect(launch(root, modes[1])).rejects.toThrow('process fixture root admission is closed')
    } finally { roots.push(root) }
  })
})
