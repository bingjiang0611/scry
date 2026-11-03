import type { RemoteInteractionError as DeviceError } from './remote-interaction-broker'
import { MAC_RUN_ID, REMOTE_RUN_ID } from './host-controller-routing'
import type { MacRunSource, MacRunView } from './host-controller-types'
import type { SessionLedger } from './session-ledger'
import type { WorkspaceAuthorizer } from './remote-run-policy'

// Run identity helpers shared by the device-facing operations: which ids are
// ledger-backed remote runs, which are Mac UI runs, and whether a cwd is still
// authorized. Absence is "not observed", never "finished".

export function authorizedCwd(workspace: WorkspaceAuthorizer, cwd: string): string | undefined {
  try { return workspace.authorize(cwd) } catch { return undefined }
}

export function isRemoteRun(ledger: SessionLedger, runId: string): boolean {
  return REMOTE_RUN_ID.test(runId) && ledger.runState(runId) !== undefined
}

export function macRun(deps: { macRuns?: MacRunSource; workspace: WorkspaceAuthorizer }, runId: string, fail: (code: string) => DeviceError): MacRunView {
  const run = MAC_RUN_ID.test(runId) ? deps.macRuns?.list().find((item) => item.runId === runId) : undefined
  if (!run || !authorizedCwd(deps.workspace, run.cwd)) throw fail('unknown_run')
  return run
}
