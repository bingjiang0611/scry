import type { AppShellProps } from '../app-shell-types'
import { LlmPerformancePanel } from './LlmPerformancePanel'
import { CapabilitiesModal, SettingsModal } from './Modals'

type AppShellModalsProps = Pick<
  AppShellProps,
  | 'cwd' | 'integrations' | 'showLlmPerformance' | 'setShowLlmPerformance'
  | 'showSkills' | 'showMcp' | 'openSkills' | 'openMcp' | 'setShowSkills' | 'setShowMcp'
  | 'settingsTab' | 'setSettingsTab' | 'theme' | 'changeTheme'
  | 'setArchiveUndo' | 'workspace' | 'openRemoteLocation'
>

export function AppShellModals(props: AppShellModalsProps): JSX.Element {
  const {
    cwd, integrations, showLlmPerformance, setShowLlmPerformance,
    showSkills, showMcp, openSkills, openMcp, setShowSkills, setShowMcp,
    settingsTab, setSettingsTab, theme, changeTheme, setArchiveUndo, workspace, openRemoteLocation
  } = props
  return (
    <>
      {showLlmPerformance && <LlmPerformancePanel open onClose={() => setShowLlmPerformance(false)} />}
      {(showSkills || showMcp) && (
        <CapabilitiesModal
          key={`${integrations.selectedProviderId}:${cwd ?? ''}`}
          view={showMcp ? 'mcp' : 'skills'}
          onViewChange={(nextView) => { if (nextView === 'skills') openSkills(); else openMcp() }}
          skills={integrations.skills}
          skillCapability={integrations.skillCapability}
          skillsRefreshing={integrations.skillsRefreshing}
          onRefreshSkills={integrations.refreshSkills}
          mcps={integrations.mcps}
          status={integrations.mcpStatus}
          live={integrations.mcpLive}
          mcpConfigRefreshing={integrations.mcpConfigRefreshing}
          mcpRefreshing={integrations.mcpRefreshing}
          onCancelMcp={integrations.cancelMcpLive}
          mcpProviderId={integrations.selectedProviderId}
          mcpCapability={integrations.mcpCapability}
          onTestMcp={integrations.testMcp}
          onReauthenticateMcp={integrations.reauthenticateMcp}
          onRefreshMcp={integrations.pullMcpLive}
          onClose={() => { setShowSkills(false); setShowMcp(false); setShowLlmPerformance(false) }}
        />
      )}
      {settingsTab !== null && (
        <SettingsModal
          initialTab={settingsTab}
          theme={theme}
          onThemeChange={changeTheme}
          onSessionsChanged={() => { setArchiveUndo(null); workspace.loadProjects() }}
          onNewRemoteSession={(connectionId, remoteCwd) => openRemoteLocation(connectionId, remoteCwd)}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </>
  )
}
