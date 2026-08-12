export type ProviderTerminalOutcome = 'completed' | 'failed' | 'interrupted'

export type ProviderRecordingPolicy =
  | {
      allowCanonicalCommit: true
      blockSession: false
    }
  | {
      allowCanonicalCommit: false
      blockSession: true
      rendererError: {
        category: 'recording'
        message: string
      }
    }

export function providerRecordingPolicy(
  outcome: ProviderTerminalOutcome,
  recordingFailure?: { message: string }
): ProviderRecordingPolicy {
  if (!recordingFailure) return { allowCanonicalCommit: true, blockSession: false }

  const providerMessage = outcome === 'completed'
    ? 'Provider 已完成，但'
    : `Provider 已${outcome === 'interrupted' ? '中断' : '失败'}，且`

  return {
    allowCanonicalCommit: false,
    blockSession: true,
    rendererError: {
      category: 'recording',
      message: `${providerMessage} Scry 精确记录不完整：${recordingFailure.message}`
    }
  }
}
