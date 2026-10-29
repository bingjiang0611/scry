// 总览「每轮调用」区与单轮文件足迹：点行定位到对话，展开看耗时、介入、Hook 与文件证据。
import type { MouseEvent, ReactNode } from 'react'
import type { TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import type { FileRow } from '../format'
import { basename, fileBadge } from '../format'
import { displayDiffPath } from '../turn-diff'
import { TurnToolErrorDetails } from './OverviewToolErrors'
import { HooksSummary } from './ChatTurn'
import { Icon } from './primitives/Icon'
import { TurnTimingDetails } from './TurnTimingDetails'
import {
  InterventionDetails,
  diffChangeBadge,
  fileOperationText,
  renderTurnCallDetail,
  renderTurnDetailToggle,
  turnFileCount,
  type TurnCallRow
} from './overview-turn-calls'

export function TurnFileFootprint({
  files,
  turnDiff,
  preview = false
}: {
  files: FileRow[]
  turnDiff?: TurnDiffSnapshot
  preview?: boolean
}) {
  const hasDiff = turnDiff?.status === 'captured'
  const diffFiles = hasDiff ? turnDiff.files : []
  const count = hasDiff ? diffFiles.length : files.length
  return (
    <section
      className="turn-file-footprint"
      aria-label="本轮文件足迹"
      title={hasDiff
        ? '文件集合与行数来自 Git 净改动；匹配到结构化工具证据时显示 W/E，否则显示 Git 的 A/M/D。只有 Git 快照不可用时才降级到工具足迹'
        : 'R/W/E 来自本轮结构化文件工具；~R 来自本轮 cat、sed、rg 等只读 Bash 命令推断，其他间接文件访问仍可能未统计'}
    >
      <div className="turn-file-heading">
        <span><Icon name="file" /> {hasDiff ? `本轮改动（Git 证据${preview ? ' · 运行中预览' : ''}）` : '本轮文件足迹（工具证据）'}</span>
        <span>{count} files</span>
      </div>
      {hasDiff ? (
        <div className="turn-file-list">
          {diffFiles.map((file) => {
            const badge = diffChangeBadge(file, files)
            return (
              <div className="turn-file-row" key={file.path} title={file.path}>
                <span className={`fbadge ${badge.tone}`} title={badge.title} aria-label={badge.title}>{badge.label}</span>
                <span className="fname">{displayDiffPath(file.path, turnDiff?.repoRoot)}</span>
                <span className="fops">{file.binary ? 'binary' : `+${file.added} −${file.deleted}`}</span>
              </div>
            )
          })}
        </div>
      ) : files.length === 0 ? (
        <div className="turn-file-empty">暂无文件工具证据</div>
      ) : (
        <div className="turn-file-list">
          {files.map((file) => (
            <div className="turn-file-row" key={file.path} title={file.path}>
              <span className={`fbadge ${fileBadge(file).toLowerCase()}`}>{fileBadge(file)}</span>
              <span className="fname">{basename(file.path)}</span>
              <span className="fops">{fileOperationText(file)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}


export function OverviewTurnCalls({
  rows,
  expanded,
  onToggle,
  selected,
  onSelect,
  onOpenTurn,
  remote
}: {
  rows: TurnCallRow[]
  expanded: Set<string>
  onToggle: (key: string, event: MouseEvent<HTMLButtonElement>) => void
  selected: TraceEvent | null
  onSelect: (ev: TraceEvent) => void
  onOpenTurn?: (runId: string, ev?: TraceEvent | null, target?: 'turn' | 'event') => void
  remote: boolean
}): ReactNode {
  return (
    <>

      {rows.length > 0 && (
        <div className="panel-section turn-calls-section">
          <h4>
            每轮调用
            <span className="more">{rows.length} turns</span>
          </h4>
          <div className="turn-call-list">
            {rows.map((row) => {
              const mcpKey = `${row.runId}:mcp`
              const skillKey = `${row.runId}:skill`
              const hooksKey = `${row.runId}:hooks`
              const fileKey = `${row.runId}:file`
              const timingKey = `${row.runId}:timing`
              const interventionKey = `${row.runId}:intervention`
              const mcpCount = row.groups.mcp.reduce((sum, item) => sum + item.count, 0)
              const skillCount = row.groups.skill.reduce((sum, item) => sum + item.count, 0)
              const agentCount = row.groups.agent.reduce((sum, item) => sum + item.count, 0)
              const hooksCount = row.hooks.logicalRuns
              const timingAvailable = Boolean(
                row.timing.turnWall != null || row.timing.providerTiming?.totalMs != null || row.timing.providerTiming?.apiMs != null ||
                row.timing.apiMs != null || row.timing.totalCalls > 0
              )
              const mcpExpanded = mcpCount > 0 && expanded.has(mcpKey)
              const skillExpanded = skillCount > 0 && expanded.has(skillKey)
              const hooksExpanded = hooksCount > 0 && expanded.has(hooksKey)
              const fileExpanded = row.files.length > 0 && expanded.has(fileKey)
              const timingExpanded = timingAvailable && expanded.has(timingKey)
              const interventionExpanded = row.interventions.length > 0 && expanded.has(interventionKey)
              const timingToggleLabel = `${timingExpanded ? '收起' : '展开'}第 ${row.turnNo} 轮耗时明细`
              const action = (): void => {
                if (onOpenTurn) {
                  onOpenTurn(row.runId, row.firstEvent ?? row.result)
                  return
                }
                if (row.firstEvent) onSelect(row.firstEvent)
              }
              const label = `跳到第 ${row.turnNo} 轮，对话中共 ${row.total} 次工具/Skill/MCP/子 Agent 调用`
              const isSelectedTurn = selected?.runId === row.runId
              return (
                <div
                  className={`turn-call-row ${isSelectedTurn ? 'is-selected' : ''}`}
                  key={row.runId}
                  title={row.userText || label}
                >
                  <button
                    type="button"
                    className="turn-id turn-call-open"
                    onClick={action}
                    title={label}
                    aria-label={label}
                    aria-current={isSelectedTurn ? 'true' : undefined}
                  >
                    T{String(row.turnNo).padStart(2, '0')}
                  </button>
                  <div className="turn-call-main">
                    {row.userText && (
                      <div className="turn-call-head">
                        <span className="turn-call-preview">{row.userText}</span>
                      </div>
                    )}
                    <div className="turn-call-groups">
                      {row.errors.length > 0 && (
                        <span className="turn-call-group error" title={`本轮 ${row.errors.length} 处工具报错，详情见下方`}>
                          <span className="turn-call-kind">报错</span>
                          <span className="turn-call-count">{row.errors.length}</span>
                        </span>
                      )}
                      {timingAvailable && (
                        <button
                          type="button"
                          className="turn-call-group turn-call-toggle timing"
                          title={timingExpanded ? '收起耗时明细' : '查看耗时来源与统计范围'}
                          aria-label={timingToggleLabel}
                          aria-expanded={timingExpanded}
                          aria-controls={`turn-timing-${row.turnNo}`}
                          onClick={(event) => onToggle(timingKey, event)}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <span className="turn-call-kind">耗时</span>
                          <span className="turn-call-count">2 项</span>
                          <span className="turn-call-toggle-icon">
                            <Icon name={timingExpanded ? 'chevronDown' : 'chevronRight'} />
                          </span>
                        </button>
                      )}
                      {renderTurnDetailToggle({
                        kind: 'intervention', count: row.interventions.length, expanded: interventionExpanded,
                        controls: `turn-interventions-${row.turnNo}`,
                        onToggle: (event) => onToggle(interventionKey, event)
                      })}
                      {renderTurnDetailToggle({
                        kind: 'mcp', count: mcpCount, expanded: mcpExpanded,
                        controls: `turn-mcp-${row.turnNo}`,
                        onToggle: (event) => onToggle(mcpKey, event)
                      })}
                      {renderTurnDetailToggle({
                        kind: 'skill', count: skillCount, expanded: skillExpanded,
                        controls: `turn-skill-${row.turnNo}`,
                        onToggle: (event) => onToggle(skillKey, event)
                      })}
                      <span
                        className={`turn-call-group agent${agentCount === 0 ? ' empty' : ''}`}
                        title={`本轮子 Agent 调用 ${agentCount} 次`}
                      >
                        <span className="turn-call-kind">子Agent</span>
                        <span className="turn-call-count">{agentCount}</span>
                      </span>
                      {renderTurnDetailToggle({
                        kind: 'hooks', count: hooksCount, expanded: hooksExpanded,
                        controls: `turn-hooks-${row.turnNo}`,
                        onToggle: (event) => onToggle(hooksKey, event)
                      })}
                      {renderTurnDetailToggle({
                        kind: 'file', count: turnFileCount(row), expanded: fileExpanded,
                        controls: `turn-files-${row.turnNo}`,
                        onToggle: (event) => onToggle(fileKey, event)
                      })}
                    </div>
                  </div>
                  {(row.errors.length > 0 || timingExpanded || interventionExpanded || mcpExpanded || skillExpanded || hooksExpanded || fileExpanded) && (
                    <div className="turn-call-detail-slot">
                      {row.errors.length > 0 && (
                        <TurnToolErrorDetails
                          errors={row.errors}
                          remote={remote}
                          onOpen={(error) => {
                            if (onOpenTurn) onOpenTurn(row.runId, error.event, 'event')
                            else onSelect(error.event)
                          }}
                        />
                      )}
                      {timingExpanded && (
                        <div id={`turn-timing-${row.turnNo}`}>
                          <TurnTimingDetails timing={row.timing} />
                        </div>
                      )}
                      {interventionExpanded && (
                        <div id={`turn-interventions-${row.turnNo}`}>
                          <InterventionDetails interventions={row.interventions} />
                        </div>
                      )}
                      {mcpExpanded && (
                        <div id={`turn-mcp-${row.turnNo}`}>{renderTurnCallDetail('mcp', row.groups.mcp)}</div>
                      )}
                      {skillExpanded && (
                        <div id={`turn-skill-${row.turnNo}`}>{renderTurnCallDetail('skill', row.groups.skill)}</div>
                      )}
                      {hooksExpanded && (
                        <div id={`turn-hooks-${row.turnNo}`}><HooksSummary summary={row.hooks} title="Hooks 明细" defaultExpanded /></div>
                      )}
                      {fileExpanded && (
                        <div id={`turn-files-${row.turnNo}`}>
                          <TurnFileFootprint
                            files={row.files}
                            preview={row.turnDiffPreview}
                            {...(row.turnDiff ? { turnDiff: row.turnDiff } : {})}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
