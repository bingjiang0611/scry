// P3 审计模式（RFC §P3，纯观测、不阻塞）：给 tool_use 跑危险分类，标记 + 入库，但默认放行。
// 纯函数、无 electron/SDK，便于单测。真正的拦截/审批（canUseTool）是后续 ②内联/③modal 才做。
// 反假数据：只标确有把握的危险模式，宁可漏标不误标（误标会训练用户忽略告警）。
import type { DangerVerdict } from '../shared/trace.js'

const MCP_WRITE = /create|update|delete|remove|write|send|post|submit|merge|publish|push|add_|set_|del_/i

export function classifyDanger(toolName: string, input: unknown, cwd?: string): DangerVerdict | null {
  const inp = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash') {
    return classifyBash(typeof inp.command === 'string' ? inp.command : '')
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const fp = typeof inp.file_path === 'string' ? inp.file_path : ''
    // 跨项目写：绝对路径且不在当前 cwd 子树下（盲写别人项目）
    if (fp && cwd && fp.startsWith('/') && !isUnder(fp, cwd)) {
      return { level: 'warn', reason: `跨项目写 ${fp}` }
    }
    return null
  }
  if (toolName.startsWith('mcp__')) {
    const action = toolName.split('__').slice(2).join('__')
    if (MCP_WRITE.test(action)) return { level: 'warn', reason: `MCP 写操作 ${action}` }
    return null
  }
  return null
}

function isUnder(path: string, dir: string): boolean {
  const d = dir.endsWith('/') ? dir : dir + '/'
  return path === dir || path.startsWith(d)
}

function classifyBash(cmd: string): DangerVerdict | null {
  const c = cmd.toLowerCase()
  if (/\brm\b/.test(c)) {
    const flags = c.match(/\brm\s+(-[a-z]+)/)?.[1] ?? ''
    if (flags.includes('r') && flags.includes('f')) return { level: 'danger', reason: 'rm 递归强删' }
    if (flags.includes('r')) return { level: 'warn', reason: 'rm -r 递归删除' }
  }
  if (/\bsudo\b/.test(c)) return { level: 'danger', reason: 'sudo 提权' }
  if (/\bgit\s+push\b/.test(c)) return { level: 'danger', reason: 'git push' }
  if (/\bgit\s+reset\s+--hard\b/.test(c)) return { level: 'warn', reason: 'git reset --hard' }
  if (/\bgit\s+clean\s+-[a-z]*f/.test(c)) return { level: 'warn', reason: 'git clean -f' }
  if (/(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/.test(c)) return { level: 'danger', reason: '管道执行远程脚本' }
  if (/:\(\)\s*\{.*\|.*&.*\}\s*;/.test(cmd)) return { level: 'danger', reason: 'fork bomb' }
  if (/\b(chmod|chown)\s+-[a-z]*r/.test(c)) return { level: 'warn', reason: '递归改权限/属主' }
  if (/>\s*\/(etc|usr|bin|sys)\b/.test(c)) return { level: 'danger', reason: '覆写系统目录' }
  return null
}
