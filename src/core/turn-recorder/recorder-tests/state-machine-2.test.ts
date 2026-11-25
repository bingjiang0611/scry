import { readdir, readFile, writeFile, appendFile, stat, rename, open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, resetTranscriptSnapshotCache, recoverRecorder, transcriptSnapshotCacheStats, readTranscriptWindow } from '../recorder'
import { listRecords, exportRecords, commitRecord } from '../store'
import { readRecorderContent } from '../content-store'
import { normalizeTurnRepositoryLocation } from '../../../shared/turn-repository-location'
import { workspace, completeTurn, payload } from './fixture.test'

export function registerSuite2(): void {


  it.each(['0.2.16', '0.2.18'])('reads legacy empty model segments from %s as partial evidence without rewriting records', async (recorderVersion) => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await completeTurn(root, 'legacy-session')
    const name = (await readdir(join(dataRoot, 'records')))[0]
    const path = join(dataRoot, 'records', name)
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    legacy.recorderVersion = recorderVersion
    legacy.modelSegments = {
      status: 'available', quality: 'exact', source: ['provider_transcript+lifecycle_hooks'],
      value: [
        { order: 1, at: '2026-01-01T00:00:00.000Z', kind: 'text', text: 'kept' },
        { order: 2, at: '2026-01-01T00:00:01.000Z', kind: 'text' }
      ]
    }
    const bytes = JSON.stringify(legacy)
    await writeFile(path, bytes)
    await completeTurn(root, 'new-session')
    const records = await listRecords(dataRoot)
    expect(records).toHaveLength(2)
    expect(records[0].modelSegments).toEqual({
      ...legacy.modelSegments,
      status: 'partial',
      value: [legacy.modelSegments.value[0]],
      omissionReason: 'legacy recorder omitted empty model segment text'
    })
    expect(records[1]).toMatchObject({ sessionId: 'new-session', turnIndex: 1 })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect((await exportRecords(dataRoot)).records[0].modelSegments?.status).toBe('partial')
    await expect(commitRecord(dataRoot, { ...legacy, recordId: 'e'.repeat(32) })).rejects.toThrow('refusing to commit invalid turn record')
    for (const invalid of [
      { ...legacy, recorderVersion: '0.2.19' },
      {
        ...legacy,
        modelSegments: {
          ...legacy.modelSegments,
          value: [legacy.modelSegments.value[0], { order: -1, at: '2026-01-01T00:00:01.000Z', kind: 'text' }]
        }
      }
    ]) {
      await writeFile(path, JSON.stringify(invalid))
      await expect(listRecords(dataRoot)).rejects.toThrow('invalid turn record')
    }
  })

  it('读得懂别的版本写的未知 omissionCodes，但提交时不许自己造一个', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await completeTurn(root, 'code-session')
    const name = (await readdir(join(dataRoot, 'records')))[0]
    const path = join(dataRoot, 'records', name)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    stored.usage = {
      status: 'unavailable',
      quality: 'unavailable',
      source: ['provider_transcript+lifecycle_hooks'],
      omissionReason: 'a newer recorder explained this gap with a code this build does not know',
      omissionCodes: ['some_future_code']
    }
    await writeFile(path, JSON.stringify(stored))
    const records = await listRecords(dataRoot)
    expect(records).toHaveLength(1)
    expect(records[0].usage.omissionCodes).toEqual(['some_future_code'])
    // Writing stays narrower than reading: the same record cannot be committed again from this build.
    await expect(commitRecord(dataRoot, { ...stored, recordId: 'a'.repeat(32) }))
      .rejects.toThrow('refusing to commit a record with codes this version must not write: some_future_code')
  })

  it('位置状态：读取容忍未知取值，写入拒绝未定义取值', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await completeTurn(root, 'status-session')
    const name = (await readdir(join(dataRoot, 'records')))[0]
    const stored = JSON.parse(await readFile(join(dataRoot, 'records', name), 'utf8'))
    const entry = { version: 1, status: 'captured', files: [], repoRoot: '/tmp/fixture-repo', beforeAt: stored.startedAt, afterAt: stored.completedAt, captureMs: 1, cleanup: 'ok' }
    const diff = { status: 'available', quality: 'exact', source: ['git'], value: [entry] }
    // A newer recorder may name a status this build does not know. Like omissionCodes, it stays a
    // readable record: the projection drops the value, and no other section is affected.
    await writeFile(join(dataRoot, 'records', name), JSON.stringify({
      ...stored,
      diff: { ...diff, value: [{ ...entry, repositoryLocation: { remoteStatus: 'mirrored', branchStatus: 'observed', commitStatus: 'observed' } }] }
    }))
    const read = await listRecords(dataRoot)
    expect(read).toHaveLength(1)
    const location = read[0].diff.value?.[0].repositoryLocation
    // Reading keeps the raw record; displaying it projects the known vocabulary and drops the rest.
    expect(location).toEqual({ remoteStatus: 'mirrored', branchStatus: 'observed', commitStatus: 'observed' })
    expect(normalizeTurnRepositoryLocation(location)).toEqual({ branchStatus: 'observed', commitStatus: 'observed' })
    // Writing is narrower: this build only emits the defined values, and a typo must not survive.
    await expect(commitRecord(dataRoot, {
      ...stored,
      recordId: 'f'.repeat(32),
      diff: { ...diff, value: [{ ...entry, repositoryLocation: { remoteStatus: 'mirrored' } }] }
    })).rejects.toThrow('refusing to commit a record with undefined repository location statuses: remoteStatus=mirrored')
    const committed = await commitRecord(dataRoot, {
      ...stored,
      recordId: '9'.repeat(32),
      diff: { ...diff, value: [{ ...entry, repositoryLocation: { remoteStatus: 'absent', branchStatus: 'detached', commitStatus: 'unavailable' } }] }
    })
    expect(committed.record.diff.value?.[0].repositoryLocation).toEqual({ remoteStatus: 'absent', branchStatus: 'detached', commitStatus: 'unavailable' })
  })

  it('已认识但本版还禁止写入的码会被提交拒绝，diff 码照常提交', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await completeTurn(root, 'code-session')
    const name = (await readdir(join(dataRoot, 'records')))[0]
    const stored = JSON.parse(await readFile(join(dataRoot, 'records', name), 'utf8'))
    await expect(commitRecord(dataRoot, {
      ...stored,
      recordId: 'b'.repeat(32),
      usage: {
        status: 'unavailable',
        quality: 'unavailable',
        source: ['provider_transcript+lifecycle_hooks'],
        omissionReason: 'usage baseline could not be proven',
        omissionCodes: ['usage_baseline_missing']
      }
    })).rejects.toThrow('refusing to commit a record with codes this version must not write: usage_baseline_missing')
    const committed = await commitRecord(dataRoot, {
      ...stored,
      recordId: 'c'.repeat(32),
      diff: {
        status: 'partial',
        quality: 'exact',
        source: ['git'],
        value: [],
        omissionReason: 'session capture started mid-turn',
        omissionCodes: ['baseline_after_turn_start']
      }
    })
    expect(committed.record.diff.omissionCodes).toEqual(['baseline_after_turn_start'])
  })

  it('大记录里的码一样会被查到：按证据段定位，没有节点预算可以提前收摊', async () => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await completeTurn(root, 'code-session')
    const name = (await readdir(join(dataRoot, 'records')))[0]
    const stored = JSON.parse(await readFile(join(dataRoot, 'records', name), 'utf8'))
    // Tens of thousands of nodes: a scan with a node or depth budget could stop before the last
    // section, so this record must be checked by position and not by walking budget.
    const tools = Array.from({ length: 3_000 }, (_, index) => ({
      name: `Bash`, id: `call-${index}`, status: 'success',
      input: { cmd: `printf ${index}` }, outputSummary: 'ok'
    }))
    const large = {
      ...stored,
      recordId: 'd'.repeat(32),
      tools: { status: 'available', quality: 'exact', source: ['provider_transcript'], value: tools },
      termination: {
        status: 'available',
        quality: 'exact',
        source: ['provider_transcript'],
        value: { reason: 'provider_terminal', completedAtSource: 'provider_transcript' }
      }
    }
    await expect(commitRecord(dataRoot, {
      ...large,
      termination: { ...large.termination, omissionReason: 'x', omissionCodes: ['usage_baseline_missing'] }
    })).rejects.toThrow('usage_baseline_missing')
    const committed = await commitRecord(dataRoot, {
      ...large,
      recordId: 'e'.repeat(32),
      errors: {
        status: 'partial', quality: 'exact', source: ['provider_transcript'], value: [],
        omissionReason: 'one error body was truncated',
        omissionCodes: ['patch_truncated']
      }
    })
    expect(committed.record.tools.value).toHaveLength(3_000)
  })

  it('大 assistant 与 reasoning 保留有界预览和可分页完整正文引用', async () => {
    const root = await workspace()
    const rollout = join(root, 'large-model-bodies.jsonl')
    const assistant = `${'回答😀'.repeat(14_000)}ASSISTANT-END`
    const reasoning = `${'思考🧠'.repeat(14_000)}REASONING-END`
    const row = (type: string, value: Record<string, unknown>) => JSON.stringify({
      timestamp: '2026-07-19T12:00:00.000Z', type, payload: value
    })
    await writeFile(rollout, `${[
      row('event_msg', { type: 'task_started', turn_id: 'large-model-turn' }),
      row('event_msg', { type: 'user_message', message: 'capture model bodies' }),
      row('response_item', { type: 'reasoning', id: 'reasoning-1', summary: [{ type: 'summary_text', text: reasoning }] }),
      row('response_item', { type: 'agent_message', id: 'assistant-1', message: assistant }),
      row('event_msg', { type: 'task_complete', turn_id: 'large-model-turn' })
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex', event: 'turn.started', workspace: root,
      payload: payload('large-model-session', { prompt: 'capture model bodies', turn_id: 'large-model-turn', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex', event: 'turn/completed', workspace: root,
      payload: payload('large-model-session', { turn_id: 'large-model-turn', rollout_path: rollout })
    })

    const [record] = await listRecords(join(root, '.scry'))
    const segments = record.modelSegments?.value ?? []
    expect(segments.map((segment) => segment.kind)).toEqual(['thinking', 'text'])
    expect(segments.every((segment) => Buffer.byteLength(segment.text) <= 32 * 1024)).toBe(true)
    expect(record.assistant.value?.contentRefs).toHaveLength(1)
    await expect(readRecorderContent(join(root, '.scry'), segments[0].contentRefs![0])).resolves.toBe(reasoning)
    await expect(readRecorderContent(join(root, '.scry'), segments[1].contentRefs![0])).resolves.toBe(assistant)
  })

  it.each(['0.2.27', '0.2.30', '0.2.34'])('reads legacy unavailable timing from %s without rewriting records or blocking a new session', async (recorderVersion) => {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    await completeTurn(root, 'legacy-session')
    const name = (await readdir(join(dataRoot, 'records')))[0]
    const path = join(dataRoot, 'records', name)
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    legacy.recorderVersion = recorderVersion
    legacy.modelTiming = {
      status: 'partial', quality: 'unavailable', source: ['provider_transcript+lifecycle_hooks'],
      value: { method: 'non_call_residual', activityCoverage: { timedCalls: 1, totalCalls: 2 } },
      omissionReason: 'turn wall-clock is inconsistent with observed activity intervals'
    }
    const bytes = JSON.stringify(legacy)
    await writeFile(path, bytes)
    await completeTurn(root, 'new-session')
    const records = await listRecords(dataRoot)
    expect(records).toHaveLength(2)
    expect(records[0].modelTiming).toEqual({ ...legacy.modelTiming, status: 'unavailable' })
    expect(records[1]).toMatchObject({ sessionId: 'new-session', turnIndex: 1 })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect((await exportRecords(dataRoot)).records[0].modelTiming?.status).toBe('unavailable')
    await expect(commitRecord(dataRoot, { ...legacy, recordId: 'f'.repeat(32) })).rejects.toThrow('refusing to commit invalid turn record')
    for (const invalid of [
      { ...legacy, recorderVersion: '0.2.35' },
      { ...legacy, modelTiming: { ...legacy.modelTiming, value: { ...legacy.modelTiming.value, cumulativeMs: 0 } } },
      { ...legacy, modelTiming: { ...legacy.modelTiming, value: { method: 'non_call_residual', activityCoverage: { timedCalls: 3, totalCalls: 2 } } } }
    ]) {
      await writeFile(path, JSON.stringify(invalid))
      await expect(listRecords(dataRoot)).rejects.toThrow('invalid turn record')
    }
  })

  it('recovery 对未变化 transcript 复用有界解析快照', async () => {
    const root = await workspace()
    const rollout = join(root, 'codex-cache.jsonl')
    await writeFile(rollout, [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'cache-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'keep polling' } }
    ].map((line) => JSON.stringify(line)).join('\n'))
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('cache-session', {
        turn_id: 'cache-turn',
        prompt: 'keep polling',
        rollout_path: rollout
      })
    })

    resetTranscriptSnapshotCache()
    await recoverRecorder(root)
    expect(transcriptSnapshotCacheStats()).toMatchObject({ hits: 0, misses: 1, entries: 1 })
    await recoverRecorder(root)
    expect(transcriptSnapshotCacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 })

    await appendFile(rollout, `\n${JSON.stringify({
      timestamp: '2026-07-19T12:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'cache-turn', reason: 'interrupted' }
    })}\n`)
    await recoverRecorder(root)
    expect(transcriptSnapshotCacheStats().misses).toBe(2)
    await expect(listRecords(join(root, '.scry'))).resolves.toHaveLength(1)
  })

  it('transcript window 在 stat 后截短或轮转时不声明 snapshot consistent', async () => {
    const root = await workspace()
    const transcript = join(root, 'changing.jsonl')
    await writeFile(transcript, 'first line\nsecond line\n')
    const initial = await stat(transcript)
    const expected = {
      dev: initial.dev,
      ino: initial.ino,
      size: initial.size,
      mtimeMs: initial.mtimeMs,
      ctimeMs: initial.ctimeMs
    }

    await writeFile(transcript, 'short\n')
    await expect(readTranscriptWindow(transcript, expected.size, 0, expected)).resolves.toMatchObject({ consistent: false })

    await rename(transcript, `${transcript}.rotated`)
    await writeFile(transcript, 'first line\nsecond line\n')
    await expect(readTranscriptWindow(transcript, expected.size, 0, expected)).resolves.toMatchObject({ consistent: false })
  })

  it('transcript snapshot 不因旧的 32 MiB 窗口永久丢失大轮次开头', async () => {
    const root = await workspace()
    const transcript = join(root, 'large-transcript.jsonl')
    const size = 33 * 1024 * 1024 + 17
    const handle = await openFile(transcript, 'w+')
    try {
      await handle.truncate(size)
      await handle.write(Buffer.from('turn-start\n'), 0, 11, 0)
      const tail = Buffer.from('\nturn-end\n')
      await handle.write(tail, 0, tail.length, size - tail.length)
    } finally {
      await handle.close()
    }
    const info = await stat(transcript)
    const snapshot = await readTranscriptWindow(transcript, info.size, 0, {
      dev: info.dev, ino: info.ino, size: info.size,
      mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs
    })
    expect(snapshot).toMatchObject({ truncated: false, consistent: true })
    expect(snapshot.content.startsWith('turn-start\n')).toBe(true)
    expect(snapshot.content.endsWith('\nturn-end\n')).toBe(true)
    expect(Buffer.byteLength(snapshot.content)).toBe(size)
  })

  it('Pi/OpenCode capture metadata 将截断证据投影为 partial 而非 exact', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'pi', event: 'UserPromptSubmit', workspace: root, payload: payload('partial-1', { prompt: 'bounded evidence' }) })
    await handleRecorderHook({
      provider: 'pi',
      event: 'PreToolUse:read',
      workspace: root,
      payload: payload('partial-1', {
        tool_name: 'read',
        tool_use_id: 'partial-tool',
        tool_input: { truncated: true, preview: 'input' },
        scry_capture: { schemaVersion: 1, fields: { tool_input: { status: 'partial', reason: 'byte_limit' } } }
      })
    })
    await handleRecorderHook({
      provider: 'pi',
      event: 'PostToolUse:read',
      workspace: root,
      payload: payload('partial-1', {
        tool_name: 'read',
        tool_use_id: 'partial-tool',
        tool_response: { truncated: true, preview: 'output' },
        scry_capture: { schemaVersion: 1, fields: { tool_response: { status: 'partial', reason: 'byte_limit' } } }
      })
    })
    await handleRecorderHook({
      provider: 'pi',
      event: 'Stop',
      workspace: root,
      payload: payload('partial-1', {
        assistant_response: 'partial assistant',
        scry_capture: { schemaVersion: 1, fields: { assistant_response: { status: 'partial', reason: 'byte_limit' } } }
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.assistant).toMatchObject({ status: 'partial', quality: 'exact', value: { text: 'partial assistant' } })
    expect(record.modelSegments).toMatchObject({ status: 'partial', quality: 'exact' })
    expect(record.tools).toMatchObject({ status: 'partial', quality: 'exact' })
    expect(record.skills).toMatchObject({ status: 'unavailable' })
    expect(record.mcps).toMatchObject({ status: 'unavailable' })
  })

  it('每个顶层轮次只提交一条正式记录，重复 Stop 不重复', async () => {
    const root = await workspace()
    await completeTurn(root, 's1')
    const duplicate = await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })
    const records = await listRecords(join(root, '.scry'))

    expect(duplicate.status).toBe('duplicate')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ sequence: 1, sessionId: 's1', generation: 1, turnIndex: 1, status: 'completed' })
    expect(records[0].tools.value).toEqual([
      expect.objectContaining({ id: 's1-tool', name: 'Bash', status: 'success', outputSummary: 'ok' })
    ])
    expect(records[0].usage).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
    expect(records[0].modelTiming).toMatchObject({
      status: 'partial',
      quality: 'estimated',
      value: { method: 'non_call_residual' }
    })
    expect(records[0].diff).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
  })
}
