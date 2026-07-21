// A1：把 SDK / claude 的错误信息归类，给用户可见的恢复提示（借鉴 CodePilot error-classifier 的分类思路，按观测关键路径裁剪）。
// 纯函数，便于单测。

export interface ClassifiedError {
  category: string
  hint: string
}

export function classifyError(message: string): ClassifiedError {
  const m = (message || '').toLowerCase()
  if (m.includes('not logged in') || m.includes('please run /login') || m.includes('unauthorized')) {
    return { category: 'auth', hint: '未登录：在终端跑 `claude`（或 `claude setup-token`）登录后重试' }
  }
  if (m.includes('enoent') || m.includes('command not found') || m.includes('spawn')) {
    return { category: 'cli', hint: '找不到 claude / node 可执行：检查 PATH，或用 nvm v22 启动' }
  }
  if (m.includes('429') || m.includes('rate limit') || m.includes('overloaded')) {
    return { category: 'rate', hint: 'API 限流 / 过载：稍后重试' }
  }
  if (m.includes('econnrefused') || m.includes('etimedout') || m.includes('network') || m.includes('fetch failed')) {
    return { category: 'network', hint: '网络问题：检查连接 / 代理' }
  }
  if (m.includes('context') || m.includes('too long') || m.includes('token limit')) {
    return { category: 'context', hint: '上下文超长：开新会话或精简后重试' }
  }
  if (m.includes('mcp')) {
    return { category: 'mcp', hint: 'MCP 连接问题：到 MCP 面板「测试连接」排查' }
  }
  return { category: 'unknown', hint: '' }
}
