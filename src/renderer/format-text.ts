// 渲染层纯文本：路径/数字/时间/标签的显示格式，以及用户消息原文解析（斜杠命令与 skill 注入标签）。
export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

export function fmtTok(n?: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function fmtTokenCoverage(value: number | null, knownTurns: number, _totalTurns: number): string {
  if (value == null || knownTurns === 0) return '—'
  return fmtTok(value)
}

export function fmtKnownTokens(value: number, knownCount: number, missingCount = 0): string {
  if (knownCount === 0 && missingCount === 0) return '等待 result'
  if (knownCount === 0 && missingCount > 0) return '未捕获'
  return `${fmtTok(value)} tok${missingCount > 0 ? '+' : ''}`
}

export function relTime(ms: number): string {
  const d = Date.now() - ms
  if (d < 3600000) return `${Math.max(1, Math.round(d / 60000))}m`
  const h = d / 3600000
  if (h < 24) return `${Math.round(h)}h`
  const days = h / 24
  if (days < 7) return `${Math.round(days)}d`
  if (days < 30) return `${Math.round(days / 7)}w`
  return `${Math.round(days / 30)}mo`
}

// 解析用户消息：claude code 把斜杠命令 /cmd args 存成 <command-name>/<command-args> 标签
// （历史会话回放时尤其常见），把它抽成干净命令 + 去标签后的正文（skill 注入等）。
export interface ParsedUserMsg {
  command?: string // 如 "/workflow-orchestrator 12345678"
  body: string // 去掉 command 标签后的正文
  injectedSkill?: string // skill 触发时 claude code 注入的 SKILL.md（开头 "Base directory for this skill:"），值=skill 名
}
export function parseUserMessage(text: string): ParsedUserMsg {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim()
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
  const body = text.replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g, '').trim()
  const command = name ? (args ? `${name} ${args}` : name) : undefined
  // skill 注入：不是用户真实输入，是 claude code 把 SKILL.md 塞成 user 消息（路径最后一段=skill 名）
  const inject = !command ? body.match(/^Base directory for this skill:\s*(.+?)\s*$/m) : null
  const injectedSkill = inject ? (inject[1].split('/').filter(Boolean).pop() ?? undefined) : undefined
  return { command, body, injectedSkill }
}
