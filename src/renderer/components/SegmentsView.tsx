// 分段视图（蓝本 segments.html）：把当前会话按活跃 context（baseline/skill/mcp/subagent）切段，
// ribbon 时间条 + 4 KPI 对比 + 段卡（token/api/工具/文件，全真实数据）。
// 数据走 aggregateSegmentsRich（renderer 纯函数，turn 粒度归集 token）——精确 active_skill 待后端 PR#7。
import { useMemo } from 'react'
import { aggregateSegmentsRich, fmtTok } from '../format'
import type { RichSegment, Turn } from '../format'
import { Icon } from './primitives/Icon'

const KIND_CLASS: Record<RichSegment['kind'], string> = {
  baseline: 'b-base',
  skill: 'b-skill1',
  mcp: 'b-mcp',
  subagent: 'b-agent'
}
const KIND_LABEL: Record<RichSegment['kind'], string> = {
  baseline: 'baseline',
  skill: 'skill',
  mcp: 'mcp call',
  subagent: 'subagent'
}
const KIND_VAR: Record<RichSegment['kind'], string> = {
  baseline: 'var(--dim3)',
  skill: 'var(--skill)',
  mcp: 'var(--mcp)',
  subagent: 'var(--agent)'
}
const KIND_GRAD: Record<RichSegment['kind'], string> = {
  baseline: 'rgba(95,108,135,0.18)',
  skill: 'rgba(246,197,96,0.18)',
  mcp: 'rgba(79,209,161,0.16)',
  subagent: 'rgba(201,139,255,0.16)'
}

function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

function turnRange(s: RichSegment): string {
  return s.turnStart === s.turnEnd ? `turn ${String(s.turnStart).padStart(2, '0')}` : `turns ${String(s.turnStart).padStart(2, '0')}–${String(s.turnEnd).padStart(2, '0')}`
}

export function SegmentsView({ turns }: { turns: Turn[] }) {
  const rep = useMemo(() => aggregateSegmentsRich(turns), [turns])
  const { segments } = rep

  if (segments.length === 0) {
    return (
      <main className="seg-pane">
        <div className="seg-empty">本会话还没有可切的段——发个任务后再看分段。</div>
      </main>
    )
  }

  // 4 KPI：最高 token 段 / 最慢段 / 最多工具 / 效率最差
  const tokenHeaviest = [...segments].sort((a, b) => b.totalTokens - a.totalTokens)[0]
  const slowest = [...segments]
    .filter((segment) => segment.apiMs != null)
    .sort((a, b) => (b.apiMs ?? 0) - (a.apiMs ?? 0))[0]
  const mostTools = [...segments].sort((a, b) => b.tools - a.tools)[0]
  const worst = [...segments].filter((s) => s.effFactor > 1).sort((a, b) => b.effFactor - a.effFactor)[0]
  const tokenPct = (s: RichSegment): number => (rep.totalTokens > 0 ? Math.round((s.totalTokens / rep.totalTokens) * 100) : 0)

  return (
    <main className="seg-pane">
      <div className="seg-note">
        <Icon name="info" /> 本会话按 turn 粒度切段；Token/API 只归到 turn context，子 agent 无独立 usage 时不伪造归属。
      </div>

      <div className="seg-shell">
        <div className="seg-ribbon">
          <h2>会话切成 {segments.length} 段</h2>
          <div className="sub">
            {rep.sessionTurns} turns · {fmtDur(rep.totalApiMs)} 总 API · {fmtTok(rep.totalTokens)} tok · skill 切换{' '}
            {rep.skillSwitches} 次 · subagent {rep.subagents} 次
          </div>
          <div className="seg-bar">
            {segments.map((s, i) => (
              <div
                key={i}
                className={KIND_CLASS[s.kind]}
                style={{ width: `${Math.max(s.pct, 3)}%` }}
                title={`${s.name} 段${rep.totalApiMs == null ? ' · API 未上报' : ` · ${s.pct.toFixed(0)}%`}`}
              >
                {s.pct >= 8 ? `${s.kind === 'baseline' ? '基线' : s.name} · ${s.pct.toFixed(0)}%` : ''}
              </div>
            ))}
          </div>
          <div className="seg-legend">
            <span className="item">
              <span className="sw" style={{ background: 'var(--dim3)' }} />
              baseline · 无 skill / agent
            </span>
            <span className="item">
              <span className="sw" style={{ background: 'var(--skill)' }} />
              skill · 注入
            </span>
            <span className="item">
              <span className="sw" style={{ background: 'var(--mcp)' }} />
              mcp · 外部调用
            </span>
            <span className="item">
              <span className="sw" style={{ background: 'var(--agent)' }} />
              subagent · Task
            </span>
          </div>
        </div>

        <div className="seg-compare">
          <div>
            <div className="lbl">最高 Token 段</div>
            <div className="val accent">{fmtTok(tokenHeaviest.totalTokens)}</div>
            <div className="sub">{tokenHeaviest.name} · {tokenPct(tokenHeaviest)}% 总 token</div>
          </div>
          <div>
            <div className="lbl">最慢段</div>
            <div className="val">{fmtDur(slowest?.apiMs)}</div>
            <div className="sub">
              {slowest ? `${slowest.name} · ${slowest.tools} 调用` : 'Provider 未上报 API 耗时'}
            </div>
          </div>
          <div>
            <div className="lbl">最多工具</div>
            <div className="val">{mostTools.tools}</div>
            <div className="sub">
              {mostTools.name} · {mostTools.acts.slice(0, 3).map((a) => a.label).join(' / ') || '—'}
            </div>
          </div>
          <div>
            <div className="lbl">效率最差</div>
            {worst ? (
              <>
                <div className="val" style={{ color: 'var(--warn)' }}>
                  {worst.effFactor.toFixed(1)}×
                </div>
                <div className="sub">
                  {worst.name} 重读 {worst.repeatReads} 次
                </div>
              </>
            ) : (
              <>
                <div className="val ok">1.0×</div>
                <div className="sub">无重复读</div>
              </>
            )}
          </div>
        </div>

        <div className="seg-list">
          {segments.map((s, i) => (
            <div className={`seg-card ${s.kind === 'subagent' ? 'sub' : ''}`} key={i}>
            <div className="seg-l" style={{ background: `linear-gradient(to bottom, ${KIND_GRAD[s.kind]}, transparent)` }}>
              <div className="kind" style={{ color: KIND_VAR[s.kind] }}>
                <span className="sw" style={{ background: KIND_VAR[s.kind] }} />
                {KIND_LABEL[s.kind]}
              </div>
              <h3>{s.name}</h3>
              <div className="when">
                {turnRange(s)} · <b>{fmtDur(s.apiMs)}</b>{rep.totalApiMs == null ? '' : ` · ${s.pct.toFixed(0)}%`}
              </div>
            </div>

            <div className="seg-m">
              <div className="seg-summary">
                {s.files.length > 0 ? (
                  <>
                    触及 <span className="dim">{s.files.join('、')}</span>
                    {s.files.length >= 4 ? ' 等' : ''}。
                  </>
                ) : (
                  <span className="dim">本段无结构化文件读写（工具/命令为主）。</span>
                )}
                {s.dangers > 0 && (
                  <span style={{ color: 'var(--bad)' }}>
                    {' '}
                    <Icon name="alert" /> {s.dangers} 处危险操作（审计放行）。
                  </span>
                )}
                {s.effFactor > 1 && (
                  <span style={{ color: 'var(--warn)' }}> 重复读 {s.repeatReads} 次，有压缩空间。</span>
                )}
              </div>
              <div className="seg-acts">
                {s.acts.slice(0, 6).map((a) => (
                  <span
                    className="seg-act"
                    key={a.label}
                    style={a.mcp ? { color: 'var(--mcp)', borderColor: 'rgba(79,209,161,0.32)' } : a.agent ? { color: 'var(--agent)', borderColor: 'rgba(201,139,255,0.32)' } : undefined}
                  >
                    {a.op ? <span className={`op ${a.op}`}>{a.label}</span> : a.label} <b>{a.count}</b>
                  </span>
                ))}
                {s.errors > 0 && (
                  <span className="seg-act" style={{ color: 'var(--bad)', borderColor: 'rgba(255,107,107,0.3)' }}>
                    err <b>{s.errors}</b>
                  </span>
                )}
              </div>
            </div>

            <div className="seg-r">
              <div className="m-stat">
                <div className="lbl">token</div>
                <div className="val accent">{fmtTok(s.totalTokens)}</div>
                <div className="delta">{tokenPct(s)}% 总 token</div>
              </div>
              <div className="m-stat">
                <div className="lbl">api</div>
                <div className="val">{fmtDur(s.apiMs)}</div>
              </div>
              <div className="m-stat">
                <div className="lbl">tools</div>
                <div className="val">{s.tools}</div>
              </div>
              <div className="m-stat">
                <div className="lbl">{s.effFactor > 1 ? '效率' : 'files'}</div>
                {s.effFactor > 1 ? (
                  <>
                    <div className="val warn">{s.effFactor.toFixed(1)}×</div>
                    <div className="delta">{s.repeatReads} 次重读</div>
                  </>
                ) : (
                  <div className="val">
                    {[s.reads && `${s.reads}R`, s.writes && `${s.writes}W`, s.edits && `${s.edits}E`]
                      .filter(Boolean)
                      .join(' ') || '—'}
                  </div>
                )}
              </div>
            </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
