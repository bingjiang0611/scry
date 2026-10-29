// 每轮调用证据的聚合与明细渲染：工具/Skill/MCP/子 Agent 计数、耗时明细与文件足迹。
import type { MouseEvent, ReactNode } from 'react'
import type { AgentIntervention } from '@shared/runtime'
import type { DiffFile, TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import type { FileRow, HookSummary } from '../format'
import { isInferredSkillLoad } from '../skill-load-evidence'
import type { TurnTimingBreakdown } from '../turn-timing'
import { Icon } from './primitives/Icon'
import type { OverviewToolError } from './OverviewToolErrors'

export type TurnCallKind = 'tool' | 'mcp' | 'skill' | 'agent'

export interface TurnCallItem {
  name: string
  count: number
}

export interface TurnCallRow {
  turnNo: number
  runId: string
  total: number
  firstEvent: TraceEvent | null
  result: TraceEvent | null
  groups: Record<TurnCallKind, TurnCallItem[]>
  userText: string
  timing: TurnTimingBreakdown
  files: FileRow[]
  turnDiff?: TurnDiffSnapshot
  turnDiffPreview: boolean
  hooks: HookSummary
  interventions: AgentIntervention[]
  errors: OverviewToolError[]
}

export function fileOperationText(file: FileRow): string {
  return [
    file.read - file.inferredRead > 0 && `R${file.read - file.inferredRead}`,
    file.inferredRead > 0 && `~R${file.inferredRead}`,
    file.write > 0 && `W${file.write}`,
    file.edit > 0 && `E${file.edit}`
  ].filter(Boolean).join(' ')
}

export function turnFileCount(row: Pick<TurnCallRow, 'files' | 'turnDiff'>): number {
  return row.turnDiff?.status === 'captured' ? row.turnDiff.files.length : row.files.length
}

export interface ChangeBadge {
  label: string
  tone: string
  title: string
}

function normalizedEvidencePath(path: string): string {
  return path.replaceAll('\\', '/')
}

export function diffChangeBadge(file: DiffFile, structured: FileRow[]): ChangeBadge {
  const path = normalizedEvidencePath(file.path)
  const tool = structured.find((candidate) => normalizedEvidencePath(candidate.path) === path)
  if (tool?.write) return { label: 'W', tone: 'w', title: 'W：本轮 Write 工具证据；文件与行数来自 Git 净改动' }
  if (tool?.edit) return { label: 'E', tone: 'e', title: 'E：本轮 Edit 工具证据；文件与行数来自 Git 净改动' }

  const inferredChange = file.change ?? (file.patch?.includes('\nnew file mode ') ? 'added' : file.patch?.includes('\ndeleted file mode ') ? 'deleted' : file.patch ? 'modified' : undefined)
  if (inferredChange === 'added') return { label: 'A', tone: 'a', title: 'A：Git 证明本轮新增文件；具体工具类型未观测' }
  if (inferredChange === 'modified') return { label: 'M', tone: 'm', title: 'M：Git 证明本轮修改文件；具体工具类型未观测' }
  if (inferredChange === 'deleted') return { label: 'D', tone: 'd', title: 'D：Git 证明本轮删除文件；具体工具类型未观测' }

  const label = file.added > 0 && file.deleted > 0 ? '±' : file.added > 0 ? '+' : file.deleted > 0 ? '−' : 'Δ'
  return { label, tone: 'delta', title: 'Git 证明文件有净改动；旧记录未采集新增/修改/删除状态' }
}


export function formatTurnDuration(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`

  const totalSeconds = Math.round(ms / 1000)
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

export const TURN_CALL_KIND_LABEL: Record<TurnCallKind, string> = {
  tool: '工具',
  mcp: 'MCP',
  skill: 'Skill',
  agent: '子Agent'
}

export function addTurnCall(map: Map<string, number>, name: string): void {
  map.set(name, (map.get(name) ?? 0) + 1)
}

export function turnCallRowsFromMap(map: Map<string, number>, preserveCallOrder = false): TurnCallItem[] {
  const rows = [...map.entries()].map(([name, count]) => ({ name, count }))
  return preserveCallOrder ? rows : rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export { logicalCallEventsForTurn } from '../format'

export function turnCallLabel(ev: TraceEvent, kind: TurnCallKind): string {
  if (kind === 'mcp') {
    const server = ev.mcpServer ?? 'mcp'
    return ev.mcpAction ? `${server}.${ev.mcpAction}` : server
  }
  if (kind === 'skill') return `${ev.name ?? 'Skill'}${isInferredSkillLoad(ev) ? '（加载推断）' : ''}`
  if (kind === 'agent') return ev.name ?? 'Task'
  return ev.tool ?? ev.name ?? ev.stage
}

export function turnCallKind(ev: TraceEvent): TurnCallKind | null {
  if (ev.stage === 'tool_result') return null
  if (ev.kind === 'skill') return 'skill'
  if (ev.kind === 'agent') return 'agent'
  if (ev.kind === 'tool' && ev.isMcp) return 'mcp'
  if (ev.kind === 'tool') return 'tool'
  return null
}

export function turnUserPreview(text: string): string {

  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 48) ?? ''
}

export type TurnDetailKind = 'mcp' | 'skill' | 'hooks' | 'file' | 'intervention'

export const TURN_DETAIL_LABEL: Record<TurnDetailKind, string> = {
  mcp: 'MCP',
  skill: 'Skill',
  hooks: 'Hooks',
  file: '文件',
  intervention: '结构化介入'
}

export function humanInterventions(events: TraceEvent[]): AgentIntervention[] {
  return events
    .flatMap((event) => event.intervention ? [event.intervention] : [])
    .filter((intervention) => intervention.resolution !== 'provider_cancelled')
}

export function InterventionDetails({ interventions }: { interventions: AgentIntervention[] }): ReactNode {
  return (
    <div className="turn-intervention-detail">
      {interventions.map((intervention, interventionIndex) => (
        <div className="turn-intervention" key={intervention.request.questionId}>
          <div className="turn-intervention-head">
            <span>#{interventionIndex + 1} · {intervention.kind === 'permission' ? '权限确认' : '需求澄清'}</span>
            <small>
              {intervention.request.providerId ?? 'agent'} · {formatTurnDuration(intervention.durationMs) ?? '0.0s'}
            </small>
          </div>
          {intervention.request.questions.map((question) => (
            <div className="turn-intervention-answer" key={question.question}>
              <span title={question.question}>{question.header} · {question.question}</span>
              <b>
                {intervention.response.behavior === 'answered'
                  ? intervention.response.answers[question.question]
                  : '用户取消'}
              </b>
            </div>
          ))}
          <div className="turn-intervention-source">{intervention.source}</div>
        </div>
      ))}
    </div>
  )
}

export function renderTurnDetailToggle(args: {
  kind: TurnDetailKind
  count: number
  expanded: boolean
  controls: string
  onToggle: (ev: MouseEvent<HTMLButtonElement>) => void
}): ReactNode {
  const label = TURN_DETAIL_LABEL[args.kind]
  const available = args.count > 0
  return (
    <button
      type="button"
      className={`turn-call-group turn-call-toggle ${args.kind}`}
      title={available ? `${args.expanded ? '收起' : '展开'} ${label} 明细` : `本轮无 ${label} 明细`}
      aria-label={`${label} ${args.count}${available ? `，${args.expanded ? '收起' : '展开'}明细` : '，无明细'}`}
      aria-expanded={available ? args.expanded : false}
      aria-controls={available ? args.controls : undefined}
      disabled={!available}
      onClick={args.onToggle}
      onKeyDown={(ev) => ev.stopPropagation()}
    >
      <span className="turn-call-kind">{label}</span>
      <span className="turn-call-count">{args.count}</span>
      <span className="turn-call-toggle-icon">
        <Icon name={args.expanded ? 'chevronDown' : 'chevronRight'} />
      </span>
    </button>
  )
}

export function renderTurnCallDetail(kind: 'mcp' | 'skill', items: TurnCallItem[]): ReactNode {
  if (items.length === 0) return null
  return (
    <div className={`turn-call-detail ${kind}`} onClick={(ev) => ev.stopPropagation()}>
      <div className="turn-call-detail-title">{TURN_CALL_KIND_LABEL[kind]} 明细</div>
      {items.map((item) => (
        <div className="turn-call-detail-row" key={`${kind}-${item.name}`} title={`${item.name} ${item.count}×`}>
          <span className="turn-call-detail-name">{item.name}</span>
          {item.count > 1 && <span className="turn-call-detail-count">{item.count}×</span>}
        </div>
      ))}
    </div>
  )
}

// 调用方已排除空值：空值且无归档引用才由 OVERVIEW_TOOL_ERROR_COPY.notReported 说明。
