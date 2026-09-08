import { readJson, listFiles, writeJsonAtomic } from './io.js'
import { listRecords, stableHash } from './store.js'
import { recorderStatePath, type RecorderOpenTurnState, type RecorderSessionState } from './runtime-state.js'
import type { PrepareManagedTurnInput } from './managed.js'
import { join } from 'node:path'

export function observedInterruptionRecordId(workspaceId: string, input: PrepareManagedTurnInput): string {
  return stableHash({ workspace: workspaceId, provider: input.provider, sessionId: input.sessionId, managedRunId: input.runId }).slice(0, 32)
}

/** Reserve a host-observed interrupted attempt, not a fabricated Provider hook.
 * The caller must prove that its durable trace contains only local launch/diff events.
 * No Provider identity, transcript, tool evidence or Git baseline is reconstructed.
 */
export async function reserveObservedInterruption(
  dataRoot: string,
  root: string,
  input: PrepareManagedTurnInput
): Promise<RecorderOpenTurnState | undefined> {
  const end = input.termination
  const evidence = input.evidence
  if (
    !input.allowObservedInterruption || input.provider !== 'qoder' || input.status !== 'interrupted' ||
    input.providerTurnId || !input.runId ||
    end?.status !== 'partial' || end.quality !== 'estimated' ||
    !end.source.includes('scry_run_boundary') || end.value?.reason !== 'run_ended' ||
    end.value.completedAtSource !== 'recorder_observed_terminal' ||
    end.value.observedAt !== input.timing.completedAt ||
    evidence.assistant.value?.text || evidence.usage.value ||
    [evidence.tools, evidence.skills, evidence.mcps, evidence.hooks, evidence.modelSegments, evidence.compactions]
      .some((section) => (section?.value?.length ?? 0) > 0)
  ) return undefined

  // The session lock is held by prepare. Rebuild the high-water marks too: a lost
  // cache must never reuse a committed or crash-reserved generation.
  const state = await readJson<RecorderSessionState>(recorderStatePath(root))
  const records = (await listRecords(dataRoot)).filter((record) =>
    record.provider.id === input.provider && record.sessionId === input.sessionId)
  const reserved = (await listFiles(join(root, 'turns')))
    .filter((name) => /^\d+$/.test(name)).map(Number)
  const generation = Math.max(state?.lastGeneration ?? 0, ...records.map((record) => record.generation), ...reserved) + 1
  const turnIndex = Math.max(state?.lastTurnIndex ?? 0, ...records.map((record) => record.turnIndex)) + 1
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(turnIndex)) {
    throw new Error('managed recorder interruption sequence is invalid')
  }
  await writeJsonAtomic(recorderStatePath(root), {
    ...state, schemaVersion: 1, lastGeneration: generation, lastTurnIndex: turnIndex
  })
  return {
    schemaVersion: 1,
    provider: input.provider,
    sessionId: input.sessionId,
    generation,
    turnIndex,
    status: 'closing',
    startedAt: input.timing.startedAt,
    terminalAt: input.timing.completedAt,
    terminalAtSource: 'recorder_observed_terminal',
    terminalFallbackStatus: 'interrupted',
    managedByScry: true,
    managedRunId: input.runId,
    startFingerprint: stableHash({ source: 'scry_run_boundary', runId: input.runId, timing: input.timing }),
    captures: []
  }
}
