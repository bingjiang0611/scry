import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { readRecorderContent } from '../core/turn-recorder/content-store'
import { listRecords } from '../core/turn-recorder/store'
import { CONTENT_MISSING_REASON } from '../core/turn-recorder/managed-evidence'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { persistTraceToolEvents, TRACE_TOOL_CONTENT_POLICY } from './trace-tool-content'
import { commitManagedTraceTurn, type ManagedTraceTurnCommitInput } from './managed-turn-commit'
import { fixture, input, startManaged } from './managed-turn-tests/fixture.test'

const body = `${'durable workspace body '.repeat(4_000)}end`

// A body large enough to need its own durable store, persisted exactly like the live channel does.
const withToolBody = async (
  base: ManagedTraceTurnCommitInput,
  recorderRoot?: string
): Promise<{ request: ManagedTraceTurnCommitInput; ref: { sha256: string; bytes: number; storage: string } }> => {
  const event: TraceEvent = {
    id: 'tool', ts: base.timing.completedAt, runId: base.turn.runId, kind: 'tool',
    stage: 'tool_result', tool: 'Bash', toolUseId: 'call-1', output: body
  }
  const [persisted] = await persistTraceToolEvents(base.userDataDir, base.cwd, [event], recorderRoot)
  const ref = persisted.outputContent?.contentRef
  if (!ref) throw new Error('fixture body was not stored, so the reference case cannot be built')
  const items = [
    ...base.turn.items,
    {
      id: 'tool-start', ts: base.timing.startedAt, runId: base.turn.runId, kind: 'tool',
      stage: 'tool:Bash', tool: 'Bash', toolUseId: 'call-1', input: { command: 'ls' }
    } as TraceEvent,
    persisted
  ]
  return {
    request: {
      ...base,
      turn: {
        ...base.turn,
        items,
        turnEvidence: aggregateTurnEvidence({
          userText: base.turn.userText,
          events: items,
          // The live channel aggregates under the App trace policy, which is always full.
          toolContentPolicy: TRACE_TOOL_CONTENT_POLICY,
          source: 'scry_provider_adapter'
        })
      }
    },
    ref
  }
}

describe('managed record content durability', () => {
  it('把工作区内容库缺失的正文降级为 unavailable，不写入悬空引用', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    // The live channel persists to the App store unconditionally; only the workspace copy
    // depended on the capture policy. Reproduce a summary workspace by omitting the second root.
    const { request, ref } = await withToolBody(input(workspace, userDataDir))
    expect(ref.storage).toBe('recorder-content-v1')
    await commitManagedTraceTurn(request, { waitMs: 0 })

    const dataRoot = join(workspace, '.scry')
    const [record] = await listRecords(dataRoot)
    const call = record.tools.value?.find((entry) => entry.id === 'call-1')
    expect(call).toBeDefined()
    const stored = call!.outputContent!
    expect(stored).toMatchObject({ storage: 'omitted', sourceCompleteness: 'unavailable', savedBytes: 0 })
    expect(stored.contentRef).toBeUndefined()
    expect(stored.content).toBeUndefined()
    expect(record.tools).toMatchObject({ status: 'partial', quality: 'inferred' })
    expect(record.tools.omissionReason).toContain(CONTENT_MISSING_REASON)
    // 不变量：记录里剩下的每个引用都必须能在本工作区内容库里读回原文。
    for (const entry of [record.tools, record.skills, record.mcps]
      .flatMap((section) => section.value ?? [])) {
      for (const field of [entry.inputContent, entry.outputContent]) {
        if (!field?.contentRef) continue
        await expect(readRecorderContent(dataRoot, field.contentRef)).resolves.toBeDefined()
      }
    }
  })

  it('工作区内容库已有正文时保留引用并能读回原文', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const { request, ref } = await withToolBody(base, join(workspace, '.scry'))
    await commitManagedTraceTurn(request, { waitMs: 0 })

    const dataRoot = join(workspace, '.scry')
    const [record] = await listRecords(dataRoot)
    const call = record.tools.value?.find((entry) => entry.id === 'call-1')
    expect(call?.outputContent?.contentRef?.sha256).toBe(ref.sha256)
    await expect(readRecorderContent(dataRoot, call!.outputContent!.contentRef!)).resolves.toBe(body)
    expect(record.tools).toMatchObject({ status: 'available', quality: 'exact' })
  })
})
