import { homedir } from 'node:os'
import { capabilityReady, type ProviderContext } from '../../shared/provider'
import { listProviderMcp } from '../mcp-config'
import { describeAntigravity } from './antigravity-launch'
import { ANTIGRAVITY_PERMISSION_OPTIONS } from './antigravity-permissions'
import { runAntigravity, type AntigravityRunDeps } from './antigravity-run'
import type { ProviderAdapter, ProviderRunRequest } from './types'

export function createAntigravityAdapter(
  homeDir = homedir(),
  deps: Omit<AntigravityRunDeps, 'homeDir'> = {}
): ProviderAdapter {
  return {
    id: 'antigravity',
    runtimeProvider: 'antigravity_acp',
    describe: () => describeAntigravity(),
    run: (request: ProviderRunRequest) => runAntigravity(request, { ...deps, homeDir }),
    runControls: {
      read: async (context: ProviderContext) => capabilityReady(context, 'read', {
        models: [],
        permissions: [...ANTIGRAVITY_PERMISSION_OPTIONS]
      })
    },
    mcp: {
      snapshot: async (context: ProviderContext) => capabilityReady(context, 'read', {
        configured: listProviderMcp('antigravity', context.cwd, homeDir),
        runtime: null
      })
    }
  }
}
