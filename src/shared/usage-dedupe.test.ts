import { describe, expect, it } from 'vitest'
import {
  CodexUsageDeltaFilter,
  TranscriptUsageDedupe,
  claudeTranscriptUsageKey,
  codexLastUsageSignature
} from './usage-dedupe'

describe('claudeTranscriptUsageKey', () => {
  it('messageId 与 requestId 共同决定身份；两者都缺失时没有去重依据', () => {
    expect(claudeTranscriptUsageKey({ messageId: 'msg-1', requestId: 'req-1' }))
      .toBe(claudeTranscriptUsageKey({ messageId: 'msg-1', requestId: 'req-1' }))
    expect(claudeTranscriptUsageKey({ messageId: 'msg-1', requestId: 'req-1' }))
      .not.toBe(claudeTranscriptUsageKey({ messageId: 'msg-1', requestId: 'req-2' }))
    expect(claudeTranscriptUsageKey({ messageId: 'msg-1' })).toBeDefined()
    expect(claudeTranscriptUsageKey({ requestId: 'req-1' })).toBeDefined()
    expect(claudeTranscriptUsageKey({})).toBeUndefined()
    expect(claudeTranscriptUsageKey({ messageId: '', requestId: '' })).toBeUndefined()
  })
})

describe('TranscriptUsageDedupe', () => {
  it('同一身份只放行一次，无身份记录全部放行并单独计数', () => {
    const dedupe = new TranscriptUsageDedupe()
    expect(dedupe.admit('a')).toBe(true)
    expect(dedupe.admit('a')).toBe(false)
    expect(dedupe.admit('b')).toBe(true)
    expect(dedupe.admit(undefined)).toBe(true)
    expect(dedupe.admit(undefined)).toBe(true)
    expect(dedupe.duplicatesDropped).toBe(1)
    expect(dedupe.unkeyedAdmitted).toBe(2)
  })
})

describe('CodexUsageDeltaFilter', () => {
  it('只抑制相邻的同签名帧，字段顺序不同视为同一帧', () => {
    const filter = new CodexUsageDeltaFilter()
    expect(filter.admit({ input_tokens: 100, output_tokens: 10 })).toBe(true)
    expect(filter.admit({ output_tokens: 10, input_tokens: 100 })).toBe(false)
    expect(filter.admit({ input_tokens: 50, output_tokens: 5 })).toBe(true)
    // 隔了一帧之后再次出现同样的数值是真实的第二次请求。
    expect(filter.admit({ input_tokens: 100, output_tokens: 10 })).toBe(true)
    expect(filter.duplicatesDropped).toBe(1)
  })

  it('没有可比较数值的帧一律放行，不作为重复判断依据', () => {
    const filter = new CodexUsageDeltaFilter()
    expect(filter.admit(undefined)).toBe(true)
    expect(filter.admit({})).toBe(true)
    expect(filter.admit({ input_tokens: 'many' })).toBe(true)
    expect(filter.admit([1, 2])).toBe(true)
    expect(filter.duplicatesDropped).toBe(0)
    expect(codexLastUsageSignature({ input_tokens: Number.NaN })).toBeNull()
    expect(codexLastUsageSignature(null)).toBeNull()
  })
})
