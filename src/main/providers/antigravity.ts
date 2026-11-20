import { homedir } from 'node:os'
import { capabilityReady, type ProviderContext } from '../../shared/provider'
import { shellEnv } from '../claude-locate'
import { listProviderMcp } from '../mcp-config'
import { createAntigravityCatalog } from './antigravity-catalog'
import {
  createAntigravityConfigTrustStore,
  inspectAntigravityWorkspaceConfig
} from './antigravity-config-trust'
import { prepareAntigravityHistoryMcp } from './antigravity-history-mcp'
import { antigravityExecutable, describeAntigravity } from './antigravity-launch'
import { runAntigravity, type AntigravityRunDeps } from './antigravity-run'
import { antigravityContinuationKey } from './host-continuation-identity'
import type { ProviderAdapter, ProviderRunRequest } from './types'

export interface AntigravityAdapterOptions extends Omit<AntigravityRunDeps, 'homeDir'> {
  userDataDir?: string
}

export function createAntigravityAdapter(
  homeDir = homedir(),
  options: AntigravityAdapterOptions = {}
): ProviderAdapter {
  const { userDataDir, ...runDeps } = options
  const continuationKey = (context: ProviderContext) =>
    antigravityContinuationKey(context, homeDir, antigravityExecutable())
  const catalog = createAntigravityCatalog({
    homeDir,
    continuationKey,
    clientVersion: runDeps.clientVersion
  })
  const trustStore = userDataDir ? createAntigravityConfigTrustStore(userDataDir) : undefined
  const checkWorkspaceTrust = runDeps.checkWorkspaceTrust ?? ((cwd: string) => {
    if (trustStore) trustStore.verifyAndAuthorize(cwd)
    else inspectAntigravityWorkspaceConfig(cwd)
  })
  const prepareMcp = runDeps.prepareMcp ?? prepareAntigravityHistoryMcp

  return {
    id: 'antigravity',
    runtimeProvider: 'antigravity_acp',
    historyReader: true,
    continuationKey,
    describe: () => describeAntigravity(),
    run: (request: ProviderRunRequest) => runAntigravity(request, {
      ...runDeps,
      homeDir,
      acquireRunSlot: (signal) => catalog.enterRun(signal),
      checkWorkspaceTrust,
      prepareMcp
    }),
    runControls: { read: (context) => catalog.runControls(context) },
    commands: { list: (context) => catalog.commands(context) },
    skills: { list: (context) => catalog.skills(context) },
    mcp: {
      snapshot: async (context: ProviderContext) => capabilityReady(context, 'read', {
        // B1: pass merged shell+process env; antigravityMcpConfigPaths honors GEMINI_HOME only when allowlisted.
        configured: listProviderMcp('antigravity', context.cwd, homeDir, { ...shellEnv(), ...process.env }),
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
