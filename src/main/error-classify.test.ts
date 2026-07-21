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
  it('上下文超长 → context', () => {
    expect(classifyError('prompt is too long: token limit').category).toBe('context')
  })
  it('mcp → mcp', () => {
    expect(classifyError('MCP server connection timed out').category).toBe('mcp')
  })
  it('其他 → unknown，无 hint', () => {
    const r = classifyError('something weird happened')
    expect(r.category).toBe('unknown')
    expect(r.hint).toBe('')
  })
})
