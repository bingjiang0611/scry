import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContent, ToolContentRef } from '../../shared/tool-content.js'
import type { DiffFile } from '../../shared/turn-diff.js'
import type { AgentTurnRecord, Evidence, TurnCall, TurnDiffSnapshotRecord } from '../../shared/turn-record.js'
import { applyRecordContentBudget, RECORDER_CONTENT_MAX_REFS } from './record-content-budget.js'
import { recordContentItems } from './store-index.js'
import { applyTurnDiffFilePolicy, UNTRACKED_PATCH_FILE_LIMIT } from './git-turn-diff-policy.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function ref(seed: string, bytes: number): ToolContentRef {
  return { sha256: createHash('sha256').update(seed).digest('hex'), bytes, encoding: 'json' } as ToolContentRef
}

function field(seed: string, bytes: number): ToolContent {
  return {
    contentRef: ref(seed, bytes),
    encoding: 'json',
    savedBytes: bytes,
    source: 'test',
    sourceCompleteness: 'complete',
    redaction: 'disabled',
    storage: 'omitted',
    reasons: []
  }
}

function evidence<T>(value: T): Evidence<T> {
  return { status: 'available', quality: 'exact', source: ['test'], value }
}

function call(index: number): TurnCall {
  return {
    id: `call-${index}`,
    name: 'Bash',
    status: 'completed',
    inputContent: field(`in${index}`, 1024),
    outputContent: field(`out${index}`, 1024)
  }
}

function untrackedFiles(count: number, patchBytes: number): DiffFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/workspace/friday-88733196/artifact-${index}.json`,
    added: 20,
    deleted: 0,
    change: 'added' as const,
    patch: 'x'.repeat(0),
    patchContent: {
      content: 'artifact',
      encoding: 'utf8' as const,
      savedBytes: patchBytes,
      source: 'git_turn_diff',
      sourceCompleteness: 'complete' as const,
      redaction: 'disabled' as const,
      storage: 'complete' as const,
      reasons: [],
      contentRef: ref(`patch${index}`, patchBytes)
    },
    patchStatus: 'captured' as const
  }))
}

function trackedFiles(): DiffFile[] {
  return [{
    path: '/workspace/src/app.ts',
    added: 3,
    deleted: 1,
    change: 'modified' as const,
    patchContent: {
      content: 'diff --git a/src/app.ts b/src/app.ts',
      encoding: 'utf8' as const,
      savedBytes: 32,
      source: 'git_turn_diff',
      sourceCompleteness: 'complete' as const,
      redaction: 'disabled' as const,
      storage: 'complete' as const,
      reasons: [],
      contentRef: ref('tracked', 32)
    },
    patchStatus: 'captured' as const
  }]
}

function snapshot(files: DiffFile[]): TurnDiffSnapshotRecord {
  return {
    status: 'captured',
    files,
    beforeAt: '2026-07-19T12:00:00.000Z',
    afterAt: '2026-07-19T12:00:30.000Z',
    captureMs: 30,
    cleanup: 'ok'
  }
}

function record(files: DiffFile[]): Omit<AgentTurnRecord, 'sequence'> {
  return {
    recordId: 'record-1',
    workspaceId: 'workspace',
    provider: 'codex',
    sessionId: 'session-1',
    generation: 1,
    startedAt: '2026-07-19T12:00:00.000Z',
    completedAt: '2026-07-19T12:00:30.000Z',
    status: 'completed',
    user: evidence({ text: 'review the diff' }),
    assistant: evidence({ text: 'done' }),
    tools: evidence(Array.from({ length: 57 }, (_, index) => call(index))),
    skills: evidence([] as TurnCall[]),
    mcps: evidence([] as TurnCall[]),
    hooks: evidence([]),
    usage: evidence({}),
    files: evidence([]),
    diff: evidence([snapshot(files)]),
    dangerousOperations: evidence([]),
    errors: evidence([]),
    transcript: evidence({
      contentRef: ref('transcript', 4096),
      sourcePath: '/tmp/rollout.jsonl',
      startOffset: 0,
      endOffset: 4096,
      identity: { dev: 1, ino: 2, size: 4096, mtimeMs: 1, ctimeMs: 1 },
      sourceCompleteness: 'complete' as const
    })
  } as Omit<AgentTurnRecord, 'sequence'>
}

describe('问题 2: 引用预算按证据价值排序', () => {
  it('keeps the raw session and every tool body when a turn also touches 570 new untracked files', () => {
    // 114 tool references (57 calls × input+output), 570 new untracked files, one raw transcript.
    const draft = record(untrackedFiles(570, 32 * 1024))
    const items = recordContentItems(draft)
    expect(items.filter((item) => item.priority === 'tool')).toHaveLength(114)
    expect(items.filter((item) => item.priority === 'diff-added')).toHaveLength(570)

    const budgeted = applyRecordContentBudget(draft)
    const kept = new Set(recordContentItems(budgeted).map((item) => item.path))
    expect(kept.has('transcript')).toBe(true)
    expect([...kept].filter((path) => path.startsWith('tools.'))).toHaveLength(114)
    // The budget is what binds: the untracked bodies are the ones that leave.
    expect(recordContentItems(budgeted).filter((item) => item.priority === 'diff-added').length)
      .toBeLessThan(570)
    expect(budgeted.transcript?.status).toBe('available')
  })

  it('evicts tool bodies only after every diff body is gone', () => {
    // Above the reference cap, the 513th body must be the least valuable one still kept.
    const files = [...trackedFiles(), ...untrackedFiles(RECORDER_CONTENT_MAX_REFS, 8)]
    const budgeted = applyRecordContentBudget(record(files))
    const items = recordContentItems(budgeted)
    expect(items.filter((item) => item.priority === 'tool')).toHaveLength(114)
    // 512 = transcript + 114 tool bodies + tracked patch + the rest of the untracked patches.
    const diffKept = items.filter((item) => item.priority.startsWith('diff-')).length
    expect(items.length).toBe(RECORDER_CONTENT_MAX_REFS)
    // 512 = 1 transcript + 114 tool bodies + 397 diff bodies (the tracked edit and new-file patches).
    expect(diffKept).toBe(RECORDER_CONTENT_MAX_REFS - 1 - 114)
  })
})

describe('问题 2: 未跟踪文件清单策略', () => {
  it('keeps the manifest and omits bodies once a turn adds more new files than the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-diff-policy-'))
    roots.push(root)
    const files = [...trackedFiles(), ...untrackedFiles(UNTRACKED_PATCH_FILE_LIMIT + 1, 128)]
    const untracked = new Set(files.filter((file) => file.change === 'added').map((file) => file.path))
    const policy = applyTurnDiffFilePolicy({
      files, repoRoot: '/workspace', diffExclude: [], untracked
    })
    expect(policy.files).toHaveLength(files.length)
    expect(policy.files.filter((file) => file.patchStatus === 'unavailable' && file.patchReason === 'policy'))
      .toHaveLength(UNTRACKED_PATCH_FILE_LIMIT + 1)
    // The tracked edit keeps its body; only untracked additions fall back to the manifest.
    expect(policy.files.find((file) => file.path === '/workspace/src/app.ts')?.patchStatus).toBe('captured')
  })

  it('leaves a turn at or below the limit with every patch', async () => {
    const files = [...trackedFiles(), ...untrackedFiles(UNTRACKED_PATCH_FILE_LIMIT, 128)]
    const untracked = new Set(files.filter((file) => file.change === 'added').map((file) => file.path))
    const policy = applyTurnDiffFilePolicy({ files, repoRoot: '/workspace', diffExclude: [], untracked })
    expect(policy.files.every((file) => file.patchStatus === 'captured')).toBe(true)
  })

  it('drops declared workspace paths from the diff entirely', async () => {
    const files = [...trackedFiles(), ...untrackedFiles(3, 64)]
    const policy = applyTurnDiffFilePolicy({
      files,
      repoRoot: '/workspace',
      diffExclude: ['friday-88733196'],
      untracked: new Set()
    })
    expect(policy.files.map((file) => file.path)).toEqual(['/workspace/src/app.ts'])
  })
})
