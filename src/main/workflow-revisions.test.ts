import { readFile, rm, symlink, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { WorkflowDispatch } from './workflow-runner'

import { assertWorkflowRecovery } from './workflow-recovery'

import { call, revision, approval, changedB, fixture } from './workflow-revision.fixture'

describe('same-root frozen revision admission and static dependency reuse', () => {
  it('runs only changed B and its actual consumer D, preserving A/C facts, history and root budget', async () => {
    const f = await fixture(true)
    try {
      await f.start()
      const old = await f.record(), next = changedB(f.preview)
      expect(await f.revise(next)).toMatchObject({ state: 'completed', dispatchAttempts: 6 })
      const current = await f.record()
      expect(f.calls.map(call => call.node).sort()).toEqual(['a', 'b', 'b', 'c', 'd', 'd'])
      expect(f.calls.filter(call => call.node === 'd')[1].prompt).toContain('b-v2-output')
      expect(current.intents.slice(0, old.intents.length)).toEqual(old.intents)
      expect(current.outcomes.slice(0, old.outcomes.length)).toEqual(old.outcomes)
      expect(current.revisions?.map(value => value.preview.programRevision)).toEqual([f.preview.programRevision, next.programRevision])
      expect(current.revisions?.[0].approval).toEqual(approval(f.preview))
      expect(current.revisions?.[1].reuse.map(value => value.nodeId).sort()).toEqual(['a', 'c'])
      for (const outcome of old.outcomes) expect(await f.store.loadOutput(f.preview.workflowId, outcome)).toBeDefined()
      assertWorkflowRecovery(current, current.execution!.owner.instanceId)
      const target = { expectedRevision: old.progress.revision! }
      expect((await f.makeService().revise(next, approval(next), target, 'revise')).dispatchAttempts).toBe(6)
      expect(f.execute).toHaveBeenCalledTimes(6)
    } finally { await f.cleanup() }
  })

  it('keeps removed successful nodes readable under their original governing program', async () => {
    const f = await fixture(true)
    try {
      await f.start()
      const old = await f.record(), removed = old.outcomes.find(value => value.nodeId === 'c')!
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence' || root.blocks[0].kind !== 'parallel') throw new Error('fixture shape')
        root.blocks[0].blocks = root.blocks[0].blocks.filter(block => block.blockId !== 'c')
      })
      expect((await f.revise(next)).dispatchAttempts).toBe(4)
      const current = await f.record()
      assertWorkflowRecovery(current, current.execution!.owner.instanceId)
      expect(current.outcomes.find(value => value.attemptId === removed.attemptId)).toEqual(removed)
      expect(await f.store.loadOutput(next.workflowId, removed)).toBe('c-output')
    } finally { await f.cleanup() }
  })

  it('does not invalidate siblings merely because their launch order changes', async () => {
    const f = await fixture()
    try {
      await f.start()
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence' || root.blocks[0].kind !== 'parallel') throw new Error('fixture shape')
        root.blocks[0].blocks.reverse()
      })
      expect((await f.revise(next)).dispatchAttempts).toBe(4)
      expect(f.execute).toHaveBeenCalledTimes(4)
      expect((await f.record()).revisions?.at(-1)?.reuse).toHaveLength(4)
    } finally { await f.cleanup() }
  })

  it('invalidates bind-expression consumers transitively without affecting an unrelated sibling', async () => {
    const f = await fixture()
    try {
      await f.start()
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence') throw new Error('fixture shape')
        root.blocks.splice(1, 0, { kind: 'bind', blockId: 'derived', value: { kind: 'literal', value: 'new-effective-input' } })
        root.blocks[2] = { ...call('d', 'derived') }
      })
      expect((await f.revise(next)).dispatchAttempts).toBe(5)
      expect(f.calls.filter(call => call.node === 'd')[1].prompt).toContain('new-effective-input')
      expect((await f.record()).revisions?.at(-1)?.reuse.map(value => value.nodeId).sort()).toEqual(['a', 'b', 'c'])
    } finally { await f.cleanup() }
  })

  it.each(['source-change', 'missing-observation', 'runtime-change'] as const)('does not reuse with %s', async reason => {
    const f = await fixture(false, reason !== 'missing-observation')
    try {
      await f.start()
      if (reason === 'source-change') await writeFile(join(f.workspace, 'input.txt'), 'changed')
      const roles = f.preview.program.roles.map(role => reason === 'runtime-change' ? { ...role, runtimeIdentity: 'new-runtime' } : role)
      const next = revision(changedB(f.preview), () => undefined, roles)
      expect((await f.revise(next, 'changed', reason === 'runtime-change' ? f.makeService('new-runtime') : f.service)).dispatchAttempts).toBe(8)
      expect((await f.record()).revisions?.at(-1)?.reuse).toEqual([])
    } finally { await f.cleanup() }
  })

  it('does not reuse a successful call which changed the observed workspace', async () => {
    const f = await fixture()
    try {
      const implementation = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => {
        const result = implementation(request)
        return { ...result, result: result.result.then(async value => { await writeFile(join(f.workspace, 'input.txt'), randomUUID()); return value }) }
      })
      await f.start()
      f.execute.mockImplementation(implementation)
      expect((await f.revise(changedB(f.preview))).dispatchAttempts).toBe(8)
      expect((await f.record()).revisions?.at(-1)?.reuse).toEqual([])
    } finally { await f.cleanup() }
  })

  it('does not reuse a writing call even when its after snapshot is still the current workspace', async () => {
    const f = await fixture(false, true, true)
    try {
      const implementation = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => {
        const result = implementation(request)
        return { ...result, result: result.result.then(async value => {
          if (request.taskId.endsWith(':a')) await writeFile(join(f.workspace, 'input.txt'), 'candidate')
          return value
        }) }
      })
      await f.start()
      f.execute.mockImplementation(implementation)
      expect((await f.revise(changedB(f.preview))).dispatchAttempts).toBe(7)
      expect(f.calls.filter(call => call.node === 'a')).toHaveLength(2)
      expect((await f.record()).revisions?.at(-1)?.reuse.map(entry => entry.nodeId)).toEqual(['c'])
    } finally { await f.cleanup() }
  })

  it.each(['unknown', 'unsettled', 'intent-only'] as const)('rejects old %s even when its node is removed by the new program', async state => {
    const f = await fixture()
    try {
      await f.start()
      const current = await f.record(), outcome = current.outcomes.find(value => value.nodeId === 'a')!
      if (state === 'unknown') outcome.state = 'unknown'
      else if (state === 'unsettled') {
        outcome.settled = false
        current.stopRequests = [{ commandId: 'persisted-stop-ack', requestedAt: 1 }]
      }
      else current.outcomes = current.outcomes.filter(value => value !== outcome)
      await f.store.save(current)
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence' || root.blocks[0].kind !== 'parallel') throw new Error('fixture shape')
        root.blocks[0].blocks = root.blocks[0].blocks.filter(value => value.blockId !== 'a')
      })
      await expect(f.revise(next)).rejects.toThrow()
      expect(f.execute).toHaveBeenCalledTimes(4)
      expect((await f.record()).execution?.segments).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  it('accepts only one concurrent CAS claim and deduplicates a cold command without dispatch', async () => {
    const f = await fixture(true)
    try {
      await f.start()
      const target = { expectedRevision: (await f.record()).progress.revision! }, next = changedB(f.preview)
      const controllers = [f.makeService(), f.makeService()]
      const results = await Promise.allSettled(controllers.map((service, index) => service.revise(next, approval(next), target, 'race-' + index)))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      const current = await f.record(), winner = current.execution!.segments.at(-1)!.commandId!
      expect(current.execution?.segments).toHaveLength(2)
      expect(f.execute).toHaveBeenCalledTimes(6)
      await f.makeService().revise(next, approval(next), target, winner)
      expect(f.execute).toHaveBeenCalledTimes(6)
    } finally { await f.cleanup() }
  })

  it('rejects stale revision, mismatched approval and tampered frozen program before dispatch', async () => {
    const f = await fixture()
    try {
      await f.start()
      const next = changedB(f.preview), target = { expectedRevision: (await f.record()).progress.revision! }
      await expect(f.service.revise(next, approval(next), { expectedRevision: target.expectedRevision - 1 }, 'stale')).rejects.toThrow()
      await expect(f.service.revise(next, approval(f.preview), target, 'wrong-approval')).rejects.toThrow()
      const tampered = structuredClone(next)
      tampered.program.userGoal = 'unapproved-goal'
      await expect(f.service.revise(tampered, approval(next), target, 'tampered')).rejects.toThrow()
      expect(f.execute).toHaveBeenCalledTimes(4)
    } finally { await f.cleanup() }
  })

  it.each(['missing', 'tampered'] as const)('rejects %s immutable governing revision artifacts without recreating history', async fault => {
    const f = await fixture(true)
    try {
      await f.start()
      await f.revise(changedB(f.preview))
      const root = JSON.parse(await readFile(join(f.directory, 'userData', 'workflows', f.preview.workflowId + '.json'), 'utf8'))
      expect(root.revisions[0].preview).toBeUndefined()
      const artifact = join(f.directory, 'userData', 'workflows', root.revisions[0].reference)
      if (fault === 'missing') await rm(artifact)
      else await writeFile(artifact, (await readFile(artifact, 'utf8')) + ' ')
      await expect(f.store.load(f.preview.workflowId)).rejects.toThrow()
      await expect(f.makeService().snapshot(f.preview.workflowId)).rejects.toThrow()
      expect(f.execute).toHaveBeenCalledTimes(6)
    } finally { await f.cleanup() }
  })

  it('does not block ordinary execution when automatic observations are unavailable', async () => {
    const f = await fixture()
    try {
      const outside = join(f.directory, 'outside.txt')
      await writeFile(outside, 'outside workspace')
      await symlink(outside, join(f.workspace, 'outside-link'))
      expect((await f.start()).state).toBe('completed')
      const old = await f.record()
      expect(Object.values(old.agentInputs ?? {}).every(inputs => inputs.before.state === 'unavailable')).toBe(true)
      expect((await f.revise(changedB(f.preview))).dispatchAttempts).toBe(8)
      expect((await f.record()).revisions?.at(-1)?.reuse).toEqual([])
    } finally { await f.cleanup() }
  })

  it('accepts a new pure map without redispatching unrelated historical calls', async () => {
    const f = await fixture()
    try {
      await f.start()
      const next = revision(f.preview, root => {
        if (root.kind !== 'sequence') throw new Error('fixture shape')
        root.blocks.splice(1, 0, { kind: 'map', blockId: 'dynamic', items: { kind: 'literal', value: [{ id: 'x' }] }, item: 'entry', key: ['id'], maxItems: 1,
          body: { kind: 'bind', blockId: 'mappedValue', value: { kind: 'literal', value: 'x' } } })
      })
      expect(await f.revise(next)).toMatchObject({ state: 'completed', dispatchAttempts: 4 })
      expect(f.execute).toHaveBeenCalledTimes(4)
      expect((await f.record()).execution?.segments).toHaveLength(2)
    } finally { await f.cleanup() }
  })

  it('retains the six-attempt logical ceiling inside the new revision and the original root budget', async () => {
    const f = await fixture()
    try {
      const original = f.execute.getMockImplementation()!
      f.execute.mockImplementation(request => request.taskId.endsWith(':b') ? {
        result: Promise.reject(new WorkflowDispatch().rejected(new Error('fixture pre-Provider refusal'))), stop: () => true
      } : original(request))
      expect((await f.start()).state).toBe('failed')
      const next = changedB(f.preview)
      expect((await f.revise(next)).dispatchAttempts).toBe(4)
      for (let attempt = 2; attempt <= 6; attempt++) {
        const current = await f.record(), failed = [...current.outcomes].reverse().find(value => value.nodeId === 'b')!
        await f.service.approve(approval(next))
        await f.service.retry(next.workflowId, approval(next), { taskId: failed.taskId, attemptId: failed.attemptId, expectedRevision: current.progress.revision! }, 'retry-new-' + attempt)
      }
      const current = await f.record(), failed = [...current.outcomes].reverse().find(value => value.nodeId === 'b')!
      expect(current.progress.dispatchAttempts).toBe(9)
      expect(current.intents.filter(intent => intent.taskId === failed.taskId)).toHaveLength(6)
      await f.service.approve(approval(next))
      await expect(f.service.retry(next.workflowId, approval(next), { taskId: failed.taskId, attemptId: failed.attemptId, expectedRevision: current.progress.revision! }, 'retry-new-7')).rejects.toThrow()
      expect((await f.record()).progress.dispatchAttempts).toBe(9)
    } finally { await f.cleanup() }
  })

  it('keeps the root 1000-intent ceiling across a new revision (ledger boundary fixture)', async () => {
    const f = await fixture()
    try {
      await f.start()
      const current = await f.record(), base = current.intents[0], outcome = current.outcomes.find(value => value.attemptId === base.attemptId)!
      // Structurally valid, settled pre-Provider reservations model consumed
      // root capacity, not real calls or usage. No fabricated success evidence.
      for (let index = current.intents.length; index < 1000; index++) {
        const attemptId = 'reserved-' + index, taskId = `${f.preview.workflowId}:${createHash('sha256').update(String(index)).digest('hex')}:${outcome.nodeId}`
        current.intents.push({ ...base, attemptId, taskId })
        current.outcomes.push({ ...outcome, attemptId, taskId, state: 'failed', providerDispatch: 'not_attempted', output: undefined, outputRef: undefined, actualModel: undefined, actualModelStatus: 'unknown' })
      }
      current.progress.dispatchAttempts = 1000
      await f.store.save(current)
      const result = await f.revise(changedB(f.preview))
      expect(result.dispatchAttempts).toBe(1000)
      expect(result.state).not.toBe('completed')
      expect(f.execute).toHaveBeenCalledTimes(4)
      expect((await f.record()).intents).toHaveLength(1000)
    } finally { await f.cleanup() }
  })
})
