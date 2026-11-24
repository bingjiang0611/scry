import { describe, expect, it } from 'vitest'
import { tokenCacheAccounting } from './token-accounting'

// Q5：Token 合计统一成「输入不含缓存 + 输出」。Codex app-server 的输入包含缓存，
// 其余 Provider（含 Pi 走 openai-codex）分开报。
describe('tokenCacheAccounting', () => {
  it('treats Codex app-server input as cache-inclusive', () => {
    expect(tokenCacheAccounting({ runtimeProvider: 'codex_cli' })).toBe('input_includes_cache')
    expect(tokenCacheAccounting({ providerId: 'codex' })).toBe('input_includes_cache')
  })

  it('keeps every other runtime on separate counters', () => {
    expect(tokenCacheAccounting({ runtimeProvider: 'pi_rpc', billingProvider: 'openai' })).toBe('separate')
    expect(tokenCacheAccounting({ runtimeProvider: 'pi_rpc', billingProvider: 'codex' })).toBe('separate')
    expect(tokenCacheAccounting({ runtimeProvider: 'claude_sdk' })).toBe('separate')
    expect(tokenCacheAccounting({ runtimeProvider: 'opencode_server' })).toBe('separate')
    expect(tokenCacheAccounting({ runtimeProvider: 'antigravity_acp' })).toBe('separate')
  })

  it('keeps the legacy billing-provider rule when no runtime was recorded', () => {
    expect(tokenCacheAccounting({ billingProvider: 'codex' })).toBe('input_includes_cache')
    expect(tokenCacheAccounting({ billingProvider: 'openai' })).toBe('input_includes_cache')
    expect(tokenCacheAccounting({ providerId: 'claude' })).toBe('separate')
  })
})
