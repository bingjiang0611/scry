import { describe, expect, it } from 'vitest'
import { providerRecordingPolicy, type ProviderTerminalOutcome } from './provider-recording-policy'

describe('providerRecordingPolicy', () => {
  it.each<ProviderTerminalOutcome>(['completed', 'failed', 'interrupted'])(
    'allows canonical persistence when a %s Provider turn has complete recording evidence',
    (outcome) => {
      expect(providerRecordingPolicy(outcome)).toEqual({
        allowCanonicalCommit: true,
        blockSession: false
      })
    }
  )

  it.each([
    ['completed', 'Provider 已完成，但 Scry 精确记录不完整：snapshot missing'],
    ['failed', 'Provider 已失败，且 Scry 精确记录不完整：snapshot missing'],
    ['interrupted', 'Provider 已中断，且 Scry 精确记录不完整：snapshot missing']
  ] satisfies Array<[ProviderTerminalOutcome, string]>)(
    'blocks canonical persistence and reports a recording error when a %s turn has incomplete evidence',
    (outcome, message) => {
      expect(providerRecordingPolicy(outcome, { message: 'snapshot missing' })).toEqual({
        allowCanonicalCommit: false,
        blockSession: true,
        rendererError: { category: 'recording', message }
      })
    }
  )
})
