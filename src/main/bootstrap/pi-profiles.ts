import { createCachedAsyncLoader } from '../provider-detection'
import { detectAgents, detectAgentsFast } from '../claude-locate'
import { canonicalizePiAgentPaths, createPiAgentProfileStore, piProfileForExecutable, undetectedPiProfiles, type PiAgentProfile } from '../pi-agent-profiles'
import { providerIdForAgentId } from '../../shared/runtime'
import { piRpcEnvironment } from '../providers/pi'

export function createPiProfileRuntime(deps: { userDataDir: string }) {
  const piProfileStore = () => createPiAgentProfileStore(deps.userDataDir)
  const fullAgentDetection = createCachedAsyncLoader(async () => canonicalizePiAgentPaths(await detectAgents({
    versionProbeEnv: (agent, executable) => providerIdForAgentId(agent.id) === 'pi'
      ? piRpcEnvironment({ id: agent.id, label: agent.name, executable })
      : undefined
  })), { ttlMs: 60_000 })
  const detectInstalledAgents = () => fullAgentDetection.load()
  // Provider descriptors and runtime profile resolution only need executable identity. Do not turn
  // their frequent availability reads into version subprocesses for every installed Provider.
  const detectedPiProfiles = async (): Promise<PiAgentProfile[]> => detectAgentsFast().flatMap((agent) => {
    if (providerIdForAgentId(agent.id) !== 'pi') return []
    try {
      const profile = piProfileForExecutable(agent.path)
      return [{ ...profile, id: agent.id, label: agent.name }]
    } catch {
      return []
    }
  })
  const storedPiProfiles = (): PiAgentProfile[] => {
    try {
      return piProfileStore().load().flatMap((stored) => {
        try {
          const current = piProfileForExecutable(stored.executable)
          return [{ ...current, id: stored.id, label: stored.label }]
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }
  const storedPiProfilesNotDetected = (detected: Array<{ id: string }>): PiAgentProfile[] =>
    undetectedPiProfiles(storedPiProfiles(), detected)
  const listPiProfiles = async (): Promise<PiAgentProfile[]> => {
    const detected = await detectedPiProfiles()
    return [...detected, ...storedPiProfilesNotDetected(detected.map((profile) => ({ id: profile.id, path: profile.executable })))]
  }
  const resolvePiProfile = async (id: string): Promise<PiAgentProfile | undefined> => {
    if (id === 'pi:default' || id === 'pi:rotom') return (await detectedPiProfiles()).find((profile) => profile.id === id)
    return storedPiProfiles().find((profile) => profile.id === id)
  }

  return { piProfileStore, detectInstalledAgents, detectedPiProfiles, storedPiProfiles, storedPiProfilesNotDetected, listPiProfiles, resolvePiProfile }
}
