import type { AppShellProps } from '../app-shell-types'
import { CapabilitiesModal, SettingsModal } from './Modals'

type AppShellModalsProps = Pick<
  AppShellProps,
  | 'cwd' | 'integrations'
  | 'showSkills' | 'showMcp' | 'openSkills' | 'openMcp' | 'setShowSkills' | 'setShowMcp'
  | 'settingsTab' | 'setSettingsTab' | 'theme' | 'changeTheme'
  | 'setArchiveUndo' | 'workspace' | 'openMachines'
>

export function AppShellModals(props: AppShellModalsProps): JSX.Element {
  const {
    cwd, integrations,
    showSkills, showMcp, openSkills, openMcp, setShowSkills, setShowMcp,
    settingsTab, setSettingsTab, theme, changeTheme, setArchiveUndo, workspace, openMachines
  } = props
  return (
    <>
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
          onClose={() => { setShowSkills(false); setShowMcp(false) }}
        />
      )}
      {settingsTab !== null && (
        <SettingsModal
          initialTab={settingsTab}
          theme={theme}
          onThemeChange={changeTheme}
          onSessionsChanged={() => { setArchiveUndo(null); workspace.loadProjects() }}
          onOpenMachines={openMachines}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </>
  )
}
