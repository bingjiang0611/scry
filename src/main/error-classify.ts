// A1：把 SDK / claude 的错误信息归类，给用户可见的恢复提示（借鉴 CodePilot error-classifier 的分类思路，按观测关键路径裁剪）。
// 纯函数，便于单测。

import type { ProviderId } from '../shared/provider'
import { classifyRunTermination, runTerminationHint } from '../shared/runtime'

export interface ClassifiedError {
  category: string
  hint: string
}

export function classifyError(message: string, providerId?: ProviderId): ClassifiedError {
  const m = (message || '').toLowerCase()
  if (
    m.includes('not logged in') ||
    m.includes('please run /login') ||
    m.includes('unauthorized') ||
    m.includes('authentication required') ||
    (providerId === 'antigravity' && (m.includes('-32000') || m.includes('agy --login') || m.includes('no browser')))
  ) {
    if (providerId === 'antigravity') {
      return { category: 'auth', hint: '未登录：在终端运行 `agy` 登录（或 `agy --login`），完成后重试' }
    }
    return { category: 'auth', hint: '未登录：在终端跑 `claude`（或 `claude setup-token`）登录后重试' }
  }
  if (m.includes('enoent') || m.includes('command not found') || m.includes('spawn')) {
    if (providerId === 'antigravity') {
      return { category: 'cli', hint: '找不到 `agy` 可执行文件：检查 PATH，或通过 `SCRY_AGY_PATH` 指定绝对路径' }
    }
    return { category: 'cli', hint: '找不到 claude / node 可执行：检查 PATH，或用 nvm v22 启动' }
  }
  if (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('overloaded') ||
    (providerId === 'antigravity' && (m.includes('quota') || m.includes('resource_exhausted')))
  ) {
    if (providerId === 'antigravity') {
      return { category: 'rate', hint: 'Antigravity 配额或请求频率受限：稍后重试或切换模型' }
    }
    return { category: 'rate', hint: 'API 限流 / 过载：稍后重试' }
  }
  if (m.includes('econnrefused') || m.includes('etimedout') || m.includes('network') || m.includes('fetch failed')) {
    return { category: 'network', hint: '网络问题：检查连接 / 代理' }
  }
  const termination = classifyRunTermination({ message })
  if (termination) {
    return { category: termination, hint: runTerminationHint(termination) }
  }
  if (m.includes('mcp')) {
    return { category: 'mcp', hint: 'MCP 连接问题：到 MCP 面板「测试连接」排查' }
  }
  return { category: 'unknown', hint: '' }
}
