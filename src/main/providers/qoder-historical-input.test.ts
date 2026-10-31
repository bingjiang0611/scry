import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInputReceipt } from './types'
import type { TraceEvent } from '../../shared/trace'

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  spawn: vi.fn(),
  getSessionMessages: vi.fn(),
  forkSession: vi.fn(),
  runtimeCliEnv: vi.fn(() => ({}))
}))

vi.mock('node:child_process', () => ({ spawn: sdk.spawn }))
vi.mock('../process-diagnostics', async () => {
  const actual = await vi.importActual<typeof import('../process-diagnostics')>('../process-diagnostics')
  return { ...actual, captureProcessIdentity: vi.fn(async () => undefined), signalProcessTreeWithIdentity: vi.fn() }
})
vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({ type: 'qodercli' }),
  query: sdk.query,
  getSessionMessages: sdk.getSessionMessages,
  forkSession: sdk.forkSession
}))
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/qodercli',
  runtimeCliEnv: sdk.runtimeCliEnv,
  shellEnv: () => ({})
}))

import { createQoderAdapter } from './qoder'

const cwd = process.cwd()
const historyText = 'prior conversation summary'
const contentHash = createHash('sha256').update(historyText).digest('hex')
const PREFIX = `[Scry historical context: prior conversation, not a new command]\n${historyText}\n[End historical context]\n\n[Current user request]\n`

interface Submitted {
  uuid: string
  text: string
}

/** Captures the one user message the adapter hands to the SDK input stream. */
function captureSubmitted(): { submitted: Submitted; promise: Promise<Submitted> } {
  const submitted = { uuid: '', text: '' }
  let resolve: (value: Submitted) => void = () => {}
  const promise = new Promise<Submitted>((done) => {
    resolve = done
  })
  sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    void (async () => {
      for await (const message of prompt) {
        const content = (message.message as { content?: Array<{ text?: string }> }).content
        submitted.uuid = String(message.uuid ?? '')
        submitted.text = content?.[0]?.text ?? ''
        resolve({ ...submitted })
        break
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', session_id: 'qoder-session-1' }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }
  })
  return { submitted, promise }
}

function startRun(emitted: TraceEvent[], overrides: Record<string, unknown> = {}) {
  const adapter = createQoderAdapter()
  return adapter.run({
    runId: 'run-historical-input',
    prompt: 'next step',
    cwd,
    attachments: [],
    permissionMode: 'default',
    historicalContext: { text: historyText, contentHash },
    trackInputReceipt: true,
    emit: (event: TraceEvent) => emitted.push(event),
    ...overrides
  } as never)
}

function receiptOf(emitted: TraceEvent[]): ProviderInputReceipt | undefined {
  const receipts = emitted
    .filter((event) => event.stage === 'runtime:historical_input' || event.stage === 'runtime:input_receipt')
    .map((event) => event.runtimeMetadata?.inputReceipt as ProviderInputReceipt | undefined)
  return receipts.at(-1)
}

describe('Qoder managed historical input', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.spawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() }))
    sdk.getSessionMessages.mockResolvedValue([])
  })

  it('submits the frozen history prefix plus the new prompt with a run-owned UUID', async () => {
    const { promise } = captureSubmitted()
    const handle = startRun([])

    const submitted = await promise
    expect(submitted.text).toBe(`${PREFIX}next step`)
    expect(submitted.uuid).toMatch(/^[0-9a-f-]{36}$/)
    await handle.promise
  })

  it('accepts the input only when the transcript persists the same UUID, session and text', async () => {
    const { promise } = captureSubmitted()
    const emitted: TraceEvent[] = []
    const handle = startRun(emitted)
    const submitted = await promise
    sdk.getSessionMessages.mockResolvedValue([
      { uuid: submitted.uuid, type: 'user', session_id: 'qoder-session-1', message: { role: 'user', content: [{ type: 'text', text: submitted.text }] } }
    ])

    await handle.promise

    expect(handle.getInputReceipt?.()).toEqual(expect.objectContaining({
      status: 'accepted',
      nativeSessionId: 'qoder-session-1',
      source: 'qoder_transcript_user_uuid'
    }))
    expect(receiptOf(emitted)?.status).toBe('accepted')
  })

  it.each([
    ['a different UUID', (uuid: string) => ({ uuid: `${uuid}-other` })],
    ['a different text', () => ({ text: 'other prompt' })]
  ])('keeps the receipt unknown when the transcript persisted %s', async (_label, mutate) => {
    const { promise } = captureSubmitted()
    const handle = startRun([])
    const submitted = await promise
    const mutation = mutate(submitted.uuid) as { uuid?: string; text?: string }
    sdk.getSessionMessages.mockResolvedValue([
      {
        uuid: mutation.uuid ?? submitted.uuid,
        type: 'user',
        session_id: 'qoder-session-1',
        message: { role: 'user', content: [{ type: 'text', text: mutation.text ?? submitted.text }] }
      }
    ])

    await handle.promise

    expect(handle.getInputReceipt?.()).toEqual(expect.objectContaining({ status: 'unknown' }))
  })

  it('keeps the receipt unknown when the transcript cannot be read after a dispatch', async () => {
    const { promise } = captureSubmitted()
    const handle = startRun([])
    await promise
    sdk.getSessionMessages.mockRejectedValue(new Error('transcript unavailable'))

    await handle.promise

    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
  })

  it('keeps the receipt unknown when the run throws after the input was attempted', async () => {
    let attempted = false
    sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => ({
      async *[Symbol.asyncIterator]() {
        for await (const _message of prompt) {
          attempted = true
          break
        }
        throw new Error('Qoder transport failed')
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const handle = startRun([])

    await expect(handle.promise).rejects.toThrow()
    expect(attempted).toBe(true)
    const receipt = handle.getInputReceipt?.()
    expect(receipt?.status).toBe('unknown')
  })

  // Changed deliberately: the previous expectation treated the turn outcome as the
  // input receipt. The native `user` message with the run-owned UUID and the exact
  // text proves Qoder received this input; `error_during_execution` is a separate
  // outcome fact and must not turn verified acceptance into `unknown`.
  it('accepts a matching transcript even when the turn ended in a Provider error', async () => {
    let submitted: Submitted | undefined
    sdk.getSessionMessages.mockImplementation(async () => submitted
      ? [{ uuid: submitted.uuid, type: 'user', session_id: 'qoder-session-1', message: { role: 'user', content: [{ type: 'text', text: submitted.text }] } }]
      : [])
    sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
      void (async () => {
        for await (const message of prompt) {
          const content = (message.message as { content?: Array<{ text?: string }> }).content
          submitted = { uuid: String(message.uuid ?? ''), text: content?.[0]?.text ?? '' }
          break
        }
      })()
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'qoder-session-1' }
        },
        close: vi.fn().mockResolvedValue(undefined),
        interrupt: vi.fn().mockResolvedValue(undefined)
      }
    })
    const handle = startRun([])

    // The run outcome stays a failure: acceptance never relabels a failed turn.
    await expect(handle.promise).resolves.toMatchObject({ status: 'failed' })
    expect(handle.getInputReceipt?.()).toEqual(expect.objectContaining({
      status: 'accepted',
      nativeSessionId: 'qoder-session-1',
      source: 'qoder_transcript_user_uuid'
    }))
  })

  it('keeps the receipt unknown when a failed turn has no matching transcript identity', async () => {
    let submitted: Submitted | undefined
    sdk.getSessionMessages.mockImplementation(async () => submitted
      ? [{ uuid: `${submitted.uuid}-other`, type: 'user', session_id: 'qoder-session-1', message: { role: 'user', content: [{ type: 'text', text: submitted.text }] } }]
      : [])
    sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
      void (async () => {
        for await (const message of prompt) {
          const content = (message.message as { content?: Array<{ text?: string }> }).content
          submitted = { uuid: String(message.uuid ?? ''), text: content?.[0]?.text ?? '' }
          break
        }
      })()
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'qoder-session-1' }
        },
        close: vi.fn().mockResolvedValue(undefined),
        interrupt: vi.fn().mockResolvedValue(undefined)
      }
    })
    const handle = startRun([])

    await expect(handle.promise).resolves.toMatchObject({ status: 'failed' })
    expect(handle.getInputReceipt?.()).toEqual(expect.objectContaining({ status: 'unknown' }))
  })

  it('rejects a slash prompt with managed history before any native dispatch', async () => {
    const emitted: TraceEvent[] = []
    const handle = startRun(emitted, { prompt: '/rate-workflow 1' })

    await expect(handle.promise).rejects.toThrow('原生斜杠命令不能作为可验证的普通会话输入')
    expect(sdk.query).not.toHaveBeenCalled()
    expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
    expect(emitted).toEqual([])
  })

  it('rejects a mismatched input hash before any native dispatch', async () => {
    const handle = startRun([], { expectedInputTextHash: 'deadbeef' })

    await expect(handle.promise).rejects.toThrow('原生输入需要改写原文')
    expect(sdk.query).not.toHaveBeenCalled()
  })

  it('rejects history that exceeds the target model budget before any native dispatch', async () => {
    const handle = startRun([], {
      historyBudget: { modelContextWindow: 1_000 },
      model: { id: 'gpt-5', providerId: 'openai' }
    })

    await expect(handle.promise).rejects.toThrow()
    expect(sdk.query).not.toHaveBeenCalled()
  })

  it('fails closed when the native continuation identity changed before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-qoder-identity-'))
    const previous = { binary: process.env.SCRY_QODERCLI_PATH }
    try {
      const home = join(root, 'home')
      // The SDK launch resolves auth from the CLI's own root: <QODER_CLI_HOME|home>/.qoder.
      const config = join(home, '.qoder')
      const binary = join(root, 'qodercli')
      await mkdir(join(config, '.auth'), { recursive: true })
      await writeFile(join(config, '.auth', 'user'), 'auth-material')
      await writeFile(binary, '#!/usr/bin/env node\n')
      await chmod(binary, 0o755)
      process.env.SCRY_QODERCLI_PATH = binary
      const adapter = createQoderAdapter(home)
      const handle = adapter.run({
        runId: 'run-stale-identity',
        prompt: 'next step',
        cwd,
        attachments: [],
        historicalContext: { text: historyText, contentHash },
        trackInputReceipt: true,
        expectedContinuationKey: 'qoder:stale-identity',
        emit: () => {}
      } as never)

      await expect(handle.promise).rejects.toThrow('接续身份已变化')
      expect(sdk.query).not.toHaveBeenCalled()
      expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
    } finally {
      if (previous.binary === undefined) delete process.env.SCRY_QODERCLI_PATH
      else process.env.SCRY_QODERCLI_PATH = previous.binary
      await rm(root, { recursive: true, force: true })
    }
  })
})
