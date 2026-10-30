import { expect, it } from 'vitest'
import { exerciseConcurrentDiffDemand } from './concurrent-diff-demand-ui.mjs'

function fixture(backgroundUpdates = false) {
  let phase = 0
  const window = {
    __concurrentStarts: [{ runId: 'run-first' }],
    scry: { activeRuns: async () => [{ runId: 'run-first', done: false, items: [
      ...Array.from({ length: phase ? 14 : 1 }, () => ({ kind: 'tool', stage: 'tool_result' })),
      { stage: 'turn_diff_preview', turnDiff: { status: 'captured', afterAt: phase === 2 || (phase === 1 && backgroundUpdates) ? '2026-10-30T00:00:02Z' : '2026-10-30T00:00:01Z', files: Array.from({ length: phase === 2 ? 14 : 1 }, () => ({})) } }
    ] }] }
  }
  // Same standard-JS parsing boundary as Runtime.evaluate. Top-level await is
  // not enabled there; each async read must carry its own function wrapper.
  const document = { querySelector: () => ({ textContent: '14 files' }) }
  const evaluate = async (expression: string) => Function('window', 'document', `return ${expression}`)(window, document)
  return {
    evaluate,
    activate: async (selector: string) => { phase = selector.includes('second') ? 1 : 2 },
    wait: async (expression: string) => {
      if (expression.includes('document.querySelector')) return
      expect(await evaluate(`(async () => (${expression}))()`)).toBe(true)
    },
    conversations: [{ id: 'first' }, { id: 'second' }, { id: 'never-viewed' }]
  }
}
it('parses actual acceptance expressions and proves hidden stability plus a fresh returning snapshot', async () => {
  const proof = await exerciseConcurrentDiffDemand(fixture())
  expect(proof).toMatchObject({ firstFiles: 1, returnedFiles: 14, hiddenRunStillWorking: true, freshBeforeTerminal: true })
})
it('rejects a hidden background preview rather than merely checking a successful conversation switch', async () => {
  await expect(exerciseConcurrentDiffDemand(fixture(true))).rejects.toThrow('Hidden view published a new background preview')
})
