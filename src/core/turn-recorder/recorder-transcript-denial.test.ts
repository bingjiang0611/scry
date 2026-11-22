import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRecorderHook } from './recorder'
import { recorderInboxEntries } from './inbox'
import { listRecords } from './store'
import { recorderSessionRoot } from './runtime-state'

const denial = vi.hoisted(() => ({ failures: new Map<string, number>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      const target = typeof path === 'string' ? path : ''
      const remaining = denial.failures.get(target) ?? 0
      if (remaining > 0) {
        denial.failures.set(target, remaining - 1)
        throw Object.assign(
          new Error(`EPERM: operation not permitted, open '${target}'`),
          { code: 'EPERM', syscall: 'open', path: target }
        )
      }
      return (actual.open as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.open
  }
})

const roots: string[] = []
afterEach(async () => {
  denial.failures.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'scry-transcript-denial-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'test', capture: { diff: false } }))
  return { root, transcript: join(root, 'qoder-session.jsonl') }
}

function rows(sessionId: string, cwd: string, promptId: string, requestSetId: string, prompt: string, toolUseId: string) {
  return [
    { sessionId, cwd, type: 'user', uuid: `${promptId}-user`, promptId, requestSetId, message: { role: 'user', content: prompt } },
    {
      sessionId, cwd, type: 'assistant', uuid: `${promptId}-call`, parentUuid: `${promptId}-user`, promptId,
      message: { id: `${toolUseId}-message`, content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: `${promptId}.txt` } }] }
    },
    {
      sessionId, cwd, type: 'user', uuid: `${promptId}-result`, parentUuid: `${promptId}-call`, promptId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `${promptId} read` }] }
    },
    {
      sessionId, cwd, type: 'assistant', uuid: `${promptId}-answer`, parentUuid: `${promptId}-result`, promptId,
      message: { id: `${promptId}-answer-message`, content: [{ type: 'text', text: `${promptId} answer` }], usage: { input_tokens: 3, output_tokens: 2 } }
    }
  ]
}

describe('a denied transcript read while the next prompt arrives', () => {
  it('seals the previous turn on lifecycle evidence and opens the next turn instead of losing it', async () => {
    const { root, transcript } = await workspace()
    const sessionId = 'qoder-denied-read'
    const base = { session_id: sessionId, cwd: root, transcript_path: transcript }

    expect(await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R1', prompt: 'first prompt', timestamp: '2026-11-15T16:20:05.000Z'
    } })).toMatchObject({ status: 'started' })
    await writeFile(transcript, jsonl(rows(sessionId, root, 'P1', 'R1', 'first prompt', 'tool-1')))

    denial.failures.set(transcript, Number.POSITIVE_INFINITY)
    const secondStart = await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R2', prompt: 'second prompt', timestamp: '2026-11-15T16:31:45.000Z'
    } })
    expect(secondStart).toMatchObject({ status: 'started' })

    denial.failures.clear()
    await writeFile(transcript, jsonl(rows(sessionId, root, 'P2', 'R2', 'second prompt', 'tool-2')), { flag: 'a' })
    const pre = await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'PreToolUse:Read', payload: {
      ...base, parent_request_set_id: 'R2', tool_name: 'Read', tool_use_id: 'tool-2', tool_input: { file_path: 'P2.txt' },
      timestamp: '2026-11-15T16:31:50.000Z'
    } })
    expect(pre).toMatchObject({ status: 'recorded' })
    expect(await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'Stop', payload: {
      ...base, parent_request_set_id: 'R2', assistant_response: 'P2 answer', timestamp: '2026-11-15T16:32:00.000Z'
    } })).toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(2)
    const [sealed, second] = records
    expect(sealed.status).toBe('interrupted')
    expect(sealed.generation).toBe(1)
    expect(sealed.user.value?.text).toBe('first prompt')
    expect(sealed.assistant.status).toBe('unavailable')
    expect(sealed.transcript?.status).toBe('unavailable')
    expect(sealed.transcript?.omissionReason).toMatch(/EPERM: operation not permitted, open '.*qoder-session\.jsonl'/)
    expect(sealed.transcript?.omissionReason).toContain('lifecycle evidence')
    expect(sealed.termination.value?.reason).toBe('superseded_by_next_turn')

    expect(second.status).toBe('completed')
    expect(second.generation).toBe(2)
    expect(second.user.value?.text).toBe('second prompt')
    expect(second.assistant.value?.text).toBe('P2 answer')
    expect(second.tools.value?.map(tool => tool.id)).toContain('tool-2')
    expect(second.tools.value?.map(tool => tool.id)).not.toContain('tool-1')
    expect(sealed.tools.value?.map(tool => tool.id) ?? []).not.toContain('tool-2')

    const inbox = await recorderInboxEntries(recorderSessionRoot(join(root, '.scry'), 'qoder', sessionId))
    expect(inbox).toEqual([])
  })

  it('records the failed path, operation and stack so the denial can be located later', async () => {
    const { root, transcript } = await workspace()
    const sessionId = 'qoder-denied-read-log'
    const base = { session_id: sessionId, cwd: root, transcript_path: transcript }
    await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R1', prompt: 'first prompt', timestamp: '2026-11-15T16:20:05.000Z'
    } })
    await writeFile(transcript, jsonl(rows(sessionId, root, 'P1', 'R1', 'first prompt', 'tool-1')))
    denial.failures.set(transcript, Number.POSITIVE_INFINITY)
    await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R2', prompt: 'second prompt', timestamp: '2026-11-15T16:31:45.000Z'
    } })

    const log = await readFile(join(root, '.scry', 'logs', 'recorder.log'), 'utf8')
    const failure = log.split('\n').find(line => line.includes('sealing on lifecycle evidence')) ?? ''
    expect(failure).toContain('EPERM: operation not permitted')
    expect(failure).toContain(transcript)
    expect(failure).toContain('[open ')
    expect(failure).toMatch(/\| at /)
  })

  it('absorbs a single denial through the retry policy and publishes the previous turn normally', async () => {
    const { root, transcript } = await workspace()
    const sessionId = 'qoder-transient-denial'
    const base = { session_id: sessionId, cwd: root, transcript_path: transcript }
    await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R1', prompt: 'first prompt', timestamp: '2026-11-15T16:20:05.000Z'
    } })
    await writeFile(transcript, jsonl(rows(sessionId, root, 'P1', 'R1', 'first prompt', 'tool-1')))
    denial.failures.set(transcript, 1)
    expect(await handleRecorderHook({ provider: 'qoder', workspace: root, event: 'UserPromptSubmit', payload: {
      ...base, request_set_id: 'R2', prompt: 'second prompt', timestamp: '2026-11-15T16:31:45.000Z'
    } })).toMatchObject({ status: 'started' })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('interrupted')
    expect(records[0].assistant.status).toBe('available')
    expect(records[0].assistant.value?.text).toBe('P1 answer')
    expect(records[0].tools.omissionReason).toBeUndefined()
  })
})
