import { describe, expect, it } from 'vitest'
import { available, partial } from '../../shared/turn-record.js'
import { isEvidence } from '../../shared/turn-evidence-validation.js'
import type { TurnEvidence } from '../../shared/turn-record.js'
import { applyCaptureBaselineCaveat, applyDiffExcludeEvidence } from './record-capture-metadata.js'

const snapshot = {
  version: 1 as const,
  status: 'captured' as const,
  files: [{ path: '/repo/tracked.txt', change: 'modified' as const, added: 1, deleted: 1 }],
  beforeAt: '2026-01-01T00:00:00.000Z',
  afterAt: '2026-01-01T00:00:01.000Z',
  captureMs: 1,
  cleanup: 'ok' as const
}

function evidence(diff: TurnEvidence['diff']): TurnEvidence {
  return { diff } as TurnEvidence
}

describe('diff omission codes', () => {
  it('a mid-turn claim names its late baseline in a code, not only in the sentence', () => {
    const state = evidence(available([snapshot], ['git']))
    applyCaptureBaselineCaveat(state, {
      protocol: 'codelens.session-capture.v1',
      captureId: 'capture-1',
      source: 'manual',
      baselineAt: '2026-01-01T00:00:02.000Z'
    } as never, '2026-01-01T00:00:00.000Z')

    expect(state.diff).toMatchObject({
      status: 'partial',
      omissionCodes: ['baseline_after_turn_start']
    })
    expect(state.diff.omissionReason).toContain('baseline 2000 ms after the prompt')
    // The code and the sentence must describe the same fact, and both must pass validation.
    expect(isEvidence(state.diff)).toBe(true)
  })

  it('an integrator exclusion adds its own code without dropping an earlier one', () => {
    const state = evidence(partial([{ ...snapshot, diffExclude: { paths: ['/repo/friday-1'], files: 3 } }],
      ['git'], 'session capture started mid-turn', 'exact', ['baseline_after_turn_start']))
    applyDiffExcludeEvidence(state)

    expect(state.diff).toMatchObject({
      status: 'partial',
      omissionCodes: ['baseline_after_turn_start', 'diff_exclude']
    })
    expect(state.diff.omissionReason).toContain('3 file(s) were left out of this diff')
    expect(isEvidence(state.diff)).toBe(true)
  })

  it('an unknown code is rejected instead of being read as a cause', () => {
    expect(isEvidence({
      status: 'partial',
      quality: 'exact',
      source: ['git'],
      value: [],
      omissionReason: 'why',
      omissionCodes: ['invented_code']
    })).toBe(false)
    expect(isEvidence({
      status: 'partial',
      quality: 'exact',
      source: ['git'],
      value: [],
      omissionReason: 'why',
      omissionCodes: ['diff_exclude', 'diff_exclude']
    })).toBe(false)
  })
})
