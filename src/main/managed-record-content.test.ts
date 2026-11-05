import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import type { AgentTurnRecord, TurnCall, TurnEvidence } from '../shared/turn-record'
import type { ToolContentRef } from '../shared/tool-content'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'
import { readRecorderContent } from '../core/turn-recorder/content-store'
import { CONTENT_MISSING_REASON } from '../core/turn-recorder/managed-evidence'
import { listRecords } from '../core/turn-recorder/store'
import { persistTraceToolEvents, TRACE_TOOL_CONTENT_POLICY, type TraceRecorderIngestion } from './trace-tool-content'
import { commitManagedTraceTurn, type ManagedTraceTurnCommitInput } from './managed-turn-commit'
import { fixture, input, startManaged } from './managed-turn-tests/fixture.test'

const OUTPUT = `full output body ${'payload '.repeat(2_000)}end`
const INPUT = { command: `ls ${'long-argument '.repeat(600)}` }

const fullCapture = JSON.stringify({
  schemaVersion: 1, enabled: true, workspaceId: 'managed-main-fixture', dataDir: '.scry',
  repositories: { mode: 'workspace-only' },
  capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true }
})

const refsIn = (value: unknown): ToolContentRef[] => {
  if (Array.isArray(value)) return value.flatMap(refsIn)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const own = record.contentRef && typeof record.contentRef === 'object' ? [record.contentRef as ToolContentRef] : []
  return [...own, ...Object.values(record).flatMap(refsIn)]
}

const storedBodies = async (dataRoot: string): Promise<string[]> => {
  const root = join(dataRoot, 'content', 'sha256')
  const bodies: string[] = []
  for (const shard of await readdir(root)) {
    for (const name of await readdir(join(root, shard))) {
      bodies.push(await readFile(join(root, shard, name), 'utf8'))
    }
  }
  return bodies
}

/** What the uploader sends: the record JSON plus every referenced body it can read. */
const uploadPayload = async (record: AgentTurnRecord, dataRoot: string): Promise<string> => {
  const bodies = await Promise.all(refsIn(record).map((ref) => readRecorderContent(dataRoot, ref)))
  return [JSON.stringify(record), ...bodies].join('\n')
}

const withToolCall = async (
  base: ManagedTraceTurnCommitInput,
  recorder?: TraceRecorderIngestion
): Promise<{ request: ManagedTraceTurnCommitInput; calls: () => TurnCall[] }> => {
  const start: TraceEvent = {
    id: 'tool-start', ts: base.timing.startedAt, runId: base.turn.runId, kind: 'tool',
    stage: 'tool:Bash', tool: 'Bash', toolUseId: 'call-1', input: INPUT
  }
  const result: TraceEvent = {
    id: 'tool-result', ts: base.timing.completedAt, runId: base.turn.runId, kind: 'tool',
    stage: 'tool_result', tool: 'Bash', toolUseId: 'call-1', output: OUTPUT
  }
  const persisted: TraceEvent[] = []
  for (const event of [start, result]) {
    const [stored] = await persistTraceToolEvents(base.userDataDir, base.cwd, [event], recorder)
    persisted.push(stored)
  }
  const items = [...base.turn.items, ...persisted]
  const evidence = aggregateTurnEvidence({
    userText: base.turn.userText,
    events: items,
    // The live channel aggregates under the App trace policy, which is always full.
    toolContentPolicy: TRACE_TOOL_CONTENT_POLICY,
    source: 'scry_provider_adapter'
  })
  return {
    request: { ...base, turn: { ...base.turn, items, turnEvidence: evidence } },
    calls: () => evidence.tools.value ?? []
  }
}

const callById = (evidence: TurnEvidence): TurnCall | undefined =>
  evidence.tools.value?.find((call) => call.id === 'call-1')

describe('managed record capture policy', () => {
  it('summary 只保留摘要：工作区库无完整输出、记录无输出引用、上传内容不含完整输出', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const dataRoot = join(workspace, '.scry')
    const { request } = await withToolCall(base, { root: dataRoot, toolOutput: 'summary' })
    await commitManagedTraceTurn(request, { waitMs: 0 })

    const [record] = await listRecords(dataRoot)
    const call = callById(record)!
    expect(call.outputContent).toBeUndefined()
    expect(call.outputSummary).toBeTruthy()
    expect(call.outputSummary!.length).toBeLessThanOrEqual(501)
    // Tool input is a promised recorder field: it keeps a reference whose bytes are local.
    const inputRef = call.inputContent?.contentRef!
    expect(inputRef).toBeDefined()
    expect(JSON.parse(await readRecorderContent(dataRoot, inputRef))).toEqual(INPUT)

    for (const body of await storedBodies(dataRoot)) expect(body).not.toContain(OUTPUT)
    const payload = await uploadPayload(record, dataRoot)
    expect(payload).not.toContain(OUTPUT)
  })

  it('负对照：full 策略留下输出引用，工作区库与上传内容都含完整输出', async () => {
    const { workspace, userDataDir } = await fixture()
    await writeFile(join(workspace, 'scry.config.json'), fullCapture)
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const dataRoot = join(workspace, '.scry')
    const { request } = await withToolCall(base, { root: dataRoot, toolOutput: 'full' })
    await commitManagedTraceTurn(request, { waitMs: 0 })

    const [record] = await listRecords(dataRoot)
    const call = callById(record)!
    const outputRef = call.outputContent?.contentRef!
    expect(outputRef).toBeDefined()
    expect(await readRecorderContent(dataRoot, outputRef)).toBe(OUTPUT)
    expect(await storedBodies(dataRoot)).toContain(OUTPUT)
    expect(await uploadPayload(record, dataRoot)).toContain(OUTPUT)
  })

  it('输出正文只在 App 库时降级为 unavailable，摘要与 error 与剩余证据一致', async () => {
    const { workspace, userDataDir } = await fixture()
    await writeFile(join(workspace, 'scry.config.json'), fullCapture)
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const dataRoot = join(workspace, '.scry')
    // No recorder ingestion: the App store holds the body, and the record may only reference it.
    const { request } = await withToolCall(base)
    const evidence = request.turn.turnEvidence!
    const call = callById(evidence)!
    call.error = OUTPUT
    await commitManagedTraceTurn({
      ...request,
      turn: { ...request.turn, turnEvidence: evidence }
    }, { waitMs: 0 })

    const [record] = await listRecords(dataRoot)
    const stored = callById(record)!.outputContent!
    expect(stored).toMatchObject({ storage: 'omitted', sourceCompleteness: 'unavailable', savedBytes: 0 })
    expect(stored.contentRef).toBeUndefined()
    expect(callById(record)!.outputSummary).toBeUndefined()
    expect(callById(record)!.error).toBe('tool failed')
    expect(record.tools).toMatchObject({ status: 'partial', quality: 'inferred' })
    expect(record.tools.omissionReason).toContain(CONTENT_MISSING_REASON)
    for (const ref of refsIn(record)) await expect(readRecorderContent(dataRoot, ref)).resolves.toBeDefined()
  })

  it('正文缺失也能走完 prepare → commit → 重试：一条降级记录、0 次抛错', async () => {
    const { workspace, userDataDir } = await fixture()
    await writeFile(join(workspace, 'scry.config.json'), fullCapture)
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const dataRoot = join(workspace, '.scry')
    const { request } = await withToolCall(base)

    const first = await commitManagedTraceTurn(request, { waitMs: 0 })
    const retry = await commitManagedTraceTurn(request, { waitMs: 0 })
    expect(retry.recordId).toBe(first.recordId)
    expect(await listRecords(dataRoot)).toHaveLength(1)

    const [record] = await listRecords(dataRoot)
    expect(record.status).toBe('completed')
    expect(callById(record)!.outputContent).toMatchObject({ storage: 'omitted', sourceCompleteness: 'unavailable' })
    expect(record.tools.status).toBe('partial')
  })

  it('助手正文缺失：降级为 unavailable，不要求 exact 也不重新标成 exact', async () => {
    const { workspace, userDataDir } = await fixture()
    await startManaged(workspace)
    const base = input(workspace, userDataDir)
    const dataRoot = join(workspace, '.scry')
    const { request } = await withToolCall(base, { root: dataRoot, toolOutput: 'summary' })
    const evidence = request.turn.turnEvidence!
    const before = evidence.assistant
    expect(before.status).toBe('available')
    const ghost = {
      storage: 'recorder-content-v1' as const,
      sha256: 'a'.repeat(64),
      bytes: 32,
      encoding: 'utf8' as const
    }
    evidence.assistant = { ...before, value: { ...before.value!, contentRefs: [ghost] } }

    await commitManagedTraceTurn({ ...request, turn: { ...request.turn, turnEvidence: evidence } }, { waitMs: 0 })

    const [record] = await listRecords(dataRoot)
    expect(record.assistant.status).toBe('partial')
    expect(record.assistant.quality).toBe('inferred')
    expect(record.assistant.omissionReason).toBe(CONTENT_MISSING_REASON)
    expect(record.assistant.value?.contentRefs).toBeUndefined()
    expect(record.assistant.value?.text).toBe(before.value?.text)
  })
})
