import type { AppShellProps } from './app-shell-types'
import { lazy, Suspense, type ComponentProps } from 'react'
import type { RemoteTarget } from './app-types'
import type { useDesktopConnections } from './hooks/useDesktopConnections'
import { Sidebar } from './components/Sidebar'
import { ConversationView } from './components/ConversationView'
import { PaneSplitter } from './components/PaneSplitter'
import { SessionChatView } from './components/ChatView'
import { MetaPromptsView } from './components/MetaPromptsView'
import { ViewChrome } from './components/ViewChrome'
import { LlmPerformancePanel } from './components/LlmPerformancePanel'
import { OverviewPanel } from './components/OverviewPanel'
import { CapabilitiesModal, SettingsModal } from './components/Modals'
import { RemoteChat, remoteDraftKey } from './components/RemoteChat'
import { hostState } from './components/LocationPicker'
import { DiffInspector } from './components/DiffInspector'
import { WorkspacePanel } from './components/WorkspacePanel'
import { RightSurfacePanel } from './components/RightSurfacePanel'
import { SourceControlPanel } from './components/SourceControlPanel'
import { AgentsSurface } from './components/AgentsSurface'
import { PinnedSummaryHost } from './components/PinnedSummary'
import { EmptySessionOverview } from './app-model'
import packageJson from '../../package.json'

const AnalyticsView = lazy(() => import('./components/AnalyticsView').then((module) => ({ default: module.AnalyticsView })))
const TerminalSurface = lazy(() => import('./components/TerminalSurface').then((module) => ({ default: module.TerminalSurface })))

export function AppShell(props: AppShellProps) {
  const {
    appStyle, view, sidebarPane, surfacePane, shellPanelMounted, shellPanelVisible, shellPanelMaximized,
    summaryVisible, summaryPersistent, draftStore, chatProps, sidebarActions, projects, cwd, activeSessionId,
    logicalConversation, conversationError, conversationAgent, loadProjects,
    setConversationProjection, pickConversation, desktopConnections, remoteTarget, remoteQueueStore,
    setRemoteDraft, scrollRef, taRef, renderLocationPicker, remoteSurfaceKey, remoteSurfaces,
    remoteSurfaceTarget, setRemoteSurfaceTarget, remoteSurface, remotePanelVisible, remoteAdoptedSession,
    setRemoteAdoptedSession, setRemoteTarget, dispatchRemoteSurface, returnFromMetaPrompts, insertMetaPrompt,
    metaPromptTarget, integrations, session, displayedTurns, displayedBusy, selectedProviderSessionId,
    panelRuntimeProvider, showSessionOverview, panelVisible, currentSurface, rightSurface, rightSurfaces,
    handleRightSurfaceAction, openTurnInChat, openSessionNetDiff, diffInspector, openWorkspaceDiff, workspaceRefreshKey,
    workspaceOpenRequests, setScopeDirty, addWorkspaceReference, showLlmPerformance, setShowLlmPerformance,
    showSkills, showMcp, openSkills, openMcp, settingsTab, setSettingsTab, theme, changeTheme, archiveUndo,
    setArchiveUndo, workspace, runningRunIds, waitingQuestionRunIds, unreadSessionKeys, backgroundWorkByRun,
    catalogHealth, summary, sidebarMin, sidebarMax, panelMin, panelMax, rightPanelMounted, mountedSurfaces,
    setRemoteWorkspaceDirty, toggleOverviewPanel, changeView, openRemoteLocation, setShowSkills, setShowMcp
  } = props
  return (
    <div className={`app app-shell${shellPanelMounted ? ` has-right-panel right-panel-surface${shellPanelMaximized ? ' right-panel-maximized' : ''}${!shellPanelVisible ? ' right-panel-hidden' : ''}` : ''}${summaryVisible ? ' pinned-summary-visible' : ''}${summaryVisible && summaryPersistent ? ' pinned-summary-persistent' : ''}${sidebarPane.collapsed ? ' sidebar-collapsed' : ''}`} style={appStyle}>
      <Sidebar {...(sidebarActions as ComponentProps<typeof Sidebar>)} id="sidebar-pane" draftStore={draftStore} version={packageJson.version} projects={projects}
        activeCwd={view === 'conversation' ? logicalConversation?.cwd ?? null : view === 'remote' ? null : cwd}
        activeSessionId={view === 'remote' || view === 'conversation' ? null : activeSessionId}
        activeConversationId={view === 'conversation' ? logicalConversation?.id : undefined}
        activeRemote={view === 'remote' && remoteTarget ? { connectionId: remoteTarget.connectionId, cwd: remoteTarget.cwd, externalSessionId: remoteAdoptedSession } : null}
        activeProviderId={integrations.selectedProviderId} activeAgentProfileId={integrations.providerContext.agentProfileId}
        runningRunIds={runningRunIds} waitingQuestionRunIds={waitingQuestionRunIds} unreadSessionKeys={unreadSessionKeys}
        backgroundWorkByRun={backgroundWorkByRun} archiveUndo={archiveUndo}
        analyticsActive={view === 'analytics'} metaPromptsActive={view === 'meta-prompts'} catalogHealth={catalogHealth} />
      <PaneSplitter className="sidebar-resizer" label="调整左侧栏宽度" controls="sidebar-pane" min={sidebarMin} max={sidebarMax}
        value={sidebarPane.width} collapsed={sidebarPane.collapsed} active={sidebarPane.resizing} onPointerDown={sidebarPane.startResize} onKeyDown={sidebarPane.onKeyDown} />
      <div className="main-area" id="main-pane" aria-hidden={shellPanelMaximized || undefined} {...(shellPanelMaximized ? { inert: '' } : {})}>
        <>
          {view !== 'chat' && view !== 'conversation' && view !== 'remote' && <div className="aux-view-topbar" aria-hidden="true" />}
          {view === 'conversation' ? <>
            {conversationError && <p role="alert">{conversationError}</p>}
            {logicalConversation ? <>
              <ViewChrome cwd={logicalConversation.cwd} showSummary={summaryVisible} showPanel={panelVisible} onToggleSummary={summary.toggle} onTogglePanel={toggleOverviewPanel} />
              <ConversationView key={logicalConversation.id} conversation={logicalConversation} draftStore={draftStore} chatProps={chatProps} initialAgentId={conversationAgent} onChanged={() => { void loadProjects() }} onProjection={setConversationProjection} onOpenConversation={pickConversation} />
            </> : !conversationError && <p role="status">正在打开对话…</p>}
          </> : (view === 'remote' || (view === 'meta-prompts' && metaPromptTarget.current.view === 'remote')) && remoteTarget ? <>
            <div style={{ display: view === 'remote' ? 'contents' : 'none' }}>
              <RemoteView target={remoteTarget} connections={desktopConnections} draftStore={draftStore} queueStore={remoteQueueStore}
                onDraftInput={setRemoteDraft} scrollRef={scrollRef} textareaRef={taRef}
                renderLocationPicker={renderLocationPicker({ machineId: remoteTarget.connectionId, cwd: remoteTarget.cwd })}
                onSessionAdopted={(externalSessionId, provider) => {
                  remoteSurfaces.migrate(remoteSurfaceKey, remoteDraftKey(remoteTarget.connectionId, remoteTarget.cwd, externalSessionId))
                  setRemoteAdoptedSession(externalSessionId)
                  if (metaPromptTarget.current.view === 'remote' && metaPromptTarget.current.draftKey === remoteSurfaceKey) metaPromptTarget.current.draftKey = remoteDraftKey(remoteTarget.connectionId, remoteTarget.cwd, externalSessionId)
                  setRemoteTarget(current => current ? { ...current, session: { sessionId: externalSessionId, externalSessionId, cwd: current.cwd, providerId: provider.id, agentProfileId: provider.agentProfileId, label: current.session?.label ?? '', ts: current.session?.ts ?? Date.now() } } : current)
                }} showPanel={remotePanelVisible} onTogglePanel={() => dispatchRemoteSurface(remotePanelVisible ? { type: 'hide' } : { type: 'show' })}
                surface={{ target: remoteSurfaceTarget, state: remoteSurface, scopeId: remoteSurfaces.current.id, retainTerminal: remoteSurfaces.current.terminalMounted, onDirtyChange: setRemoteWorkspaceDirty, onAction: dispatchRemoteSurface }} />
            </div>
            {view === 'meta-prompts' && <MetaPromptsView onBack={returnFromMetaPrompts} onInsert={insertMetaPrompt} />}
          </> : view === 'analytics' ? <Suspense fallback={<div className="lazy-panel-loading">正在加载分析视图…</div>}>
            <AnalyticsView analytics={integrations.analytics} rangeDays={integrations.analyticsRange} loading={integrations.analyticsLoading} error={integrations.analyticsError} onRangeChange={integrations.setAnalyticsRange} onRefresh={() => integrations.loadAnalytics()} onBack={() => { changeView('chat') }} />
          </Suspense> : view === 'meta-prompts' ? <MetaPromptsView onBack={returnFromMetaPrompts} onInsert={insertMetaPrompt} /> : <>
            <ViewChrome cwd={cwd} showSummary={summaryVisible} showPanel={panelVisible} onToggleSummary={summary.toggle} onTogglePanel={toggleOverviewPanel} />
            <SessionChatView {...chatProps} />
          </>}
          <PinnedSummaryHost
            visible={(view === 'chat' || view === 'conversation') && summaryVisible}
            cwd={diffInspector.cwd}
            gitDiff={diffInspector.summary}
            gitDiffRefreshing={diffInspector.summaryRefreshing}
            turns={displayedTurns}
            busy={displayedBusy}
            temporary={!summaryPersistent}
            onDismiss={summary.dismiss}
            onOpenChanges={() => { summary.dismiss(); openWorkspaceDiff() }}
            onOpenSessionDiff={() => { summary.dismiss(); openSessionNetDiff() }}
            onOpenCall={(runId, event) => { summary.dismiss(); openTurnInChat(runId, event, 'event') }}
            onOpenAgents={() => { summary.dismiss(); surfacePane.restore(); rightSurfaces.dispatch({ type: 'open', kind: 'agents' }) }}
          />
        </>
      </div>
      {view === 'remote' && <><>{remotePanelVisible && !remoteSurface.maximized && <PaneSplitter className="panel-resizer" label="调整右侧面板宽度" controls="remote-right-surface-pane" min={panelMin} max={panelMax} value={surfacePane.width} collapsed={surfacePane.collapsed} active={surfacePane.resizing} onPointerDown={surfacePane.startResize} onKeyDown={surfacePane.onKeyDown} />}</><div className="right-panel-slot" id="remote-right-surface-pane" ref={setRemoteSurfaceTarget} /></>}
      {rightPanelMounted && (
        <>
          {panelVisible && !rightSurface.maximized && <PaneSplitter className="panel-resizer" label="调整右侧面板宽度" controls="right-surface-pane" min={panelMin} max={panelMax} value={surfacePane.width} collapsed={surfacePane.collapsed} active={surfacePane.resizing} onPointerDown={surfacePane.startResize} onKeyDown={surfacePane.onKeyDown} />}
          <div className="right-panel-slot" id="right-surface-pane" style={view === 'remote' ? { display: 'none' } : undefined}>
            {mountedSurfaces.map((surface) => (
              <div key={surface.id} data-session-surface-current={surface.id === currentSurface.id} style={{ display: surface.id === currentSurface.id ? 'contents' : 'none' }}>
                <RightSurfacePanel openIds={surface.state.openIds} activeId={surface.state.activeId} retainTerminal={surface.terminalMounted}
                  workbenchPicker={surface.id === currentSurface.id && rightSurfaces.choices.length > 1 ? <button type="button" className="surface-tab-activate" aria-label="切换此会话的保留工作区" title="会话身份合并后保留了多个工作区；点击切换，不会关闭终端" onClick={rightSurfaces.selectNext}>工作区 {rightSurfaces.selectedIndex + 1}/{rightSurfaces.choices.length}</button> : null}
                  maximized={surface.state.maximized} onOpen={(kind) => { surfacePane.restore(); handleRightSurfaceAction({ type: 'open', kind }) }} onActivate={(kind) => handleRightSurfaceAction({ type: 'activate', kind })} onClose={(kind) => handleRightSurfaceAction({ type: 'close', kind })} onHide={() => handleRightSurfaceAction({ type: 'hide' })} onToggleMaximized={() => handleRightSurfaceAction({ type: 'toggle-maximized' })}
                  contents={{
                    overview: surface.id !== currentSurface.id ? null : showSessionOverview ? <OverviewPanel turns={displayedTurns} sessionId={selectedProviderSessionId} selected={session.selected} usage={integrations.usage} stats={integrations.stats} runtimeProvider={panelRuntimeProvider} gitDiff={integrations.gitDiff} gitDiffRefreshing={integrations.gitDiffRefreshing} busy={displayedBusy} onSelect={session.setSelected} onOpenTurn={openTurnInChat} onOpenSessionDiff={openSessionNetDiff} /> : <EmptySessionOverview />,
                    'source-control': surface.cwd ? <SourceControlPanel key={surface.cwd} cwd={surface.cwd} active={surface.id === currentSurface.id && panelVisible && surface.state.activeId === 'source-control'} /> : <div className="surface-unavailable"><b>源代码管理不可用</b><span>先绑定本机 Git 工作区。</span></div>,
                    files: surface.cwd ? <WorkspacePanel cwd={surface.cwd} active={surface.id === currentSurface.id} refreshKey={workspaceRefreshKey} openRequest={workspaceOpenRequests.get(surface.id)} onDirtyChange={(dirty) => setScopeDirty(surface.id, dirty)} onAddReference={addWorkspaceReference} onClose={() => handleRightSurfaceAction({ type: 'close', kind: 'files' })} /> : <div className="surface-unavailable"><b>文件不可用</b><span>先绑定一个工作区。</span></div>,
                    diff: surface.id !== currentSurface.id ? null : <DiffInspector state={diffInspector} onClose={() => handleRightSurfaceAction({ type: 'close', kind: 'diff' })}
                      history={view === 'chat' && chatProps.onLoadOlderTurns ? { hasOlder: chatProps.historyWindow?.hasOlder ?? false,
                        loading: chatProps.historyOlderLoading ?? false, load: chatProps.onLoadOlderTurns } : undefined} />,
                    terminal: <Suspense fallback={<div className="surface-unavailable"><span>正在加载终端…</span></div>}><TerminalSurface cwd={surface.cwd} scopeId={surface.id} active={surface.id === currentSurface.id && panelVisible && surface.state.activeId === 'terminal'} /></Suspense>,
                    agents: surface.id === currentSurface.id ? <AgentsSurface turns={displayedTurns} busy={displayedBusy} /> : null
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
      <>{showLlmPerformance && <LlmPerformancePanel open onClose={() => setShowLlmPerformance(false)} />}{(showSkills || showMcp) && <CapabilitiesModal
        key={`${integrations.selectedProviderId}:${cwd ?? ''}`}
        view={showMcp ? 'mcp' : 'skills'}
        onViewChange={(nextView) => { if (nextView === 'skills') openSkills(); else openMcp() }}
        skills={integrations.skills}
        skillCapability={integrations.skillCapability}
        skillsRefreshing={integrations.skillsRefreshing}
        mcps={integrations.mcps}
        status={integrations.mcpStatus}
        live={integrations.mcpLive}
        mcpConfigRefreshing={integrations.mcpConfigRefreshing}
        mcpRefreshing={integrations.mcpRefreshing}
        mcpCapability={integrations.mcpCapability}
        onTestMcp={integrations.testMcp}
        onReauthenticateMcp={integrations.reauthenticateMcp}
        onRefreshMcp={integrations.pullMcpLive}
        onClose={() => { setShowSkills(false); setShowMcp(false); setShowLlmPerformance(false) }}
      />}{settingsTab !== null && <SettingsModal initialTab={settingsTab} theme={theme} onThemeChange={changeTheme} onSessionsChanged={() => { setArchiveUndo(null); workspace.loadProjects() }} onNewRemoteSession={(connectionId, remoteCwd) => openRemoteLocation(connectionId, remoteCwd)} onClose={() => setSettingsTab(null)} />}</>
    </div>
  )
}

function RemoteView({ target, connections, showPanel, onTogglePanel, ...chat }: { target: RemoteTarget; connections: ReturnType<typeof useDesktopConnections>; showPanel: boolean; onTogglePanel: () => void } & Omit<ComponentProps<typeof RemoteChat>, 'connectionId' | 'cwd' | 'session'>) {
  const connection = connections.connections.find((item) => item.id === target.connectionId)
  return <><ViewChrome cwd={target.cwd} showSummary={false} showPanel={showPanel} onTogglePanel={onTogglePanel} machine={{ label: connection?.label ?? '远程主机不可用', remote: true, state: connection ? hostState(connection, connections.error, connections.refreshing) : 'unknown' }} /><RemoteChat key={target.generation} connectionId={target.connectionId} cwd={target.cwd} session={target.session} {...chat} /></>
}
