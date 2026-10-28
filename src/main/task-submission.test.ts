import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSendRequest } from '../shared/conversation-api'
import { ConversationStore } from './conversation-store'
import { ConversationService, type ManagedConversationStart } from './conversation-service'
import { createDesktopTaskEntry, taskWorkspaceIdentity } from './desktop-task-entry'
import { prepareTaskInput, taskSubmissionId, type TaskSubmission, type TaskCapturedContext } from './task-submission-record'
import { resolveWorkflowSize } from './workflow-size-guideline'
import { parseDesktopConversationSubmission, submitDesktopConversation } from './desktop-conversation-submission'
import { SCRY_WORKFLOW_COMMAND_ID } from '../shared/task-command'

const roots: string[] = []
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
class TestStore extends ConversationStore {
  holdAdmission(action: () => Promise<void>) { return this.admission.run('ownership', action) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-task-submission-'))
  roots.push(root)
  await mkdir(join(root, 'project'))
  const userData = join(root, 'user-data')
  const store = new TestStore(userData)
  const created = await store.create(join(root, 'project'))
  const pending: ManagedConversationStart[] = []
  let effects = 0
  let identity = 'identity-a'
  const resolveContinuationKey = async () => identity
  const service = new ConversationService({
    store, resolveContinuationKey, supportsHistoricalInput: () => true,
    startAppRun: async (_request, { managedConversation }) => {
      // Mirrors production reservation timing, not real SDK enforcement:
      // returning a runId does not wait for asynchronous Provider preparation.
      pending.push(managedConversation)
      return { runId: managedConversation.runId }
    }
  })
  const discoverCommands = vi.fn(async () => ({ providerId: 'codex' as const, cwd: created.cwd,
    mode: 'read' as const, state: 'ready' as const, data: [] }))
  const deps = { store: () => store, service: () => service, getUserData: () => userData, resolveContinuationKey, discoverCommands }
  const entry = createDesktopTaskEntry(deps)
  const request: ConversationSendRequest = {
    conversationId: created.id, expectedRevision: created.revision,
    expectedContinuationKey: identity, commandId: 'task-command-one',
    providerId: 'codex', prompt: '  original goal\n', selectedItems: [], confirmFresh: true,
    permissionMode: 'default'
  }
  const key = { conversationId: created.id, commandId: request.commandId }
  const path = (taskKey = key) => join(userData, 'conversation-submissions-v1', taskKey.conversationId, `${taskSubmissionId(taskKey)}.json`)
  async function context(): Promise<TaskCapturedContext> {
    return {
      conversationRevision: created.revision,
      target: { providerId: 'codex', continuationKey: 'identity-a' },
      workspace: { cwd: created.cwd, identity: await taskWorkspaceIdentity(created.cwd) },
      size: { state: 'available', snapshot: resolveWorkflowSize().snapshot, readAt: Date.now() }
    }
  }
  async function capture(commandId = request.commandId) {
    const next = { ...request, commandId }
    return store.captureTaskSubmission({ request: next, prepared: prepareTaskInput(next), context: await context(), ownerEpoch: 'test-owner-epoch' })
  }
  async function dispatch(index = 0) {
    const managed = pending[index]!
    try {
      await managed.beforeProviderDispatch?.(managed.runId)
      managed.onProviderDispatchAttempt?.()
      effects++
      const prepared = managed.prepareInput([])
      await managed.onTerminal({ status: 'completed',
        finalItems: [{ runId: managed.runId, itemId: 'user', contentHash: hash(prepared.prompt) }],
        receipt: { status: 'accepted', contextHash: null, textHash: prepared.inputTextHash,
          nativeSessionId: 'native-a', source: 'codex_turn_start_response' },
        archive: { sessionId: 'archive-a' }
      })
    } catch (error) {
      await managed.onTerminal({ status: 'failed', finalItems: [] })
      throw error
    }
  }
  return { root, userData, cwd: created.cwd, store, service, entry, deps, request, key, path, context, capture,
    pending, dispatch, effects: () => effects, identity: (value: string) => { identity = value } }
}

async function body(f: Awaited<ReturnType<typeof fixture>>, task: TaskSubmission) {
  const buffers: Buffer[] = []
  let offset = 0
  do {
    const page = await f.store.readTaskInputPage(task, { offset, limit: 256 * 1024 })
    buffers.push(Buffer.from(page.dataBase64, 'base64'))
    offset = page.nextOffset
    if (!page.hasMore) break
  } while (offset < task.snapshot.input.bytes)
  const bytes = Buffer.concat(buffers)
  expect(bytes.length).toBe(task.snapshot.input.bytes)
  expect(hash(bytes.toString('utf8'))).toBe(task.snapshot.input.sha256)
  return JSON.parse(bytes.toString('utf8'))
}

describe('main-owned task submissions: default-off production entry slice', () => {
  it('persists immutable raw input and branch before reservation, without claiming Provider completion', async () => {
    const f = await fixture()
    const result = await f.entry.submit(f.request)
    const task = (await f.store.readTaskSubmission(f.key))!
    expect(task.snapshot.source).toBe('desktop_conversation_send')
    expect(task.snapshot.policy).toEqual({ mode: 'off', revision: 0 })
    expect(task.state).toEqual({ kind: 'associated', branch: 'direct', ownerEpoch: task.capturedBy, runId: result.runId })
    expect((await body(f, task)).originalGoal).toBe('  original goal\n')
    expect(f.pending).toHaveLength(1)
    expect(f.effects()).toBe(0)
    expect((await f.store.findDispatch(f.key.conversationId, f.key.commandId))?.delivery.status).toBe('pending')
    // The real reservation can precede the asynchronous Provider check.
    await f.dispatch()
    expect(f.effects()).toBe(1)
    expect((await f.store.findDispatch(f.key.conversationId, f.key.commandId))?.delivery.status).toBe('accepted')
  })

  it('seals the complete Scry direct command while dispatching only its exact goal through the existing actor', async () => {
    const f = await fixture()
    const { conversationId, expectedRevision, commandId, prompt: _prompt, ...message } = f.request
    const prompt = '  /scry-workflow direct   exact goal\n'
    const request = { conversationId, expectedRevision, commandId, prompt, message, selectedCommandId: SCRY_WORKFLOW_COMMAND_ID }
    const conversation = (await f.store.read(conversationId))!
    const deps = { entry: f.entry, setSizeGuideline: vi.fn(), setWorkflowMode: vi.fn(), routeWorkflow: vi.fn(), editTemplate: vi.fn(),
      templateTasks: { captureTemplate: vi.fn(async () => { throw new Error('unexpected template capture') }) },
      editTasks: { captureEdit: vi.fn(async () => { throw new Error('unexpected edit capture') }) } }
    await expect(submitDesktopConversation(conversation, parseDesktopConversationSubmission(request), deps)).resolves.toMatchObject({ kind: 'direct' })
    const task = (await f.store.readTaskSubmission(f.key))!
    expect(await body(f, task)).toMatchObject({ originalGoal: prompt,
      command: { id: SCRY_WORKFLOW_COMMAND_ID, origin: 'scry_workflow', operation: 'direct' } })
    expect(f.pending[0].prepareInput([]).prompt).toBe('  exact goal\n')
    await f.dispatch()
    expect(f.effects()).toBe(1)
    await expect(submitDesktopConversation(conversation, parseDesktopConversationSubmission({ ...request, prompt: ` ${prompt}` }), deps)).rejects.toThrow(/原始输入/)
    expect(f.pending).toHaveLength(1)
    expect(f.deps.discoverCommands).not.toHaveBeenCalled()
    expect(deps.setSizeGuideline).not.toHaveBeenCalled()
  })

  it('coalesces concurrent duplicate commands and rejects changed input instead of caching the wrong result', async () => {
    const f = await fixture()
    const firstRead = deferred()
    const releaseRead = deferred()
    const originalRead = f.store.readTaskSubmission.bind(f.store)
    let held = false
    const read = vi.spyOn(f.store, 'readTaskSubmission').mockImplementation(async key => {
      if (!held) { held = true; firstRead.resolve(); await releaseRead.promise }
      return originalRead(key)
    })
    const first = f.entry.submit(f.request)
    await firstRead.promise
    const second = f.entry.submit({ ...f.request, confirmFresh: false })
    try {
      expect(read).toHaveBeenCalledTimes(1)
    } finally {
      releaseRead.resolve()
      await Promise.allSettled([first, second])
    }
    const results = await Promise.all([first, second])
    expect(new Set(results.map(result => result.disposition))).toEqual(new Set(['created', 'duplicate']))
    expect(results[0]!.runId).toBe(results[1]!.runId)
    const before = await readFile(f.path(), 'utf8')
    await expect(f.entry.submit({ ...f.request, prompt: 'different input' })).rejects.toThrow(/原始输入/)
    expect(await readFile(f.path(), 'utf8')).toBe(before)
    expect(f.pending).toHaveLength(1)
    await f.dispatch()
    const latest = (await f.store.read(f.key.conversationId))!
    await expect(f.entry.submit({ ...f.request, expectedRevision: latest.revision, confirmFresh: false })).resolves.toMatchObject({ disposition: 'duplicate' })
    expect(f.effects()).toBe(1)
  })

  it('does not fence an unconfirmed fresh request and allows the explicit correction with the same command', async () => {
    const f = await fixture()
    await expect(f.entry.submit({ ...f.request, confirmFresh: false })).rejects.toThrow(/明确确认/)
    expect(await f.store.readTaskSubmission(f.key)).toBeNull()
    expect(f.pending).toHaveLength(0)
    await expect(f.entry.submit(f.request)).resolves.toMatchObject({ disposition: 'created' })
    await f.dispatch()
    expect(f.effects()).toBe(1)
  })

  it('rejects forged origin, policy and callback fields before any intake IO', async () => {
    const f = await fixture()
    const read = vi.spyOn(f.store, 'readTaskSubmission')
    for (const extra of [{ source: 'human' }, { mode: 'auto' }, { beforeProviderDispatch: 'skip' }]) {
      await expect(f.entry.submit({ ...f.request, ...extra })).rejects.toThrow()
    }
    for (const prompt of ['', '  /scry-workflow run something']) await expect(f.entry.submit({ ...f.request, prompt })).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(f.pending).toHaveLength(0)
  })

  it('freezes size before the actual shared admission queue and does not retag history', async () => {
    const f = await fixture()
    const entered = deferred()
    const release = deferred()
    const captureReached = deferred()
    const held = f.store.holdAdmission(async () => { entered.resolve(); await release.promise })
    await entered.promise
    const original = f.store.captureTaskSubmission.bind(f.store)
    vi.spyOn(f.store, 'captureTaskSubmission').mockImplementation(input => {
      const pending = original(input)
      captureReached.resolve()
      return pending
    })
    const send = f.entry.submit(f.request)
    try {
      await captureReached.promise
      await mkdir(join(f.userData, 'workflows'), { recursive: true })
      await writeFile(join(f.userData, 'workflows', 'settings.json'), '{"workflowSizeGuideline":"large"}')
    } finally { release.resolve() }
    await Promise.all([held, send])
    const task = (await f.store.readTaskSubmission(f.key))!
    if (task.version !== 1) throw new Error()
    expect(task.snapshot.size).toMatchObject({ state: 'available', snapshot: { source: 'default', value: 'medium' } })
    await f.dispatch()
    const before = await readFile(f.path(), 'utf8')
    await createDesktopTaskEntry(f.deps).submit(f.request)
    expect(await readFile(f.path(), 'utf8')).toBe(before)
    expect(f.effects()).toBe(1)
  })

  it('records invalid workflow settings as unavailable while off-mode ordinary chat still runs', async () => {
    const f = await fixture()
    await mkdir(join(f.userData, 'workflows'), { recursive: true })
    await writeFile(join(f.userData, 'workflows', 'settings.json'), 'null')
    await f.entry.submit(f.request)
    const task = (await f.store.readTaskSubmission(f.key))!
    if (task.version !== 1) throw new Error()
    expect(task.snapshot.size).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('规模配置无效') })
    expect(task.snapshot.size).not.toHaveProperty('snapshot')
    await f.dispatch()
    expect(f.effects()).toBe(1)
  })

  it('rejects a late callback after an associated reservation is durably fenced and never reopens it on observation', async () => {
    const f = await fixture()
    const result = await f.entry.submit(f.request)
    const associated = (await f.store.readTaskSubmission(f.key))!
    await f.store.markTaskDispatchUnknown(f.key, associated.revision, associated.capturedBy, 'known intake fence')
    await expect(f.dispatch()).rejects.toThrow(/派发身份/)
    expect(f.effects()).toBe(0)
    const turn = (await f.store.findDispatch(f.key.conversationId, f.key.commandId))!
    expect(turn.delivery.status).toBe('not_sent')
    const observed = await createDesktopTaskEntry(f.deps).submit(f.request)
    expect(observed).toEqual({ runId: result.runId, disposition: 'duplicate' })
    expect((await f.store.readTaskSubmission(f.key))?.state).toMatchObject({ kind: 'unknown', runId: result.runId })
    expect(f.pending).toHaveLength(1)
  })

  it('revalidates workspace inode and live continuation identity before the mocked Provider boundary', async () => {
    for (const change of ['directory', 'identity'] as const) {
      const f = await fixture()
      await f.entry.submit(f.request)
      if (change === 'directory') {
        await rename(f.cwd, `${f.cwd}-old`)
        await mkdir(f.cwd)
      } else f.identity('identity-changed')
      await expect(f.dispatch()).rejects.toThrow(/工作区或 Provider 配置/)
      expect(f.effects()).toBe(0)
      expect((await f.store.findDispatch(f.key.conversationId, f.key.commandId))?.delivery.status).toBe('not_sent')
    }
  })

  it('does not replay cold captured, intent or unknown submissions without a canonical turn', async () => {
    for (const phase of ['captured', 'dispatch_intent', 'unknown'] as const) {
      const f = await fixture()
      const captured = (await f.capture()).task
      if (phase !== 'captured') {
        const claimed = await f.store.claimTaskDispatch(f.key, captured.revision, 'direct', captured.capturedBy)
        if (phase === 'unknown') await f.store.markTaskDispatchUnknown(f.key, claimed.revision, claimed.capturedBy, 'lost dispatch acknowledgement')
      }
      const before = await readFile(f.path(), 'utf8')
      await expect(f.entry.submit(f.request)).rejects.toThrow(/中断|尚未确认/)
      expect(await readFile(f.path(), 'utf8')).toBe(before)
      expect(f.pending).toHaveLength(0)
    }
  })

  it('holds a durable branch fence after a lost claim acknowledgement; no failure-cache retry can dispatch', async () => {
    const f = await fixture()
    const original = f.store.claimTaskDispatch.bind(f.store)
    vi.spyOn(f.store, 'claimTaskDispatch').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('lost claim acknowledgement')
    })
    await expect(f.entry.submit(f.request)).rejects.toThrow('lost claim acknowledgement')
    expect((await f.store.readTaskSubmission(f.key))?.state.kind).toBe('dispatch_intent')
    await expect(f.entry.submit(f.request)).rejects.toThrow(/尚未确认/)
    expect(f.pending).toHaveLength(0)
  })

  it('keeps a published association after lost acknowledgement and only observes its canonical turn on cold retry', async () => {
    const f = await fixture()
    const original = f.store.associateDirectTask.bind(f.store)
    vi.spyOn(f.store, 'associateDirectTask').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('lost association acknowledgement')
    })
    await expect(f.entry.submit(f.request)).rejects.toThrow('lost association acknowledgement')
    expect((await f.store.readTaskSubmission(f.key))?.state.kind).toBe('associated')
    await expect(createDesktopTaskEntry(f.deps).submit(f.request)).resolves.toMatchObject({ disposition: 'duplicate' })
    expect(f.pending).toHaveLength(1)
    await f.dispatch()
    expect(f.effects()).toBe(1)
  })

  it('never changes an existing branch or owner, while allowing independent submissions in the same conversation', async () => {
    const f = await fixture()
    const first = (await f.capture()).task
    const second = (await f.capture('task-command-two')).task
    const selected = await f.store.claimTaskDispatch(first, 0, 'workflow', first.capturedBy)
    await f.store.claimTaskDispatch(second, 0, 'workflow', second.capturedBy)
    await expect(f.store.claimTaskDispatch(first, selected.revision, 'direct', first.capturedBy)).rejects.toThrow(/派发路径/)
    await expect(f.store.markTaskDispatchUnknown(first, selected.revision, 'other-owner-epoch', 'wrong owner')).rejects.toThrow(/派发身份/)
    await expect(f.entry.submit(f.request)).rejects.toThrow(/派发路径/)
    expect(f.pending).toHaveLength(0)
  })

  it('does not fabricate submission, size or policy metadata for pre-upgrade durable commands', async () => {
    const f = await fixture()
    await f.service.send(f.request)
    await f.dispatch()
    await expect(f.entry.submit(f.request)).resolves.toMatchObject({ disposition: 'duplicate' })
    expect(await f.store.readTaskSubmission(f.key)).toBeNull()
    expect(f.pending).toHaveLength(1)
    expect(f.effects()).toBe(1)
  })

  it('retains a complete large goal through bounded, integrity-checked content pages and no raw image body', async () => {
    const f = await fixture()
    const goal = '原始😀'.repeat(50_000)
    const request: ConversationSendRequest = { ...f.request, prompt: goal, attachments: [{ kind: 'image', name: 'x.png', mimeType: 'image/png', size: 3, dataBase64: 'YWJj' }] }
    const task = (await f.store.captureTaskSubmission({ request, prepared: prepareTaskInput(request), context: await f.context(), ownerEpoch: 'test-owner-epoch' })).task
    expect(task.snapshot.input.bytes).toBeGreaterThan(256 * 1024)
    const saved = await body(f, task)
    expect(saved.originalGoal).toBe(goal)
    expect(saved.attachments[0]).toMatchObject({ base64TextSha256: hash('YWJj'), size: 3 })
    expect(saved.attachments[0]).not.toHaveProperty('dataBase64')
    expect(saved.attachments[0]).not.toHaveProperty('path')
    const sha = task.snapshot.input.sha256
    const content = join(f.userData, 'conversation-submissions-v1', task.conversationId, `${task.submissionId}.input`, 'content', 'sha256', sha.slice(0, 2), `${sha}.bin`)
    await writeFile(content, 'corrupt')
    await expect(f.store.readTaskInputPage(task)).rejects.toThrow(/integrity/)
    expect(f.pending).toHaveLength(0)
  })

  it('rejects corrupt metadata rather than starting again or manufacturing a default snapshot', async () => {
    const f = await fixture()
    const captured = (await f.capture()).task
    await writeFile(f.path(), JSON.stringify({ ...captured, state: { kind: 'associated', branch: 'direct', ownerEpoch: captured.capturedBy, runId: 'invented' } }))
    await expect(f.entry.submit(f.request)).rejects.toThrow(/提交记录无效/)
    expect(f.pending).toHaveLength(0)
  })
})
