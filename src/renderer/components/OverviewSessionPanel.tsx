// 总览「会话数据」页：结构化介入、TOP TOOLS、危险审计、段落、调用明细、文件足迹与会话 diff。
import type { ReactNode } from 'react'
import { workspaceDiffCopy } from '@shared/constants/copy'
import type { TraceEvent, WorkspaceDiffResult } from '@shared/trace'
import { basename, fileBadge } from '../format'
import { displayDiffPath } from '../turn-diff'
import { Icon } from './primitives/Icon'
import { OverviewHooksSection } from './OverviewHooksSection'
import { fileOperationText, formatTurnDuration } from './overview-turn-calls'
import { isInferredSkillLoad } from '../skill-load-evidence'
import type { OverviewPanelModel } from './overview-panel-model'
import { topToolColor } from './overview-tool-colors'

export function OverviewSessionPanel({
  model,
  filesFolded,
  onToggleFiles,
  jumpTo,
  onSelect,
  onOpenTurn,
  onOpenSessionDiff,
  gitDiff,
  gitDiffRefreshing
}: {
  model: OverviewPanelModel
  filesFolded: boolean
  onToggleFiles: () => void
  jumpTo: (pred: (e: TraceEvent) => boolean) => void
  onSelect: (ev: TraceEvent) => void
  onOpenTurn?: (runId: string, ev?: TraceEvent | null, target?: 'turn' | 'event') => void
  onOpenSessionDiff?: (path?: string) => void
  gitDiff?: WorkspaceDiffResult | null
  gitDiffRefreshing: boolean
}): ReactNode {
  const {
    turns,
    sessionInterventions,
    sessionQuestions,
    sessionWaitMs,
    sessionClarifications,
    sessionPermissions,
    calls,
    logicalCallEvents,
    topTools,
    hookSummary,
    dangers,
    hasSkillSeg,
    segments,
    structured,
    coverage,
    sessionNetDiff,
    sessionActivity,
    sessionNetHeading,
    sessionNetTitle,
    sessionNetSource,
    sessionDiffRepoRoot,
    diffFiles,
    diffAdd,
    diffDel
  } = model
  return (
    <>
      {sessionInterventions.length > 0 && (
        <div className="panel-section intervention-summary-section">
          <h4>
            结构化介入
            <span className="more">本会话 {sessionInterventions.length} 次 · {sessionQuestions} 个问题</span>
          </h4>
          <div className="intervention-summary-grid">
            <div><span>需求澄清</span><b>{sessionClarifications}</b></div>
            <div><span>权限确认</span><b>{sessionPermissions}</b></div>
            <div><span>累计等待</span><b>{formatTurnDuration(sessionWaitMs) ?? '0.0s'}</b></div>
          </div>
        </div>
      )}
      {topTools.rows.length > 0 && (
        <div className="panel-section top-tools-section">
          <h4>
            TOP TOOLS<span className="more">工具 {calls.ordinaryToolTotal} · MCP {calls.mcpTotal}</span>
          </h4>
          {topTools.rows.map((t) => {
            const c = topToolColor(t.name)
            return (
              <button
                type="button"
                className="toptool"
                key={t.name}
                onClick={() =>
                  jumpTo((e) =>
                    e.stage !== 'tool_result' &&
                    (t.name.startsWith('mcp:') ? e.mcpServer === t.name.slice(4) : e.tool === t.name)
                  )
                }
                title="点定位首次调用"
              >
                <span className={`tt-nm ${c}`}>{t.name}</span>
                <span className="tt-n">{t.count}</span>
                <span className={`mini-bar ${c}`}>
                  <i style={{ width: `${Math.round((t.count / topTools.max) * 100)}%` }} />
                </span>
              </button>
            )
          })}
        </div>
      )}

      {turns.length > 0 && <OverviewHooksSection hookSummary={hookSummary} onSelect={onSelect} />}

      {dangers.length > 0 && (
        <div className="panel-section danger-audit-section">
          <h4>
            <Icon name="alert" /> 危险操作审计（本会话）
          </h4>
          {dangers.map((e) => (
            <button
              type="button"
              className="callrow danger-audit-row"
              key={e.id}
              onClick={() => (onOpenTurn ? onOpenTurn(e.runId, e, 'event') : onSelect(e))}
              title={`跳到左侧对话中的这次 ${e.tool ?? e.name ?? '危险'} 调用`}
              aria-label={`跳到左侧对话中的这次 ${e.tool ?? e.name ?? '危险'} 调用：${e.danger!.reason}`}
            >
              <span className={`sdot ${e.danger!.level === 'danger' ? 'bad' : 'warn'}`} />
              <span className="fname" title={e.danger!.reason}>
                {e.danger!.reason}
              </span>
              <span className="dim">{e.tool ?? e.name}</span>
              <Icon name="chevronRight" className="danger-audit-jump" />
            </button>
          ))}
          <div className="psrc">观测标记（不阻塞、默认放行）· 已入库为 span</div>
        </div>
      )}

      {hasSkillSeg && (
        <div className="panel-section segment-section">
          <h4>
            段落（按 skill）
            <span className="more">{segments.length} 段</span>
          </h4>
          <div className="segment-list">
            {segments.map((s, i) => (
              <div className={`segment-row ${s.errors > 0 ? 'has-error' : ''}`} key={`${s.skill}-${i}`}>
                <span className="segment-index">{i + 1}</span>
                <span className="segment-name" title={s.skill}>
                  {s.skill === '（无 skill）' ? (
                    s.skill
                  ) : (
                    <>
                      <Icon name="box" /> {s.skill}
                    </>
                  )}
                </span>
                <span className="segment-metrics" aria-label={`${s.skill} 段指标`}>
                  <span className="seg-chip tool" title="普通工具调用数，不含子 agent">
                    <span>工具</span>
                    <b>{s.tools}</b>
                  </span>
                  {s.agents > 0 && (
                    <span className="seg-chip agent" title="子 agent / Task 调用数">
                      <span>子Agent</span>
                      <b>{s.agents}</b>
                    </span>
                  )}
                  {s.reads > 0 && (
                    <span className="seg-chip read" title="结构化读文件次数">
                      <span>读</span>
                      <b>{s.reads}</b>
                    </span>
                  )}
                  {s.writes > 0 && (
                    <span className="seg-chip write" title="结构化写入或编辑文件次数">
                      <span>写</span>
                      <b>{s.writes}</b>
                    </span>
                  )}
                  {s.errors > 0 && (
                    <span className="seg-chip err" title="本段错误次数">
                      <span>错误</span>
                      <b>{s.errors}</b>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="psrc">按实际 skill 调用切段 · tool 与子 agent 分开统计 · 不绑特定 workflow</div>
        </div>
      )}

      {(
        <div className="panel-section">
          <h4>调用明细（本会话）</h4>

          <div className="psub">Skill</div>
          {calls.skills.length === 0 ? (
            <div className="dim pad2">尚未观测到 Skill 调用或加载证据</div>
          ) : (
            calls.skills.map((s) => (
              <button
                type="button"
                className="callrow"
                key={s.name}
                onClick={() => jumpTo((e) => logicalCallEvents.some((call) => call.kind === 'skill' && call.name === s.name && call.id === e.id && call.runId === e.runId))}
                title="点查看原始 Skill 调用或文件加载证据；加载推断不等于原生 Skill 调用"
              >
                <span className="ckind">
                  <Icon name="box" />
                </span>
                <span className="fname" title={s.name}>
                  {s.name}{logicalCallEvents.some((event) => event.name === s.name && isInferredSkillLoad(event)) ? '（含加载推断）' : ''}
                </span>
                <span className="dim">{s.count}×</span>
              </button>
            ))
          )}

          <div className="psub">MCP</div>
          {calls.mcp.length === 0 ? (
            <div className="dim pad2">本会话无 MCP 调用</div>
          ) : (
            calls.mcp.map((g) => (
              <div key={g.server}>
                <div className="callserver">
                  <span className="ckind">
                    <Icon name="cube" />
                  </span>
                  <span className="fname">{g.server}</span>
                  <span className="dim">{g.total}×</span>
                </div>
                {g.actions.map((a) => (
                  <button
                    type="button"
                    className="callrow indent"
                    key={a.tool}
                    onClick={() => jumpTo((e) => (e.mcpTool ?? e.tool) === a.tool && e.stage !== 'tool_result')}
                    title={a.tool}
                  >
                    <span className="fname">{a.action}</span>
                    <span className="dim">{a.count}×</span>
                  </button>
                ))}
              </div>
            ))
          )}

          {calls.agents.length > 0 && (
            <>
              <div className="psub">子 Agent</div>
              {calls.agents.map((a) => (
                <button
                  type="button"
                  className="callrow"
                  key={a.name}
                  onClick={() => jumpTo((e) => e.kind === 'agent' && e.name === a.name && e.stage !== 'tool_result')}
                  title="点查看这次子 agent 调用的详情"
                >
                  <span className="ckind">
                    <Icon name="cube" />
                  </span>
                  <span className="fname" title={a.name}>
                    {a.name}
                  </span>
                  <span className="dim">{a.count}×</span>
                </button>
              ))}
            </>
          )}

          <div className="psub">工具</div>
          {calls.tools.length === 0 ? (
            <div className="dim pad2">本会话无工具调用</div>
          ) : (
            calls.tools.map((t) => (
              <button
                type="button"
                className="callrow"
                key={t.name}
                onClick={() =>
                  jumpTo((e) => e.kind === 'tool' && !e.isMcp && e.tool === t.name && e.stage !== 'tool_result')
                }
                title="点查看这次工具调用的详情"
              >
                <span className="ckind">
                  <Icon name="tool" />
                </span>
                <span className="fname" title={t.name}>
                  {t.name}
                </span>
                <span className="dim">{t.count}×</span>
              </button>
            ))
          )}
        </div>
      )}

      {(
        <div className="panel-section">
          <h4>
            <button
              type="button"
              className="panel-section-heading"
              title="R/W/E 来自结构化文件工具；~R 来自 cat、sed、rg 等只读 Bash 命令推断，其他间接文件访问仍可能未统计"
              aria-expanded={!filesFolded}
              aria-controls="overview-file-footprint"
              onClick={onToggleFiles}
            >
              文件足迹（全会话 · 工具证据）
              <span className="more">
                {structured.length} files <Icon name={filesFolded ? 'chevronRight' : 'chevronDown'} />
              </span>
            </button>
          </h4>
          {!filesFolded && (
            <div id="overview-file-footprint">
              {coverage.written > 0 && (
                <div className="covrow">
                  改 {coverage.written} · 先读 {coverage.readBefore}/{coverage.written}
                  {coverage.inferredReadBefore > 0 && (
                    <span className="dim">（含 ~{coverage.inferredReadBefore} Bash 推断）</span>
                  )}
                  {coverage.blind.length > 0 && (
                    <span
                      className="cov-warn"
                      title={`以下文件首次修改前没有捕获到 Read 或可识别的只读 Bash 证据；仍可能存在未识别的间接读取：\n${coverage.blind.join('\n')}`}
                    >
                      {' '}
                      · <Icon name="alert" /> {coverage.blind.length} 无先读证据
                    </span>
                  )}
                </div>
              )}
              {structured.length === 0 && <div className="dim pad">暂无</div>}
              {structured.map((f) => (
                <button
                  type="button"
                  className="filerow click"
                  key={f.path}
                  onClick={() => jumpTo((e) => e.filePath === f.path && e.stage !== 'tool_result')}
                  title={f.path}
                >
                  <span className={`fbadge ${fileBadge(f).toLowerCase()}`}>{fileBadge(f)}</span>
                  <span className="fname">{basename(f.path)}</span>
                  <span className="dim fops">{fileOperationText(f)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {(sessionNetDiff || sessionActivity.turnCount > 0) && (
        <div className="panel-section">
          <h4>
            {onOpenSessionDiff ? (
              <button
                type="button"
                className="panel-section-heading"
                title={sessionNetTitle}
                onClick={() => onOpenSessionDiff()}
              >
                {sessionNetHeading}
                <span className="more">
                  {(sessionNetDiff?.files ?? sessionActivity.files).length} files · +{sessionNetDiff?.added ?? sessionActivity.added} −{sessionNetDiff?.deleted ?? sessionActivity.deleted}{' '}
                  <Icon name="chevronRight" />
                </span>
              </button>
            ) : (
              <>
                {sessionNetHeading}
                <span className="more">
                  {(sessionNetDiff?.files ?? sessionActivity.files).length} files · +{sessionNetDiff?.added ?? sessionActivity.added} −{sessionNetDiff?.deleted ?? sessionActivity.deleted}
                </span>
              </>
            )}
          </h4>
          {(sessionNetDiff?.files ?? sessionActivity.files).map((file) =>
            onOpenSessionDiff ? (
              <button
                type="button"
                className="gdrow click"
                key={file.path}
                title={sessionNetDiff ? `${file.path} · 在右侧会话 Diff 中打开` : `${file.path} · 在右侧最近一轮 Diff 中打开`}
                onClick={() => onOpenSessionDiff(file.path)}
              >
                <span className="gd-path">{displayDiffPath(file.path, sessionDiffRepoRoot)}</span>
                {'turns' in file && file.turns > 1 && <span className="dim">{file.turns} 轮</span>}
                {file.binary && !file.added && !file.deleted ? (
                  <span className="dim">binary</span>
                ) : (
                  <>
                    <span className="gd-add">+{file.added}</span>
                    <span className="gd-del">−{file.deleted}</span>
                  </>
                )}
                <Icon name="chevronRight" className="gd-open" />
              </button>
            ) : (
              <div className="gdrow" key={file.path} title={file.path}>
                <span className="gd-path">{displayDiffPath(file.path, sessionDiffRepoRoot)}</span>
                {'turns' in file && file.turns > 1 && <span className="dim">{file.turns} 轮</span>}
                <span className="gd-add">+{file.added}</span>
                <span className="gd-del">−{file.deleted}</span>
              </div>
            )
          )}
          <div className="psrc">
            {sessionNetSource}
          </div>
        </div>
      )}

      {gitDiff !== undefined &&
        (() => {
          // P2 §8.4：工具足迹 vs 工作区 diff 对照——diff 里的文件，工具碰过标 check，没碰过标 alert
          const touched = new Set(structured.map((f) => f.path))
          return (
            <div className="panel-section">
              <h4>
                {workspaceDiffCopy.overviewHeading}
                <span className="more" role="status" data-evidence={gitDiffRefreshing ? 'refreshing' : gitDiff?.status ?? 'pending'} title={workspaceDiffCopy.detail(gitDiff)}>
                  {gitDiff?.status === 'captured' && diffFiles.length
                    ? workspaceDiffCopy.totals(diffFiles.length, diffAdd, diffDel)
                    : workspaceDiffCopy.label(gitDiff)}
                </span>
              </h4>
              <div className="psrc" role="status">{workspaceDiffCopy.freshness(gitDiff, gitDiffRefreshing)}</div>
              {diffFiles.map((d) => (
                <div className="gdrow" key={d.path} title={d.path}>
                  <span className={`gd-mark ${touched.has(d.path) ? 'gd-add' : 'gd-del'}`}>
                    <Icon name={touched.has(d.path) ? 'check' : 'alert'} />
                  </span>
                  <span className="gd-path">{basename(d.path)}</span>
                  {d.binary ? (
                    <span className="dim">{workspaceDiffCopy.binary}</span>
                  ) : (
                    <>
                      <span className="gd-add">+{d.added}</span>
                      <span className="gd-del">−{d.deleted}</span>
                    </>
                  )}
                </div>
              ))}
              <div className="psrc">
                {workspaceDiffCopy.scope}
              </div>
            </div>
          )
        })()}
    </>
  )
}
