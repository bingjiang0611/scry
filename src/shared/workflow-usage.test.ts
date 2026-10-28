import { describe, expect, it } from 'vitest'
import { workflowUsageFromRecorder } from './workflow-usage'

describe('workflow usage provenance', () => {
  it('does not turn absent Recorder evidence into zero', () => {
    expect(workflowUsageFromRecorder(undefined)).toMatchObject({ provenance: 'unavailable', source: 'none' })
    expect(workflowUsageFromRecorder({ inputTokens: 0, outputTokens: 0, quality: 'exact' })).toMatchObject({ provenance: 'exact', inputTokens: 0, outputTokens: 0 })
  })
  it('marks non-exact Recorder observations estimated', () => {
    expect(workflowUsageFromRecorder({ outputTokens: 4, quality: 'inferred' })).toMatchObject({ provenance: 'estimated', source: 'recorder' })
  })
})
