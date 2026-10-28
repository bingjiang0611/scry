import { registerAppIpc } from './app-ipc'
import { registerProviderDiscoveryIpc } from './provider-discovery-ipc'
import { registerAgentContextIpc } from './agent-context-ipc'
import { registerSourceControlIpc } from './source-control/ipc'
import { registerWorkspaceIpc } from './workspace-ipc'
import { registerTerminalIpc } from './terminal-ipc'

export interface MainInitialIpcDeps {
  app: Parameters<typeof registerAppIpc>[0]
  providerDiscovery: Parameters<typeof registerProviderDiscoveryIpc>[0]
  agentContext: Parameters<typeof registerAgentContextIpc>[0]
  sourceControl: Parameters<typeof registerSourceControlIpc>[0]
  sourceControlService: Parameters<typeof registerSourceControlIpc>[1]
  workspace: Parameters<typeof registerWorkspaceIpc>[0]
  terminal: Parameters<typeof registerTerminalIpc>[0]
}

export function registerMainInitialIpc(deps: MainInitialIpcDeps): void {
  registerAppIpc(deps.app)
  registerProviderDiscoveryIpc(deps.providerDiscovery)
  registerAgentContextIpc(deps.agentContext)
  registerSourceControlIpc(deps.sourceControl, deps.sourceControlService)
  registerWorkspaceIpc(deps.workspace)
  registerTerminalIpc(deps.terminal)
}
