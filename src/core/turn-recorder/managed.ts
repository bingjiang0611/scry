import { observedInterruptionRecordId, reserveObservedInterruption } from './managed-interruption.js'
import { isFullToolContentPolicy } from './tool-content.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentTurnRecord, type TurnEvidence, type AgentTurnRecord } from '../../shared/turn-record.js'
import { resolveRecorderEnablement } from './config.js'
import { readJson, listFiles, writeJsonAtomic } from './io.js'
import { recorderTurnRoot, recorderSessionRoot, withRecorderSessionLock, type RecorderOpenTurnState, recorderOpenPath, SESSION_LOCK_WAIT_MS, recorderPendingHealth, recorderQuarantinedOpenTurns, type RecorderSessionState, recorderStatePath } from './runtime-state.js'
import { clearRuntimeTurn, updateHealth, commitRecord, drainCommitNotifications, HOOK_DRAIN_MAX_RECORDS, HOOK_DRAIN_BUDGET_MS } from './store.js'
import { type ManagedRecorderProviderId, type ManagedTurnCancellationResult, type ManagedTurnHandoff, type EnabledRecorder, assertStrictCapture, type PrepareManagedTurnInput, type ManagedTurnResult, assertProtectedToolEvidence, assertExactText, assertOptionalAssistantText, assertTiming, assertDuplicateMatchesInput, managedProvisionalMatches, managedRecorderAllowsMissingProviderTurnId, recordDraft, assertCommittedRecordMatchesHandoff, type ManagedTurnTiming } from './managed-evidence.js'
import { recordById, recordByProviderTurnId, advanceProviderTurnIndex } from './managed-index.js'
import { reserveCanonicalJournalRecovery } from './managed-recovery.js'
export { type ManagedTurnTiming, type ManagedRecorderProviderId, isManagedRecorderProvider, managedRecorderAllowsMissingProviderTurnId, isManagedProviderRuntimePair, type PrepareManagedTurnInput, type ManagedTurnResult, type ManagedTurnCancellationResult } from './managed-evidence.js'
export { recoverManagedRecorderTurns } from './managed-recovery.js'


export function canonicalPath(root: string, generation: number): string {
  return join(recorderTurnRoot(root, generation), 'canonical.json')
}

export async function cancelManagedRecorderTurn(input: {
  workspace: string
  provider: ManagedRecorderProviderId
  sessionId: string
  runId: string
  promptHash: string
  env?: NodeJS.ProcessEnv
}): Promise<ManagedTurnCancellationResult> {
  const mode = await managedRecorderMode(input.workspace, input.env)
  if (mode.status === 'disabled') return mode
  const { enablement } = mode
  const root = recorderSessionRoot(enablement.dataRoot, input.provider, input.sessionId)
  const result = await withRecorderSessionLock(
    enablement.dataRoot, input.provider, input.sessionId,
    async (): Promise<ManagedTurnCancellationResult> => {
      const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
      if (!open) return { status: 'not_found' }
      if (
        !open.managedByScry ||
        open.provider !== input.provider ||
        open.sessionId !== input.sessionId ||
        open.managedRunId !== input.runId ||
        open.managedPromptHash !== input.promptHash
      ) {
        throw new Error('managed recorder cancellation identity differs from the open lifecycle')
      }
      if (open.providerTurnId) {
        throw new Error('managed recorder cancellation refused after Provider turn identity was observed')
      }
      if (await readJson<ManagedTurnHandoff>(canonicalPath(root, open.generation))) {
        throw new Error('managed recorder cancellation refused after canonical handoff was prepared')
      }
      await rm(recorderOpenPath(root), { force: true })
      await clearRuntimeTurn(enablement.dataRoot, recorderTurnRoot(root, open.generation))
      return { status: 'cancelled', generation: open.generation }
    },
    { waitMs: SESSION_LOCK_WAIT_MS }
  )
  await updateHealth(enablement.dataRoot, {
    ...(await recorderPendingHealth(enablement.dataRoot)),
    lastSuccessAt: new Date().toISOString(),
    lastError: undefined
  })
  return result
}

export async function managedRecorderMode(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ status: 'disabled'; reason: string } | { status: 'enabled'; enablement: EnabledRecorder }> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) {
    if (enablement.reason === 'invalid_config') {
      throw new Error(`managed recorder config is invalid${enablement.detail ? `: ${enablement.detail}` : ''}`)
    }
    return { status: 'disabled', reason: enablement.reason }
  }
  assertStrictCapture(enablement)
  return { status: 'enabled', enablement }
}

export async function handoffs(root: string): Promise<Array<{ path: string; handoff: ManagedTurnHandoff }>> {
  const out: Array<{ path: string; handoff: ManagedTurnHandoff }> = []
  for (const generation of await listFiles(join(root, 'turns'))) {
    const path = join(root, 'turns', generation, 'canonical.json')
    const handoff = await readJson<ManagedTurnHandoff>(path)
    if (handoff?.schemaVersion === 1) out.push({ path, handoff })
  }
  return out
}

async function handoffForRun(root: string, runId: string): Promise<{ path: string; handoff: ManagedTurnHandoff } | undefined> {
  return (await handoffs(root)).find((item) => item.handoff.runId === runId)
}

export async function prepareManagedRecorderTurn(input: PrepareManagedTurnInput): Promise<ManagedTurnResult> {
  const mode = await managedRecorderMode(input.workspace, input.env)
  if (mode.status === 'disabled') return mode
  assertProtectedToolEvidence(input.evidence, isFullToolContentPolicy(input.toolContentPolicy) ? input.toolContentPolicy : mode.enablement.config.capture)
  assertExactText(input.evidence.user, input.userText, 'user')
  if (
    (input.provider === 'claude' || input.provider === 'qoder' || input.provider === 'opencode' || input.provider === 'pi') &&
    input.status !== 'completed'
  ) {
    assertOptionalAssistantText(input.evidence.assistant)
  } else {
    assertExactText(input.evidence.assistant, undefined, 'assistant')
  }
  assertTiming(input.timing)
  const { enablement } = mode

  return withRecorderSessionLock(enablement.dataRoot, input.provider, input.sessionId, async () => {
    if (input.expectedRecordId) {
      const duplicate = await recordById(enablement.dataRoot, input.expectedRecordId)
      if (duplicate) {
        assertDuplicateMatchesInput(duplicate, input)
        return { status: 'duplicate' as const, recordId: duplicate.recordId, record: duplicate }
      }
    }
    if (input.allowObservedInterruption) {
      const duplicate = await recordById(enablement.dataRoot, observedInterruptionRecordId(enablement.config.workspaceId, input))
      if (duplicate) {
        assertDuplicateMatchesInput(duplicate, input)
        return { status: 'duplicate' as const, recordId: duplicate.recordId, record: duplicate }
      }
    }
    const sessionRoot = recorderSessionRoot(enablement.dataRoot, input.provider, input.sessionId)
    const providerDuplicate = input.providerTurnId
      ? await recordByProviderTurnId(
          enablement.dataRoot,
          sessionRoot,
          input.provider,
          input.sessionId,
          input.providerTurnId
        )
      : undefined
    if (providerDuplicate) {
      assertDuplicateMatchesInput(providerDuplicate, input)
      return {
        status: 'duplicate' as const,
        recordId: providerDuplicate.recordId,
        record: providerDuplicate
      }
    }
    const root = sessionRoot
    const existing = await handoffForRun(root, input.runId)
    if (existing) {
      if (existing.handoff.archiveFingerprint !== input.archiveFingerprint) {
        throw new Error('managed recorder prepared handoff differs from canonical Scry evidence')
      }
      assertDuplicateMatchesInput(
        { ...existing.handoff.record, sequence: 1 },
        input
      )
      return { status: 'prepared' as const, recordId: existing.handoff.record.recordId }
    }

    const current = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
    const candidates = [
      ...(current ? [current] : []),
      ...(await recorderQuarantinedOpenTurns(root))
    ]
    let matches = candidates.filter(
      (candidate) =>
        candidate.managedByScry &&
        candidate.providerTurnId === input.providerTurnId
    )
    const provisional = candidates.filter((candidate) => candidate.managedByScry && !candidate.providerTurnId)
    const supportsProvisionalIdentity = input.provider === 'claude' || input.provider === 'qoder' || input.provider === 'opencode' || input.provider === 'pi'
    const matchingProvisional = supportsProvisionalIdentity
      ? provisional.filter((candidate) => managedProvisionalMatches(candidate, input))
      : []
    if (
      matches.length === 0 &&
      supportsProvisionalIdentity &&
      current?.managedByScry &&
      !current.providerTurnId &&
      matchingProvisional.length === 1 &&
      matchingProvisional[0] === current
    ) {
      const bound = { ...current, providerTurnId: input.providerTurnId }
      await writeJsonAtomic(recorderOpenPath(root), bound, { sync: false })
      matches = [bound]
    }
    if (!input.providerTurnId) {
      const permitsMissingProviderTurnId = managedRecorderAllowsMissingProviderTurnId(input.provider, input.status)
      if (!permitsMissingProviderTurnId) {
        throw new Error('managed recorder requires an authoritative Provider turn id')
      }
      matches = matchingProvisional
    }
    let observedInterruption = false
    if (matches.length === 0 && candidates.length === 0) {
      const canonicalRecovery = await reserveCanonicalJournalRecovery(enablement.dataRoot, root, input)
      if (canonicalRecovery) {
        matches = [canonicalRecovery]
      } else {
        const reserved = await reserveObservedInterruption(enablement.dataRoot, root, input)
        if (reserved) {
          matches = [reserved]
          observedInterruption = true
        }
      }
    }
    if (matches.length === 0) {
      if (candidates.length === 0) {
        return { status: 'pending' as const, reason: 'managed recorder open identity is not available yet' }
      }
      throw new Error('managed recorder Provider turn id differs from the open lifecycle identity')
    }
    if (matches.length !== 1) {
      throw new Error('managed recorder Provider turn id differs from the open lifecycle identity')
    }
    const open = matches[0]

    const draft = recordDraft(enablement, open, input)
    if (observedInterruption && draft.termination) {
      draft.recordId = observedInterruptionRecordId(enablement.config.workspaceId, input)
      draft.termination = {
        ...draft.termination,
        omissionReason: 'no Provider lifecycle start was captured; this interrupted attempt uses the durable Scry run boundary, not a Provider turn identity'
      }
    }
    if (!isAgentTurnRecord({ ...draft, sequence: 1 })) throw new Error('managed recorder produced an invalid canonical record')
    const handoff: ManagedTurnHandoff = {
      schemaVersion: 1,
      phase: 'prepared',
      runId: input.runId,
      archiveFingerprint: input.archiveFingerprint,
      preparedAt: new Date().toISOString(),
      record: draft,
      uploadEnvironment: open.uploadEnvironment
    }
    await writeJsonAtomic(canonicalPath(root, open.generation), handoff)
    return { status: 'prepared' as const, recordId: draft.recordId }
  }, { waitMs: SESSION_LOCK_WAIT_MS })
}

export async function commitHandoff(
  enablement: EnabledRecorder,
  root: string,
  handoff: ManagedTurnHandoff
): Promise<Extract<ManagedTurnResult, { status: 'committed' | 'duplicate' }>> {
  if (handoff.phase !== 'archive_committed') throw new Error('managed recorder handoff archive is not committed')
  if (!isAgentTurnRecord({ ...handoff.record, sequence: 1 })) throw new Error('managed recorder handoff contains an invalid record')
  const committed = await commitRecord(enablement.dataRoot, handoff.record, handoff.uploadEnvironment)
  if (committed.status === 'duplicate') {
    assertCommittedRecordMatchesHandoff(committed.record, handoff)
  }
  await advanceProviderTurnIndex(enablement.dataRoot, root, committed.record)
  const session = await readJson<RecorderSessionState>(recorderStatePath(root)) ?? {
    schemaVersion: 1,
    lastGeneration: handoff.record.generation,
    lastTurnIndex: handoff.record.turnIndex
  }
  const committedProviderTurnIds = handoff.record.providerTurnId
    ? [...new Set([...(session.committedProviderTurnIds ?? []), handoff.record.providerTurnId])].slice(-200)
    : session.committedProviderTurnIds
  await writeJsonAtomic(recorderStatePath(root), {
    ...session,
    lastGeneration: Math.max(session.lastGeneration, handoff.record.generation),
    lastTurnIndex: Math.max(session.lastTurnIndex, handoff.record.turnIndex),
    lastCommittedRecordId: committed.record.recordId,
    ...(committedProviderTurnIds ? { committedProviderTurnIds } : {})
  }, { sync: false })
  const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
  if (open?.generation === handoff.record.generation) await rm(recorderOpenPath(root), { force: true })
  await clearRuntimeTurn(enablement.dataRoot, recorderTurnRoot(root, handoff.record.generation))
  await updateHealth(enablement.dataRoot, {
    ...(await recorderPendingHealth(enablement.dataRoot)),
    lastSuccessAt: new Date().toISOString(),
    lastError: undefined
  })
  return { status: committed.status, recordId: committed.record.recordId, record: committed.record }
}

/**
 * 提交通知的投递位置。`await` 用于 CLI/recover：进程随后就退出，必须先把这一批投递完。
 * `detach` 用于常驻 App：record 已经落盘，向仓库回调投递只是下游观测，绝不能挂在用户看到
 * 轮次收口之前——每条通知都要起一次仓库回调进程，积压时会把“运行中”拖到分钟级。剩余积压由
 * 下一次 hook、`recorder recover` 或 `recorder notify-drain` 继续投递，ACK 游标是持久化的，
 * 因此不会丢证据。
 */
export type CommitNotificationDelivery = 'await' | 'detach'

export async function deliverCommitNotifications(
  dataRoot: string,
  env: NodeJS.ProcessEnv | undefined,
  delivery: CommitNotificationDelivery
): Promise<void> {
  const drain = (): Promise<unknown> => drainCommitNotifications(dataRoot, env, {
    maxRecords: HOOK_DRAIN_MAX_RECORDS,
    budgetMs: HOOK_DRAIN_BUDGET_MS
  })
  if (delivery === 'detach') {
    void drain().catch(() => undefined)
    return
  }
  await drain()
}

export async function commitManagedRecorderTurn(input: {
  workspace: string
  provider: ManagedRecorderProviderId
  sessionId: string
  runId: string
  recordId: string
  archiveFingerprint: string
  providerTurnId?: string
  userText: string
  evidence: TurnEvidence
  timing: ManagedTurnTiming
  status: AgentTurnRecord['status']
  env?: NodeJS.ProcessEnv
  commitNotifications?: CommitNotificationDelivery
}): Promise<ManagedTurnResult> {
  const mode = await managedRecorderMode(input.workspace, input.env)
  if (mode.status === 'disabled') return mode
  const { enablement } = mode
  const result = await withRecorderSessionLock(enablement.dataRoot, input.provider, input.sessionId, async () => {
    const duplicate = await recordById(enablement.dataRoot, input.recordId)
    const root = recorderSessionRoot(enablement.dataRoot, input.provider, input.sessionId)
    const existing = await handoffForRun(root, input.runId)
    if (duplicate && !existing) {
      assertDuplicateMatchesInput(duplicate, input)
      return { status: 'duplicate' as const, recordId: duplicate.recordId, record: duplicate }
    }
    if (!existing) return { status: 'pending' as const, reason: 'managed recorder prepared handoff is missing' }
    if (
      existing.handoff.record.recordId !== input.recordId ||
      existing.handoff.archiveFingerprint !== input.archiveFingerprint
    ) throw new Error('managed recorder commit identity differs from prepared handoff')
    const committedHandoff: ManagedTurnHandoff = { ...existing.handoff, phase: 'archive_committed' }
    await writeJsonAtomic(existing.path, committedHandoff)
    return commitHandoff(enablement, root, committedHandoff)
  }, { waitMs: SESSION_LOCK_WAIT_MS })
  // canonical record 此时已落盘；通知投递是下游观测，不参与本轮是否成功的判定。
  await deliverCommitNotifications(enablement.dataRoot, input.env, input.commitNotifications ?? 'await')
  return result
}
