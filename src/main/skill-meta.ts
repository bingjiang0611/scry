// SKILL.md frontmatter 解析（纯函数，有单测）。
// 从 index.ts 抽出：description 可能是 YAML 多行块（> / >- / | / |-），
// 这块解析有过 bug（只读首行 → 展示出 ">" / ">-" / "|"），故独立成可测模块。

export function readSkillMeta(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const fm = m[1]
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim()

  // description 可能是 YAML 多行块（> / >- / | / |-）：折叠标记后真正内容在后续缩进行
  let description = ''
  const lines = fm.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const dm = lines[i].match(/^description:\s*(.*)$/)
    if (!dm) continue
    const first = dm[1].trim()
    if (first && !/^[>|][-+]?$/.test(first)) {
      description = first // 单行
    } else {
      const parts: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j]
        if (ln === '' || /^\s/.test(ln)) {
          if (ln.trim()) parts.push(ln.trim()) // 空行/纯空白行跳过，缩进内容行收集
        } else {
          break // 非空且非缩进行 = 下一个 key，块结束
        }
      }
      description = parts.join(' ')
    }
    break
  }
  return { name, description: description.slice(0, 300) }
}
