import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace.js'
import { TurnChangeJournal, turnChangeHints } from './change-journal.js'

const event = (overrides: Partial<TraceEvent>): TraceEvent => ({
  id: 'event',
  ts: '2026-07-29T00:00:00.000Z',
  runId: 'run',
  kind: 'tool',
  stage: 'tool:Edit',
  ...overrides
})

describe('TurnChangeJournal', () => {
  it('只收集 scope 内的结构化写入并去重', () => {
    const journal = new TurnChangeJournal('/workspace/project')
    journal.record(event({ fileOp: 'edit', filePath: 'src/a.ts' }))
    journal.record(event({ id: 'duplicate', fileOp: 'write', filePath: '/workspace/project/src/a.ts' }))
    journal.record(event({ id: 'read', fileOp: 'read', filePath: 'src/read.ts' }))
    journal.record(event({ id: 'result', stage: 'tool_result', fileOp: 'edit', filePath: 'src/result.ts' }))
    journal.record(event({ id: 'outside', fileOp: 'edit', filePath: '../outside.ts' }))
    journal.record(event({ id: 'git', fileOp: 'write', filePath: '.git/index' }))

    expect(journal.snapshot()).toEqual({
      structuredPaths: [resolve('/workspace/project/src/a.ts')]
    })
  })

  it('可从已合并的 recorder 事件重建同一份提示', () => {
    expect(turnChangeHints('/workspace/project', [
      event({ fileOp: 'write', filePath: 'b.ts' }),
      event({ id: 'a', fileOp: 'edit', filePath: 'a.ts' })
    ])).toEqual({
      structuredPaths: [
        resolve('/workspace/project/a.ts'),
        resolve('/workspace/project/b.ts')
      ]
    })
  })
})
