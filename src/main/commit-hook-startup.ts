import { resolveRecorderEnablement } from '../core/turn-recorder/config.js'
import { redeliverLatestCommitNotification } from '../core/turn-recorder/store.js'
import {
  createCommitHookTrustStore,
  resolveGrantedCommitHookCapability,
  type CommitHookCapability
} from './commit-hook-trust.js'

export interface CommitHookStartupRedelivery {
  redelivered: number
  skipped: number
  errors: string[]
}

export async function redeliverGrantedCommitHooksAtStartup(
  userDataDir: string,
  options: {
    env?: NodeJS.ProcessEnv
    extendCapabilityEnv?: (capability: CommitHookCapability) => NodeJS.ProcessEnv
  } = {}
): Promise<CommitHookStartupRedelivery> {
  const result: CommitHookStartupRedelivery = { redelivered: 0, skipped: 0, errors: [] }
  const env = options.env ?? process.env
  const workspaces = await createCommitHookTrustStore(userDataDir).grantedWorkspaces()

  for (const workspace of workspaces) {
    try {
      const enablement = await resolveRecorderEnablement(workspace, env)
      if (!enablement.enabled || !enablement.config.commitHook) {
        result.skipped++
        continue
      }
      const capability = await resolveGrantedCommitHookCapability(
        workspace,
        enablement.config.commitHook,
        userDataDir
      )
      if (!capability) {
        result.skipped++
        continue
      }
      const redelivery = await redeliverLatestCommitNotification(enablement.dataRoot, {
        ...env,
        ...capability.env,
        ...options.extendCapabilityEnv?.(capability)
      })
      if (redelivery.delivered) result.redelivered++
      else {
        result.skipped++
        if (redelivery.reason && redelivery.reason !== 'no committed record') {
          result.errors.push(`${workspace}: ${redelivery.reason}`)
        }
      }
    } catch (error) {
      result.skipped++
      result.errors.push(`${workspace}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
