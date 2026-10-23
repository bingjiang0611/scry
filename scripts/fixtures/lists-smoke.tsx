import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnalyticsView } from '../../src/renderer/components/AnalyticsView'
import { BackgroundWorkPanel } from '../../src/renderer/components/BackgroundWorkPanel'
import { ChatView } from '../../src/renderer/components/ChatView'
import { MetaPromptsView } from '../../src/renderer/components/MetaPromptsView'
import { SkillsModal, McpModal } from '../../src/renderer/components/Modals'
import { LlmPerformancePanel } from '../../src/renderer/components/LlmPerformancePanel'
import { Sidebar } from '../../src/renderer/components/Sidebar'
import { RightSurfacePanel } from '../../src/renderer/components/RightSurfacePanel'
import { writeMetaPrompts } from '../../src/renderer/meta-prompts'
import type { RightSurfaceKind } from '../../src/renderer/right-surface'
import type { QueuedPrompt } from '../../src/renderer/App'
import type { Turn } from '../../src/renderer/format'
import type { ProjectMeta, SessionMeta } from '../../src/renderer/env'
import type { UsageAnalytics, UsageAnalyticsAggregate, TraceEvent, ActiveRun } from '../../src/shared/trace'
import type { BackgroundWork } from '../../src/shared/background-work'
import { summarizeRunningLlmSessions, type LlmPerformanceHistoryRow } from '../../src/shared/llm-performance'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/analytics-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/codex-alignment.css'

// Real renderer components and DTOs, isolated memory-only state. No provider,
// process, IPC authority, real files, or personal localStorage is accessed.
localStorage.clear()
document.documentElement.dataset.platform = 'macos'
const copy = {
  chat: 'Chat', analytics: 'Analytics', resolve: 'Resolve analytics', refresh: 'Refresh data',
  append: 'Add session', large: 'Load 45 sessions', small: 'Restore sessions',
  history: 'History (50 tools)', live: 'Attach live run', tool: 'Append tool',
  text: 'Append text', hook: 'Append hook', complete: 'Complete run',
  skills: 'Skills', mcp: 'MCP', llm: 'LLM performance', meta: 'Meta Prompts',
  queue: 'Append queue', task: 'Append background task', surface: 'Add surface',
  shortSkill: 'Base directory for this skill: /fixture/skills/short\n\n# Short skill\n\nA bounded skill body.',
  title: 'List fixture', provider: 'Fixture model', surfaceBody: 'Surface content',
  prompt: 'Prompt fixture', description: 'Fixture capability', output: 'Fixture tool output'
}
const stamp = '2026-10-23T00:00:00Z'
const aggregate: UsageAnalyticsAggregate = {
  inputTokens: 1200, outputTokens: 600, cacheReadTokens: 120, cacheWriteTokens: 60, reasoningTokens: 0,
  costUsd: 1.2, turns: 12, usageRows: 12, inputKnownRows: 12, outputKnownRows: 12,
  cacheReadKnownRows: 12, cacheWriteKnownRows: 12, reasoningKnownRows: 12, tokenKnownRows: 12,
  costKnownRows: 12, exactCostRows: 12, providerReportedCostRows: 12, estimatedCostRows: 0, inferredCostRows: 0
}
const analytics: UsageAnalytics = {
  status: 'ready', rangeDays: 7, fromDay: '2026-10-17', toDay: '2026-10-23', observedAt: 1,
  days: ['2026-10-23'], totals: aggregate, byDay: [{ ...aggregate, day: '2026-10-23' }],
  dailyByProvider: [{ ...aggregate, day: '2026-10-23', provider: 'anthropic' }],
  byProvider: [{ ...aggregate, provider: 'anthropic', model: null }],
  byModel: Array.from({ length: 12 }, (_, index) => ({ ...aggregate, turns: 1, usageRows: 1,
    costUsd: (12 - index) / 100, provider: 'anthropic', model: `fixture-model-${String(index).padStart(2, '0')}` }))
}
const sessions: SessionMeta[] = Array.from({ length: 3 }, (_, index) => ({
  sessionId: `list-${index}`, externalSessionId: `list-${index}`, providerId: 'claude',
  preview: `Session ${index}`, mtime: 3 - index, count: 1
}))
const skills = Array.from({ length: 12 }, (_, index) => ({ name: `skill-${index}`, scope: 'project',
  description: copy.description, dir: `/fixture/skills/${index}`, enabled: true }))
const mcps = Array.from({ length: 12 }, (_, index) => ({ name: `server-${index}`, targetId: `server-${index}`,
  scope: 'project', transport: 'stdio', detail: '/fixture/server', enabled: true }))
const performance = { state: 'streaming' as const, observedAt: stamp, networkLabel: '', streamCharacters: 20,
  recentOutput: [], windowMs: 3000, streamDurationMs: 1000, outputTokens: 100,
  apiDurationMs: 1000, apiTokensPerSecond: 100, tokenTimingSource: 'observed_calls' as const, llmCalls: 1 }
const running: ActiveRun[] = Array.from({ length: 3 }, (_, index) => ({ runId: `perf-${index}`, providerId: 'claude',
  externalSessionId: `perf-${index}`, cwd: '/fixture/lists', done: false, items: [], userText: copy.prompt,
  llmPerformance: { ...performance, model: `model-${index}` } }))
const performanceRows: LlmPerformanceHistoryRow[] = Array.from({ length: 12 }, (_, index) => ({
  runId: `history-${index}`, ts: new Date(Date.now() - index * 60000).toISOString(), providerId: 'claude',
  model: `history-model-${index}`, networkLabel: '', failed: false,
  performance: { ...performance, state: 'complete' }
}))
Object.defineProperty(window, 'scry', { value: {
  copyText: async () => true,
  llmPerformanceSummary: async () => summarizeRunningLlmSessions(running),
  llmPerformanceHistory: async () => ({ rows: performanceRows, invalidLines: 0, truncated: false }),
  onDataUpdated: () => () => {},
  readRecorderContent: async () => { throw new Error('Fixture has no recorder content') }
} })
writeMetaPrompts(localStorage, Array.from({ length: 12 }, (_, index) => ({
  id: `prompt-${index}`, title: `Prompt ${index}`, body: `${copy.prompt} ${index}`
})))
const noop = (): void => {}
const agent = { id: 'claude', name: 'Claude Code', path: '/fixture/claude', bin: 'claude' }
function events(runId: string, count: number): TraceEvent[] {
  return Array.from({ length: count }, (_, index) => [
    { id: `${runId}-text-${index}`, runId, ts: stamp, kind: 'model' as const, stage: 'text', text: `Step ${index}\n` },
    { id: `${runId}-tool-${index}`, runId, ts: stamp, kind: 'tool' as const, stage: 'tool_use', tool: 'Read',
      fileOp: 'read' as const, filePath: `/fixture/file-${index}.ts`, input: { file_path: `/fixture/file-${index}.ts` },
      output: index === 49 ? Array.from({ length: 55 }, (_, line) => `line ${line}`).join('\n') : copy.output }
  ]).flat()
}
function makeTurn(runId: string, count: number, done: boolean): Turn {
  const items: TraceEvent[] = [{ id: `${runId}-thinking`, runId, ts: stamp, kind: 'model', stage: 'thinking', thinking: copy.description }, ...events(runId, count)]
  if (done) items.push({ id: `${runId}-result`, runId, ts: stamp, kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 20, durationMs: 500 })
  return { runId, providerId: 'claude', sessionId: 'lists', userText: copy.shortSkill, done, items }
}
function Fixture() {
  const [scene, setScene] = useState<'chat' | 'analytics' | 'meta' | 'tasks'>('chat')
  const [data, setData] = useState<UsageAnalytics | null>(null)
  const [catalog, setCatalog] = useState(sessions)
  const [turns, setTurns] = useState<Turn[]>([makeTurn('history', 50, true)])
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [cache, setCache] = useState(false)
  const [loading, setLoading] = useState(false)
  const [scope, setScope] = useState('lists-session')
  const [modal, setModal] = useState<'skills' | 'mcp' | 'llm' | null>(null)
  const [queued, setQueued] = useState<QueuedPrompt[]>([])
  const [tasks, setTasks] = useState<BackgroundWork['tasks']>([])
  const [surfaceIds, setSurfaceIds] = useState<RightSurfaceKind[]>(['overview', 'files'])
  const [activeSurface, setActiveSurface] = useState<RightSurfaceKind>('overview')
  const [refreshes, setRefreshes] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const projects: ProjectMeta[] = useMemo(() => [{ cwd: '/fixture/lists', name: copy.title, mtime: 1, sessions: catalog }], [catalog])
  const appendTool = (): void => setTurns(previous => previous.map(turn => ({ ...turn, items: [...turn.items,
    { id: `${turn.runId}-added-${turn.items.length}`, runId: turn.runId, ts: stamp, kind: 'tool', stage: 'tool_use',
      tool: 'Read', fileOp: 'read', filePath: '/fixture/added.ts', input: { file_path: '/fixture/added.ts' }, output: copy.output }
  ] })))
  const appendHook = (): void => setTurns(previous => previous.map(turn => ({ ...turn, items: [...turn.items,
    { id: 'hook-start', runId: turn.runId, ts: stamp, kind: 'hook', stage: 'hook_started', hookId: 'fixture-hook',
      hookEvent: 'PostToolUse', hookName: 'PostToolUse:Read', hookCommand: '/fixture/hook.sh' }
  ] })))
  const actions = {
    chat: () => setScene('chat'), analytics: () => { setScene('analytics'); setData(null) },
    resolve: () => setData(analytics), refresh: () => { setData(previous => previous && { ...previous, observedAt: previous.observedAt + 1 }); setRefreshes(value => value + 1) },
    append: () => setCatalog(previous => [{ ...sessions[0], sessionId: `new-${previous.length}`, preview: 'New session' }, ...previous]),
    large: () => setCatalog(Array.from({ length: 45 }, (_, index) => ({ ...sessions[0], sessionId: `large-${index}`, preview: `Large ${index}` }))),
    small: () => setCatalog(sessions), history: () => { setScene('chat'); setBusy(false); setTurns([makeTurn('history', 50, true)]) },
    live: () => { setScene('chat'); setBusy(true); setCache(false); setLoading(false); setTurns([makeTurn(`live-${Date.now()}`, 2, false)]) },
    tool: appendTool, text: () => setTurns(previous => previous.map(turn => {
      const last = turn.items.at(-1)
      return { ...turn, items: last?.stage === 'text_delta'
        ? [...turn.items.slice(0, -1), { ...last, text: `${last.text} streaming` }]
        : [...turn.items, { id: `${turn.runId}-tail`, runId: turn.runId, ts: stamp, kind: 'model', stage: 'text_delta', text: 'streaming' }] }
    })),

    hook: appendHook, complete: () => { setTurns(previous => previous.map(turn => ({ ...turn, done: true,
      items: [...turn.items, { id: `${turn.runId}-result`, runId: turn.runId, ts: stamp, kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 20, durationMs: 500 }] }))); setBusy(false) },
    skills: () => setModal('skills'), mcp: () => setModal('mcp'), llm: () => setModal('llm'), meta: () => setScene('meta'),
    queue: () => setQueued(previous => [...previous, { messageId: `queue-${previous.length}`, text: `${copy.prompt} ${previous.length}`, attachments: [], request: {} }]),
    task: () => { setScene('tasks'); setTasks(previous => [...previous, { taskId: `task-${previous.length}`, toolUseId: `task-${previous.length}`,
      tool: 'Bash', description: `${copy.description} ${previous.length}`, observedAt: Date.now() }]) },
    surface: () => { setSurfaceIds(previous => [...previous, 'diff']); setActiveSurface('diff') }
  }
  useEffect(() => {
    Object.assign(window, { listFixture: {
      setCache, setLoading, setBusy, appendTool, appendHook, loading,
      switchScope: () => { setScope(previous => `${previous}:switch`); appendTool() },
      pinCount: (count: number) => setCatalog(previous => previous.map((session, index) => ({ ...session, pinnedAt: index < count ? index + 1 : undefined }))),
      removeFirstTask: () => setTasks(previous => previous.slice(1)),
      hookResponse: () => setTurns(previous => previous.map(turn => ({ ...turn, items: [...turn.items,
        { id: 'hook-response', runId: turn.runId, ts: stamp, kind: 'hook', stage: 'hook_response', hookId: 'fixture-hook',
          hookEvent: 'PostToolUse', hookName: 'PostToolUse:Read', hookCommand: '/fixture/hook.sh', hookOutcome: 'success' }
      ] }))), refreshes
    } })
  })
  return <>
    <nav id="list-controls" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1000, display: 'flex', flexWrap: 'wrap', alignContent: 'start', height: 80, background: 'var(--panel)'  }}>
      {Object.entries(actions).map(([key, action]) => <button type="button" id={`list-${key}`} key={key} onClick={action} style={{ flexShrink: 0 }}>{copy[key as keyof typeof actions]}</button>)}
    </nav>
    <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr) auto', height: 'calc(100vh - 80px)' }}>
      <Sidebar id="list-sidebar" projects={projects} activeCwd="/fixture/lists" activeSessionId={null}
        q="" onQuery={noop} onPick={noop} onNew={noop} onNewProjectChat={actions.append}
        onTogglePin={noop} onArchive={noop} runningRunIds={new Set()} onRefresh={actions.refresh} />
      <div id="list-main" className="main-content" style={{ flex: 1, position: 'relative' }}>
        {scene === 'analytics' ? <AnalyticsView analytics={data} rangeDays={7} loading={!data} error={null} onRangeChange={noop} onRefresh={actions.refresh} />
          : scene === 'meta' ? <MetaPromptsView onBack={actions.chat} onInsert={setInput} />
            : scene === 'tasks' ? <div style={{ alignSelf: 'start' }}><BackgroundWorkPanel runId="background" work={{ providerId: 'pi', phase: 'waiting', quiet: false, lastEventAt: 1,
                tasks, coverage: 'partial', taskStop: 'unavailable' }} /></div>
            : <ChatView turns={turns} selectedId={null} scrollRef={scroll} textareaRef={textarea} cwd="/fixture/lists"
              recent={[]} agents={[agent]} selectedAgentId="claude" hasSelectedSession runControls={{ permissionMode: 'default' }}
              runControlCatalog={{ models: [], permissions: [{ id: 'default', label: copy.provider, description: copy.description }] }}
              input={input} composerScopeKey={scope} busy={busy} sessionLoading={loading} sessionCacheVisible={cache}
              draftAttachments={[]} queuedPrompts={queued} slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
              onSelect={noop} onInput={setInput} onChooseFolder={noop} onPickRecent={noop} onRemoveRecent={noop}
              onRetrySlash={noop} onPickSlash={noop} onSlashSel={noop} onHideSlash={noop} onSend={noop} onStop={noop}
              onPasteImages={noop} onPasteClipboardImage={noop} onRemoveDraftAttachment={noop}
              onRemoveQueuedPrompt={id => setQueued(previous => previous.filter(prompt => prompt.messageId !== id))}
              onSelectAgent={noop} onRunModel={noop} onRunEffort={noop} onPermissionMode={noop} />}
      </div>
      <div id="list-surfaces" style={{ width: 330, minWidth: 330 }}>
        <RightSurfacePanel openIds={surfaceIds} activeId={activeSurface} maximized={false}
          contents={{ overview: <p>{copy.surfaceBody}</p>, files: <p>{copy.surfaceBody}</p>, diff: <p>{copy.surfaceBody}</p> }}
          onOpen={kind => { setSurfaceIds(previous => previous.includes(kind) ? previous : [...previous, kind]); setActiveSurface(kind) }}
          onActivate={setActiveSurface} onClose={kind => setSurfaceIds(previous => previous.filter(item => item !== kind))}
          onHide={noop} onToggleMaximized={noop} />
      </div>
    </div>
    {modal === 'skills' && <SkillsModal skills={skills} onRefresh={actions.refresh} onClose={() => setModal(null)} />}
    {modal === 'mcp' && <McpModal mcps={mcps} status={{}} live={[]} refreshing={false} onTest={noop} onRefresh={actions.refresh} onClose={() => setModal(null)} />}
    <LlmPerformancePanel open={modal === 'llm'} onClose={() => setModal(null)} />
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
