import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder'
import { listRecords, verifyStore } from './store'
import { summarizeTurnRecords } from './turns-summary'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Qoder credits canonical recording', () => {
  it.each(['missing', 'ambiguous'])('does not infer billing identity when hook/native identity is %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'scry-credit-identity-'))
    roots.push(root)
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture', capture: { diff: false } }))
    const transcript = join(root, 'native.jsonl')
    await writeFile(transcript, '')
    const payload = { session_id: 'session', transcript_path: transcript, cwd: root, timestamp: '2026-09-09T00:00:00.000Z',
      ...(mode === 'ambiguous' ? { promptId: 'p' } : {}) }
    await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: { ...payload, prompt: 'same text' } })
    const rows: unknown[] = [{ type: 'user', uuid: 'u', promptId: 'p', message: { content: 'same text' } },
      { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { id: 'm', content: [{ type: 'text', text: 'done' }],
        usage: { request_id: 'r', credits: 10, billable: true } } }]
    if (mode === 'ambiguous') rows.push({ type: 'user', uuid: 'duplicate', promptId: 'p', message: { content: 'same text' } })
    await writeFile(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    await handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root,
      payload: { ...payload, timestamp: '2026-09-09T00:00:01.000Z' } })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].usage.value?.credits).toMatchObject({ status: 'unavailable', value: { knownRequests: 0 } })
    expect(records[0].usage.value?.credits?.value?.amount).toBeUndefined()
  })

  it('records native discounted requests once, survives reread, and summarizes zero/unknown/legacy separately from USD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-canonical-credits-'))
    roots.push(root)
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture', capture: { diff: false } }))
    const transcript = join(root, 'native.jsonl')
    await writeFile(transcript, '')
    const rows: unknown[] = []
    for (let index = 1; index <= 3; index++) {
      const promptId = `p${index}`
      const timestamp = `2026-09-09T00:00:0${index * 2}.000Z`
      const payload = { session_id: 'session', promptId, transcript_path: transcript, cwd: root, timestamp }
      await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: { ...payload, prompt: 'same text' } })
      rows.push({ type: 'user', uuid: `u${index}`, sessionId: 'session', cwd: root, promptId, timestamp, message: { content: 'same text' } })
      const usage = index === 1 ? { credits: 2.5, original_credits: 9, billable: true }
        : index === 2 ? { credits: 9, billable: false } : { original_credits: 10, billable: true }
      const assistant = { type: 'assistant', uuid: `a${index}`, parentUuid: `u${index}`, sessionId: 'session', cwd: root,
        timestamp, message: { id: `m${index}`, content: [{ type: 'text', text: 'done' }],
          usage: { ...usage, request_id: `r${index}`, input_tokens: 4, output_tokens: 1 } } }
      rows.push(assistant, { ...assistant, uuid: `block${index}` })
      rows.push({ type: 'result', total_credits: 9999 })
      await writeFile(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
      const stop = { provider: 'qoder' as const, event: 'Stop', workspace: root, payload: { ...payload, timestamp: `2026-09-09T00:00:0${index * 2 + 1}.000Z` } }
      await handleRecorderHook(stop)
      await handleRecorderHook(stop)
    }
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(3)
    expect(records.map((record) => record.usage.value?.credits?.value?.amount)).toEqual([2.5, 0, undefined])
    expect(records[0].usage.value).toMatchObject({ inputTokens: 4, outputTokens: 1, credits: {
      status: 'partial', quality: 'exact', source: ['qoder_native_transcript'],
      value: { provider: 'qoder', unit: 'credits', scope: 'main', amount: 2.5, knownRequests: 1, missingRequests: 0 }
    } })
    expect(records[0].usage.value?.costUsd).toBeUndefined()
    expect(records[2].usage.value?.credits).toMatchObject({ status: 'unavailable', value: { knownRequests: 0, missingRequests: 1 } })
    const legacy = { ...records[0], recordId: 'legacy', sequence: 4, usage: { status: 'available' as const, quality: 'exact' as const, source: ['legacy'], value: { inputTokens: 1 } } }
    const summary = summarizeTurnRecords([...records, legacy])
    expect(summary.usage.costUsd).toBeNull()
    expect(summary.usage.credits).toMatchObject({ amount: 2.5, unit: 'credits', status: 'partial', knownRequests: 2, missingRequests: 1,
      coverage: { knownTurns: 2, totalTurns: 4, complete: false } })
    expect(await verifyStore(join(root, '.scry'))).toMatchObject({ ok: true })
    expect((await readFile(transcript, 'utf8')).includes('9999')).toBe(true)
  })
})
