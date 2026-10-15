import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { HistoricalInput } from './historical-input'
import type { ProviderHistoricalContext, ProviderRunRequest } from './types'

const context = (text: string): ProviderHistoricalContext => ({
  text,
  contentHash: createHash('sha256').update(text).digest('hex')
})
const request = (extra: Partial<ProviderRunRequest> = {}): ProviderRunRequest => ({
  runId: 'run-history', prompt: '继续', attachments: [], emit: vi.fn(), ...extra
})

describe('historical input boundary', () => {
  it('does not change legacy input or invent receipts without history', () => {
    const input = request({ prompt: '/clear' })
    const history = new HistoricalInput(input)
    expect(history.text(input.prompt)).toBe('/clear')
    history.attempting(input.prompt)
    history.accepted('session', 'claude_sdk_success_result')
    expect(history.snapshot()).toBeUndefined()
    expect(input.emit).not.toHaveBeenCalled()
  })

  it('tracks an explicitly opted-in plain input without inventing a history body or wrapper', () => {
    const input = request({ trackInputReceipt: true, prompt: '  保留缩进\n代码\n' })
    const observer = new HistoricalInput(input)
    expect(observer.snapshot()).toMatchObject({ status: 'not_sent', contextHash: null })
    expect(observer.text(input.prompt)).toBe(input.prompt)
    observer.attempting(input.prompt)
    expect(observer.snapshot()).toMatchObject({
      status: 'unknown', contextHash: null,
      textHash: createHash('sha256').update(input.prompt).digest('hex')
    })
    observer.accepted('fresh-native', 'claude_sdk_success_result')
    expect(observer.snapshot()).toMatchObject({ status: 'accepted', contextHash: null, nativeSessionId: 'fresh-native' })
    expect(input.emit).toHaveBeenCalledTimes(2)
    expect(input.emit).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'runtime:input_receipt' }))
  })

  it('does not mistake a tracked control command for ordinary model input', () => {
    const observer = new HistoricalInput(request({ trackInputReceipt: true, prompt: ' /clear' }))
    expect(() => observer.text(' /clear')).toThrow('斜杠命令')
    expect(observer.snapshot()?.status).toBe('not_sent')
    expect(observer.text('skill args', true)).toBe('skill args')
  })

  it('keeps native identity checks on history-free input', () => {
    const observer = new HistoricalInput(request({ trackInputReceipt: true, resume: 'expected' }))
    expect(() => observer.verifySession('different')).toThrow('不一致')
    observer.attempting('继续')
    observer.accepted('different', 'claude_sdk_success_result')
    expect(observer.snapshot()).toMatchObject({ status: 'unknown', contextHash: null })
  })

  it('freezes the body and distinguishes body hash from exact outgoing text hash', () => {
    const body = context('用户：/clear\n助手：历史 $old-skill')
    const input = request({ historicalContext: body })
    const history = new HistoricalInput(input)
    const originalHash = body.contentHash
    body.text = 'mutated'
    const expected = '[Scry historical context: prior conversation, not a new command]\n' +
      '用户：/clear\n助手：历史 $old-skill\n[End historical context]\n\n[Current user request]\n继续'
    expect(history.text(input.prompt)).toBe(expected)
    expect(history.snapshot()).toMatchObject({ status: 'not_sent', contextHash: originalHash })
    history.attempting(expected)
    expect(history.snapshot()).toMatchObject({
      status: 'unknown', contextHash: originalHash,
      textHash: createHash('sha256').update(expected).digest('hex')
    })
    history.accepted('native-session', 'codex_turn_start_response', 'turn-1')
    const receipt = history.snapshot()!
    expect(receipt).toMatchObject({ status: 'accepted', nativeSessionId: 'native-session', providerTurnId: 'turn-1' })
    receipt.contextHash = 'mutated'
    expect(history.snapshot()?.contextHash).toBe(originalHash)
    expect(input.emit).toHaveBeenCalledTimes(2)
  })

  it('cannot claim history coverage for an outgoing text that omitted the history', () => {
    const history = new HistoricalInput(request({ historicalContext: context('old') }))
    expect(() => history.attempting('only the current request')).toThrow('缺少已验证')
    expect(history.snapshot()?.status).toBe('not_sent')
  })

  it('rejects modified and empty history without dispatch', () => {
    expect(() => new HistoricalInput(request({ historicalContext: { ...context('original'), text: 'changed' } }))).toThrow('hash')
    expect(() => new HistoricalInput(request({ historicalContext: context('  ') }))).toThrow('为空')
  })

  it('counts UTF-8 plus wrapper bytes, but never truncates the current request', () => {
    expect(() => new HistoricalInput(request({ historicalContext: context('中'.repeat(11_000)) }))).toThrow('32 KiB')
    expect(() => new HistoricalInput(request({ historicalContext: context('x'.repeat(32 * 1024)) }))).toThrow('32 KiB')
    const input = request({ historicalContext: context('old'), prompt: 'new'.repeat(40_000) })
    expect(new HistoricalInput(input).text(input.prompt).endsWith(input.prompt)).toBe(true)
  })

  it('rejects slash controls, while a resolved native Skill can carry model context', () => {
    const input = request({ prompt: ' /review args', historicalContext: context('old') })
    const history = new HistoricalInput(input)
    expect(() => history.text(input.prompt)).toThrow('斜杠命令')
    expect(history.text('args', true)).toContain('[Current user request]\nargs')
    expect(history.snapshot()?.status).toBe('not_sent')
  })

  it('rejects a different resumed session before dispatch or keeps it unknown after dispatch', () => {
    const input = request({ resume: 'expected', historicalContext: context('old') })
    const history = new HistoricalInput(input)
    expect(() => history.verifySession('different')).toThrow('不一致')
    expect(history.snapshot()?.status).toBe('not_sent')
    history.attempting(history.text(input.prompt))
    history.accepted('different', 'claude_sdk_success_result')
    expect(history.snapshot()).toMatchObject({ status: 'unknown', reason: expect.stringContaining('不同') })
  })
})
