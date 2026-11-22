import { expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import { restoreSessionTurns } from './useAgentSession-history'

function trace(id: string, text: string): TraceEvent {
  return { id, text, runId: 'run', ts: '2026-11-22T00:00:00Z', kind: 'model', stage: 'text' }
}

it('installs the host timeline and applies focus events outside the snapshot', () => {
  const activeRun: ActiveRun = {
    runId: 'run', userText: '当前问题', done: false, items: [trace('shared', '宿主的内容')]
  }
  const previous = [{ ...activeRun, items: [trace('stale-local', '过期内容'), trace('shared', '旧版本')] }]
  const history = [{ runId: 'old', userText: '导入前的问题', items: [], done: true }]
  const page = {
    turns: history, offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete' as const,
    projection: { sessionKey: 'session', legacyBefore: true as const, activeRun }
  }
  const receipt = [trace('shared', '已经包含在首页'), trace('new', '首页读完后的内容')]
  const displayed = restoreSessionTurns(previous, 'session', history, activeRun, page, receipt, [], new Set())
  expect(displayed.map((turn) => turn.runId)).toEqual(['old', 'run'])
  expect(displayed[1]?.items).toEqual([trace('shared', '宿主的内容'), trace('new', '首页读完后的内容')])
})
