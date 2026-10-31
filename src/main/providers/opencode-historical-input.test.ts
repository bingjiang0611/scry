import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import type { ProviderInputReceipt } from './types'

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/opencode',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import { runOpenCode } from './opencode-run'
import type { OpenCodeServerPool } from './opencode-server-pool'

const cwd = process.cwd()
const historyText = 'prior conversation summary'
const contentHash = createHash('sha256').update(historyText).digest('hex')
const PREFIX = `[Scry historical context: prior conversation, not a new command]\n${historyText}\n[End historical context]\n\n[Current user request]\n`

interface SentPrompt {
  text: string
  sessionID: string
}

/**
 * Minimal canonical-response fake: one server per cwd, one session, one prompt.
 * `messages` is what OpenCode would have persisted for the session.
 */
function fakePool(options: {
  sent: SentPrompt[]
  messages: () => Array<{ info?: unknown; parts?: unknown }>
  promptError?: Error
}): OpenCodeServerPool {
  const client = {
    session: {
      create: async () => ({ id: 'ses-1' }),
      update: async () => ({}),
      abort: async () => true,
      messages: async () => options.messages(),
      prompt: async ({ parts }: { sessionID: string; parts: Array<{ type: string; text?: string }> }) => {
        options.sent.push({ text: parts[0]?.text ?? '', sessionID: 'ses-1' })
        if (options.promptError) throw options.promptError
        return { data: { info: { id: 'msg-assistant-1', role: 'assistant', parentID: 'msg-user-1' }, parts: [] } }
      }
    },
    event: {
      subscribe: async () => ({ stream: (async function* () {})() })
    }
  }
  const pool = {
    lease: () => ({ release: () => {}, forceClose: () => {} }),
    serverFor: async () => ({ client, hookTracePath: undefined }),
    withClient: async (_context: unknown, _execution: unknown, action: (c: unknown) => Promise<unknown>) => action(client),
    recordOk: () => {},
    recordFailure: () => {},
    diagnosticHandle: () => undefined,
    authManager: () => { throw new Error('not used') },
    releaseManager: async () => {},
    dispose: async () => {},
    closed: false
  }
  return pool as unknown as OpenCodeServerPool
}

function start(pool: OpenCodeServerPool, overrides: Record<string, unknown> = {}) {
  const emitted: TraceEvent[] = []
  const handle = runOpenCode({
    runId: 'run-opencode-input',
    prompt: 'next step',
    cwd,
    attachments: [],
    permissionMode: 'default',
    historicalContext: { text: historyText, contentHash },
    trackInputReceipt: true,
    emit: (event: TraceEvent) => emitted.push(event),
    ...overrides
  } as never, {
    pool,
    identity: { homeDir: cwd, executable: '/bin/opencode' }
  })
  const receipts = (): Array<ProviderInputReceipt | undefined> => emitted
    .filter((event) => event.stage === 'runtime:historical_input' || event.stage === 'runtime:input_receipt')
    .map((event) => event.runtimeMetadata?.inputReceipt as ProviderInputReceipt | undefined)
  return { handle, emitted, lastReceipt: () => receipts().at(-1) }
}

const persistedUser = (text: string, id = 'msg-user-1') => [
  { info: { id, role: 'user' }, parts: [{ type: 'text', text }] },
  { info: { id: 'msg-assistant-1', role: 'assistant', parentID: id }, parts: [] }
]

describe('OpenCode managed historical input', () => {
  it('sends the frozen history prefix plus the new prompt as the final prompt text', async () => {
    const sent: SentPrompt[] = []
    const { handle } = start(fakePool({ sent, messages: () => persistedUser(`${PREFIX}next step`) }))

    await handle.promise

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ text: `${PREFIX}next step`, sessionID: 'ses-1' })
  })

  it('accepts only the persisted parent user message with the exact submitted text', async () => {
    const sent: SentPrompt[] = []
    const { handle, lastReceipt } = start(fakePool({ sent, messages: () => persistedUser(`${PREFIX}next step`) }))

    await handle.promise

    expect(lastReceipt()).toEqual(expect.objectContaining({
      status: 'accepted',
      nativeSessionId: 'ses-1',
      source: 'opencode_prompt_user_message',
      providerTurnId: 'msg-user-1'
    }))
    expect(handle.getInputReceipt?.()).toEqual(lastReceipt())
  })

  it('keeps the receipt unknown when the persisted user text differs', async () => {
    const sent: SentPrompt[] = []
    const { handle } = start(fakePool({ sent, messages: () => persistedUser('other prompt') }))

    await handle.promise

    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
  })

  it('accepts the input when a bounded snapshot page still contains the exact parent user message', async () => {
    const sent: SentPrompt[] = []
    // A full 1000-row page is bounded, so the snapshot cannot claim complete history.
    const bounded = Array.from({ length: 1_000 }, (_, index) => index === 0
      ? persistedUser(`${PREFIX}next step`)[0]
      : { info: { id: `msg-old-${index}`, role: 'user' }, parts: [{ type: 'text', text: `older ${index}` }] })
    const { handle, lastReceipt } = start(fakePool({ sent, messages: () => bounded }))

    await handle.promise

    // The canonical parentID plus the exact submitted text prove this one input even
    // though the page omits other rows; that is not a claim about complete history.
    expect(lastReceipt()).toEqual(expect.objectContaining({
      status: 'accepted',
      nativeSessionId: 'ses-1',
      source: 'opencode_prompt_user_message',
      providerTurnId: 'msg-user-1'
    }))
  })

  it('keeps the receipt unknown when a bounded snapshot page omits the parent user message', async () => {
    const sent: SentPrompt[] = []
    const bounded = Array.from({ length: 1_000 }, (_, index) => ({
      info: { id: `msg-old-${index}`, role: 'user' }, parts: [{ type: 'text', text: `older ${index}` }]
    }))
    const { handle, lastReceipt } = start(fakePool({ sent, messages: () => bounded }))

    await handle.promise

    expect(sent).toHaveLength(1)
    expect(lastReceipt()).toEqual(expect.objectContaining({
      status: 'unknown',
      reason: 'OpenCode 有界权威消息页未包含与本次投递一致的 user 消息'
    }))
  })

  it('keeps the receipt unknown when a successful prompt left no persisted user message', async () => {
    const sent: SentPrompt[] = []
    const { handle } = start(fakePool({ sent, messages: () => [] }))

    await handle.promise

    expect(sent).toHaveLength(1)
    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
  })

  it('keeps the receipt unknown when the prompt fails after the input was attempted', async () => {
    const sent: SentPrompt[] = []
    const { handle } = start(fakePool({
      sent,
      messages: () => persistedUser(`${PREFIX}next step`),
      promptError: new Error('opencode transport failed')
    }))

    await expect(handle.promise).rejects.toThrow()
    expect(sent).toHaveLength(1)
    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
  })

  it('rejects a slash prompt with managed history before the prompt call', async () => {
    const sent: SentPrompt[] = []
    const { handle } = start(fakePool({ sent, messages: () => [] }), { prompt: '/rate-workflow 1' })

    await expect(handle.promise).rejects.toThrow('原生斜杠命令不能作为可验证的普通会话输入')
    expect(sent).toEqual([])
    expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
  })

  it('rejects history beyond the target model budget before the prompt call', async () => {
    const sent: SentPrompt[] = []
    const { handle } = start(fakePool({ sent, messages: () => [] }), {
      historyBudget: { modelContextWindow: 1_000 }
    })

    await expect(handle.promise).rejects.toThrow('最终历史输入超出目标模型预算')
    expect(sent).toEqual([])
    expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
  })

  it('fails closed when the native continuation identity changed before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-identity-'))
    const executable = join(root, 'opencode')
    try {
      await writeFile(executable, '#!/bin/sh\n')
      await chmod(executable, 0o755)
      // The launch environment is mocked to an empty env: absent auth is a supported
      // anonymous start, so the identity is computable and the stale key is refused.
      const sent: SentPrompt[] = []
      const emitted: TraceEvent[] = []
      const handle = runOpenCode({
        runId: 'run-stale-identity',
        prompt: 'next step',
        cwd,
        attachments: [],
        historicalContext: { text: historyText, contentHash },
        trackInputReceipt: true,
        expectedContinuationKey: 'opencode:stale-identity',
        emit: (event: TraceEvent) => emitted.push(event)
      } as never, { pool: fakePool({ sent, messages: () => [] }), identity: { homeDir: cwd, executable } })

      await expect(handle.promise).rejects.toThrow('接续身份已变化')
      expect(sent).toEqual([])
      expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps two independent sessions isolated', async () => {
    const first: SentPrompt[] = []
    const second: SentPrompt[] = []
    const a = start(fakePool({ sent: first, messages: () => persistedUser(`${PREFIX}next step`) }))
    const b = start(fakePool({ sent: second, messages: () => persistedUser('other prompt') }))

    await Promise.all([a.handle.promise, b.handle.promise])

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(a.handle.getInputReceipt?.()?.status).toBe('accepted')
    expect(b.handle.getInputReceipt?.()?.status).toBe('unknown')
  })
})
