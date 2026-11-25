import { describe, it, expect } from 'vitest'
import { classifyError } from './error-classify'

describe('classifyError', () => {
  it('未登录 → auth', () => {
    expect(classifyError('Not logged in · Please run /login').category).toBe('auth')
    expect(classifyError('Not logged in · Please run /login').hint).toContain('登录')
  })
  it('找不到可执行 → cli', () => {
    expect(classifyError('spawn node ENOENT').category).toBe('cli')
  })
  it('限流 → rate', () => {
    expect(classifyError('HTTP 429 rate limit exceeded').category).toBe('rate')
  })
  it('网络 → network', () => {
    expect(classifyError('fetch failed: ECONNREFUSED').category).toBe('network')
  })
  it('输入上下文超长 → input_context_overflow', () => {
    expect(classifyError('context_length_exceeded: prompt is too long').category).toBe('input_context_overflow')
    expect(classifyError('context_length_exceeded: prompt is too long').hint).toContain('compact')
  })
  it('输出达到上限 → output_token_limit', () => {
    const result = classifyError('finish_reason: length')
    expect(result.category).toBe('output_token_limit')
    expect(result.hint).toContain('继续生成')
  })
  it('模糊 token limit 不再误导用户精简上下文', () => {
    expect(classifyError('token limit reached')).toEqual({ category: 'unknown', hint: '' })
  })
  it('mcp → mcp', () => {
    expect(classifyError('MCP server connection timed out').category).toBe('mcp')
  })
  it('其他 → unknown，无 hint', () => {
    const r = classifyError('something weird happened')
    expect(r.category).toBe('unknown')
    expect(r.hint).toBe('')
  })

  it('antigravity 未登录 / 缺 CLI / 配额受限给出专属提示，不串台到 claude', () => {
    const auth = classifyError('unauthorized (-32000): authentication required', 'antigravity')
    expect(auth.category).toBe('auth')
    expect(auth.hint).toContain('agy')
    expect(auth.hint).not.toContain('claude')

    const cli = classifyError('spawn agy ENOENT', 'antigravity')
    expect(cli.category).toBe('cli')
    expect(cli.hint).toContain('SCRY_AGY_PATH')
    expect(cli.hint).not.toContain('claude')

    const quota = classifyError('RESOURCE_EXHAUSTED: quota exceeded', 'antigravity')
    expect(quota.category).toBe('rate')
    expect(quota.hint).toContain('Antigravity')

    // S1: authentication required 限定到 antigravity，不影响其他 Provider 的 MCP 归类
    expect(classifyError('MCP server x: authentication required').category).toBe('mcp')
    expect(classifyError('MCP server x: authentication required', 'claude').category).toBe('mcp')
    // S1: Antigravity 自身的 agy acp --login 提示正确归类为 auth
    const agyAcpHint = classifyError('Antigravity 未登录：在终端运行 agy 完成登录（或 agy acp --login），再回到 Scry 刷新', 'antigravity')
    expect(agyAcpHint.category).toBe('auth')
    expect(agyAcpHint.hint).toContain('agy')
  })
})

// C4: a quota failure must carry its reset time to the App, otherwise the only recovery is
// 「稍后重试」 and the user cannot tell when.
describe('classifyError carries the usage limit', () => {
  it('reads the reset time out of a rate-limit message', () => {
    const classified = classifyError('429 rate limit reached, resets in 2 hours', 'claude')
    expect(classified.category).toBe('rate')
    expect(classified.usageLimit).toMatchObject({ provider: 'claude', source: 'relative' })
    expect(typeof classified.usageLimit?.resetAt).toBe('number')
  })

  it('omits the limit for failures that are not about quota', () => {
    expect(classifyError('MCP connection failed', 'claude').usageLimit).toBeUndefined()
  })
})
