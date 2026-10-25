import type { WorkspaceSelectionApi } from '../../src/shared/workspace-selection'

// Offline App fixtures have no Git or project authority. Supply the current bridge contract
// without fabricating an empty repository or permitting first-send workspace mutations.
const unavailable = { status: 'unavailable', reason: '此离线夹具没有 Git 工作区证据' } as const
export const unavailableWorkspaceSelection: WorkspaceSelectionApi = {
  read: async () => unavailable,
  validateBranch: async () => unavailable,
  inspectStart: async () => unavailable
}
