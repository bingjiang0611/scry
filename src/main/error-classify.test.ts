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
  })
})
