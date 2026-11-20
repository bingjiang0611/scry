import { homedir } from 'node:os'
import { capabilityReady, type ProviderContext } from '../../shared/provider'
import { listProviderMcp } from '../mcp-config'
import { createAntigravityCatalog } from './antigravity-catalog'
import { antigravityExecutable, describeAntigravity } from './antigravity-launch'
import { runAntigravity, type AntigravityRunDeps } from './antigravity-run'
import { antigravityContinuationKey } from './host-continuation-identity'
import type { ProviderAdapter, ProviderRunRequest } from './types'

export function createAntigravityAdapter(
  homeDir = homedir(),
  deps: Omit<AntigravityRunDeps, 'homeDir'> = {}
): ProviderAdapter {
  const continuationKey = (context: ProviderContext) =>
    antigravityContinuationKey(context, homeDir, antigravityExecutable())
  const catalog = createAntigravityCatalog({
    homeDir,
    continuationKey,
    clientVersion: deps.clientVersion
  })

  return {
    id: 'antigravity',
    runtimeProvider: 'antigravity_acp',
    continuationKey,
    describe: () => describeAntigravity(),
    run: (request: ProviderRunRequest) => runAntigravity(request, {
      ...deps,
      homeDir,
      acquireRunSlot: () => catalog.enterRun()
    }),
    runControls: { read: (context) => catalog.runControls(context) },
    commands: { list: (context) => catalog.commands(context) },
    skills: { list: (context) => catalog.skills(context) },
    mcp: {
      snapshot: async (context: ProviderContext) => capabilityReady(context, 'read', {
        configured: listProviderMcp('antigravity', context.cwd, homeDir),
        runtime: null
      })
    },
    invalidateContext: () => {
      catalog.invalidate()
    },
    dispose: () => {
      catalog.invalidate()
    }
  }
}
