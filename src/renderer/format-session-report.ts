// 可复制的 Markdown 会话报告：把可验证 token、调用明细、文件足迹与行动信号汇成一份文本。
import { workspaceDiffCopy } from '@shared/constants/copy'
import type { WorkspaceDiffResult } from '@shared/trace'
import { basename, fmtKnownTokens, fmtTok } from './format-text'
import { aggregateCalls, logicalCallEventsForTurn } from './format-calls'
import { aggregateFiles, fileWriteCoverage } from './format-files'
import { aggregateSegments } from './format-segments'
import { analyzeBilling } from './format-billing'
import type { Turn } from './format-types'

function safeReportLabel(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 96)
}

// Billing Guardian P0：把本会话的 SDK/transcript token 和行动信号汇成可复制 Markdown。
// 工具/Skill/MCP/hook 没有独立 token 字段；报告只说明不可硬拆，不展示弱关联明细。
export function buildSessionReport(turns: Turn[], gitDiff?: WorkspaceDiffResult | null, opts: { sessionId?: string | null } = {}): string {
  const billing = analyzeBilling(turns)
  const all = turns.flatMap((t) => t.items)
  const calls = aggregateCalls(turns.flatMap((turn) => logicalCallEventsForTurn(turn.items, turn.userText)))
  const { structured } = aggregateFiles(all)
  const cov = fileWriteCoverage(all)
  const segs = aggregateSegments(all)
  const dangers = all.filter((e) => e.danger && e.stage !== 'tool_result')
  const toolErrors = all.filter((e) => e.stage === 'tool_result' && e.isError).length
  const touched = new Set(structured.map((f) => f.path))
  const diffUntouched = (gitDiff?.files ?? []).filter((d) => !touched.has(d.path))

  const L: string[] = ['# Session Token 用量报告']
  if (opts.sessionId) L.push(`- **sessionId**：${opts.sessionId}`)
  L.push(`- **计量口径**：${billing.sourceLabel}；${billing.officialBillLabel}`)
  L.push(
    `- **本会话已知用量**：${fmtKnownTokens(billing.totalTokens, billing.knownTokenResultCount, billing.missingTokenResultCount)} · 输入/输出 ${fmtTok(billing.tokensIn)}→${fmtTok(billing.tokensOut)} · 缓存读/写 ${fmtTok(billing.cacheReadTokens)}/${fmtTok(billing.cacheCreationTokens)} · ${calls.toolTotal} 次工具/Skill/MCP 调用`
  )
  L.push(
    `- **数据完整性**：轮次覆盖 ${billing.tokenCoveragePct}%；模型明细覆盖 ${billing.modelTokenCoveragePct}%；工具拆分：暂无独立 token 字段，不把整轮 token 分摊给具体工具`
  )
  const maxCtx = [...billing.allTurnRows].filter((r) => r.contextPct != null).sort((a, b) => (b.contextPct ?? 0) - (a.contextPct ?? 0))[0]
  if (maxCtx?.contextPct != null) L.push(`- **最大上下文**：TURN ${String(maxCtx.turnNo).padStart(2, '0')} · ${maxCtx.contextPct}%`)
  if (billing.models.length)
    L.push(
      `- **模型用量**：${billing.models
        .map((m) => `${m.model} ${fmtTok(m.totalTokens)} tok · 输入/输出 ${fmtTok(m.tokensIn)}→${fmtTok(m.tokensOut)} · 缓存 ${fmtTok(m.cacheReadTokens)}/${fmtTok(m.cacheCreationTokens)}`)
        .join(' · ')}`
    )
  if (billing.topTokenTurns.length) {
    L.push('', '## 高 Token 轮次')
    for (const t of billing.topTokenTurns.slice(0, 10)) {
      L.push(
        `- TURN ${String(t.turnNo).padStart(2, '0')}：${fmtKnownTokens(t.tokensTotal, t.tokenKnown ? 1 : 0)} · 输入/输出 ${fmtTok(t.tokensIn + t.tokensOut)} · 缓存 ${fmtTok(t.cacheReadTokens + t.cacheCreationTokens)} · ${t.toolCount} 工具 · ${t.label}`
      )
    }
  }
  if (billing.signals.length) {
    L.push('', '## 行动信号')
    for (const s of billing.signals) L.push(`- [${s.severity}] ${s.title}：${s.detail}；${s.action}`)
  }
  if (calls.tools.length) L.push(`- **工具**：${calls.tools.map((t) => `${safeReportLabel(t.name)}×${t.count}`).join(' · ')}`)
  if (calls.skills.length) L.push(`- **Skill**：${calls.skills.map((s) => `${safeReportLabel(s.name)}×${s.count}`).join(' · ')}`)
  if (calls.agents.length) L.push(`- **子 Agent**：${calls.agents.map((a) => `${safeReportLabel(a.name)}×${a.count}`).join(' · ')}`)
  if (calls.mcp.length) L.push(`- **MCP**：${calls.mcp.map((g) => `${safeReportLabel(g.server)}×${g.total}`).join(' · ')}`)
  if (segs.some((s) => s.skill !== '（无 skill）'))
    L.push(`- **段落(按 skill)**：${segs.map((s) => `${s.skill} ${s.tools} 工具`).join(' · ')}`)
  if (cov.written > 0)
    L.push(
      `- **文件（工具证据）**：改 ${cov.written}（先读 ${cov.readBefore}/${cov.written}${cov.inferredReadBefore ? `，其中 ${cov.inferredReadBefore} 个仅有 Bash 推断` : ''}${cov.blind.length ? `，无先读证据 ${cov.blind.length}` : ''}）`
    )
  L.push(workspaceDiffCopy.report(gitDiff, diffUntouched.length))
  if (dangers.length)
    L.push(
      `- **危险审计**：${dangers.map((e) => `[${e.danger!.level === 'danger' ? '高危' : '可疑'}] ${e.danger!.reason}`).join(' · ')}`
    )

  // 从真实数据派生的优化提示（有就列，没有不编）
  const hints: string[] = []
  if (cov.blind.length)
    hints.push(
      `${cov.blind.length} 个文件首次写入前无读取证据（可能仍有未识别的 Bash/MCP 读取）：${cov.blind.map(basename).join('、')}`
    )
  if (toolErrors > 0) hints.push(`工具失败 ${toolErrors} 次，检查报错卡片`)
  if (diffUntouched.length) hints.push(`${diffUntouched.length} 个文件被改但不在工具足迹里（Bash/MCP 盲区）`)
  if (dangers.length) hints.push(`${dangers.length} 处危险操作（审计放行，未拦截）`)
  if (hints.length) {
    L.push('', '## 提示（本会话数据）')
    for (const h of hints) L.push(`- ${h}`)
  }
  return L.join('\n')
}
