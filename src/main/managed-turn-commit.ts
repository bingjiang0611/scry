import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  commitManagedRecorderTurn,
  managedRecorderMode,
  prepareManagedRecorderTurn,
  type ManagedRecorderProviderId
} from '../core/turn-recorder/managed.js'
import { listFiles, readJson, withDirectoryLock, writeJsonAtomic } from '../core/turn-recorder/io.js'
import { upsertTraceArchiveTurnAsync } from './transcript-archive.js'
import {
  artifactExists,
  journalPath,
  journalRoot,
  journalStatePath,
  journalStateRoot,
  lockPath,
  managedArtifactIdentity,
  managedIdentityMatches,
  progressPath,
  progressRoot,
  readManagedJournal,
  readManagedJournalAt,
  validJournal,
  validProgress,
  writeJournalState,
  type ManagedTraceTurnCommitInput,
  type ManagedTurnJournal,
  type ManagedTurnProgress,
  type ManagedTurnRecovery
} from './managed-turn-journal.js'
import {
  archiveFingerprint,
  archiveJournal,
  assertManagedTraceInput,
  assertProgressIdentity,
  existingTurnDisposition,
  managedObservedInterruptionAllowed,
  managedTermination,
  matchingArchiveTurn,
  protectManagedInput
} from './managed-turn-archive.js'

export {
  cleanupManagedTurnTemps,
  deleteManagedTurnArtifacts,
  managedRecoveryScopes,
  managedSessionRunIds,
  type ManagedTraceTurnCommitInput,
  type ManagedTurnRecovery
} from './managed-turn-journal.js'
export { canonicalOrObservedTurnTiming, canonicalTurnTiming } from './managed-turn-archive.js'
async function prepareJournalRecord(
  journal: ManagedTurnJournal,
  waitMs: number,
  allowCanonicalJournalRecovery = false
): Promise<ManagedTurnJournal> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const request = journal.request
    const evidence = request.turn.turnEvidence
    if (!evidence) throw new Error('managed recorder journal is missing TurnEvidence')
    const prepared = await prepareManagedRecorderTurn({
      workspace: request.cwd,
      provider: request.providerId,
      sessionId: request.sessionId,
      providerTurnId: request.providerTurnId,
      runId: request.turn.runId,
      userText: request.turn.userText,
      evidence,
      timing: request.timing,
      status: request.status,
      archiveFingerprint: journal.archiveFingerprint,
      expectedRecordId: journal.recordId,
      ...(allowCanonicalJournalRecovery ? { allowCanonicalJournalRecovery: true } : {}),
      allowObservedInterruption: managedObservedInterruptionAllowed(request),
      termination: managedTermination(journal),
      toolContentPolicy: request.turn.toolContentPolicy
    })
    if (prepared.status === 'disabled') {
      throw new Error(`managed recorder became disabled while a canonical journal was pending: ${prepared.reason}`)
    }
    if ('recordId' in prepared) return { ...journal, recordId: prepared.recordId }
    if (Date.now() >= deadline) throw new Error(prepared.reason)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function replayJournal(
  path: string,
  userDataDir: string,
  journal: ManagedTurnJournal,
  waitMs: number,
  commitHookEnv?: NodeJS.ProcessEnv
): Promise<'recovered' | 'pending'> {
  const input: ManagedTraceTurnCommitInput = {
    ...journal.request,
    userDataDir
  }
  assertManagedTraceInput(input)
  if (archiveFingerprint(input) !== journal.archiveFingerprint) {
    throw new Error(`managed recorder journal fingerprint mismatch for ${journal.request.turn.runId}`)
  }
  // This path only runs for a fingerprint-validated, terminal journal. It may safely rebuild a
  // lifecycle that an older recovery pass discarded before preparing the canonical handoff.
  const prepared = await prepareJournalRecord(journal, waitMs, true)
  await writeJournalState(userDataDir, prepared)
  await archiveJournal(prepared, userDataDir)
  const archiveCommitted: ManagedTurnJournal = { ...prepared, phase: 'archive_committed' }
  await writeJournalState(userDataDir, archiveCommitted)
  if (!archiveCommitted.recordId) throw new Error('managed recorder journal has no prepared record id')
  const evidence = archiveCommitted.request.turn.turnEvidence
  if (!evidence) throw new Error('managed recorder journal is missing TurnEvidence')
  const committed = await commitManagedRecorderTurn({
    workspace: archiveCommitted.request.cwd,
    provider: archiveCommitted.request.providerId,
    sessionId: archiveCommitted.request.sessionId,
    runId: archiveCommitted.request.turn.runId,
    recordId: archiveCommitted.recordId,
    archiveFingerprint: archiveCommitted.archiveFingerprint,
    providerTurnId: archiveCommitted.request.providerTurnId,
    userText: archiveCommitted.request.turn.userText,
    evidence,
    timing: archiveCommitted.request.timing,
    status: archiveCommitted.request.status,
    env: commitHookEnv,
    // record 已落盘；向仓库回调投递不能挡住轮次收口（App 常驻，剩余积压由后续投递补上）。
    commitNotifications: 'detach'
  })
  if (committed.status === 'disabled' || committed.status === 'pending' || committed.status === 'prepared') {
    throw new Error('reason' in committed ? committed.reason : 'managed recorder canonical commit is still pending')
  }
  await rm(progressPath(userDataDir, journal.request.turn.runId), { force: true })
  await rm(path, { force: true })
  // The sidecar is disposable. Remove it only after its immutable manifest is gone.
  await rm(journalStatePath(userDataDir, journal.request.turn.runId), { force: true })
  return 'recovered'
}


export async function commitManagedTraceTurn(
  input: ManagedTraceTurnCommitInput,
  options: {
    waitMs?: number
    removeArtifact?: (path: string) => Promise<void>
    commitHookEnv?: NodeJS.ProcessEnv
    requireManaged?: boolean
  } = {}
): Promise<{ recorder: 'disabled' | 'committed'; recordId?: string }> {
  const protectedInput = await protectManagedInput(input)
  input = protectedInput.input
  const mode = await managedRecorderMode(input.cwd, options.commitHookEnv)
  if (mode.status === 'disabled') {
    if (options.requireManaged === true) {
      throw new Error(`managed recorder mode changed after turn start for ${input.turn.runId}`)
    }
    // Both reads are outside the run lock; reuse the protection read instead of reading again.
    const existing = protectedInput.archiveMatch ? protectedInput.archiveMatch.turn : await matchingArchiveTurn(input)
    if (existing) {
      const disposition = existingTurnDisposition(existing, input.turn)
      if (disposition === 'conflict') {
        throw new Error(`managed recorder progress conflicts with committed archive: ${input.turn.runId}`)
      }
      if (disposition === 'existing_dominates') {
        await rm(progressPath(input.userDataDir, input.turn.runId), { force: true })
        return { recorder: 'disabled' }
      }
    }
    const ok = await upsertTraceArchiveTurnAsync({
      cwd: input.cwd,
      sessionId: input.sessionId,
      providerId: input.providerId,
      runtimeProvider: input.runtimeProvider,
      userDataDir: input.userDataDir,
      turn: input.turn
    })
    if (!ok) throw new Error(`could not persist Scry archive for ${input.turn.runId}`)
    await rm(progressPath(input.userDataDir, input.turn.runId), { force: true })
    return { recorder: 'disabled' }
  }
  assertManagedTraceInput(input)

  const path = journalPath(input.userDataDir, input.turn.runId)
  const removeArtifact = options.removeArtifact ?? ((target: string) => rm(target, { force: true }))
  return withDirectoryLock(lockPath(input.userDataDir, input.turn.runId), async () => {
    const fingerprint = archiveFingerprint(input)
    const existing = await readManagedJournal(input.userDataDir, input.turn.runId)
    if (existing && existing.archiveFingerprint !== fingerprint) {
      throw new Error(`managed recorder journal collision for ${input.turn.runId}`)
    }
    if (!existing) await rm(journalStatePath(input.userDataDir, input.turn.runId), { force: true })
    const journal: ManagedTurnJournal = existing ?? {
      schemaVersion: 1,
      phase: 'prepared',
      archiveFingerprint: fingerprint,
      request: {
        cwd: input.cwd,
        sessionId: input.sessionId,
        providerTurnId: input.providerTurnId,
        providerId: input.providerId,
        runtimeProvider: input.runtimeProvider,
        turn: input.turn,
        timing: input.timing,
        status: input.status
      }
    }
    if (!existing) await writeJsonAtomic(path, journal)
    const prepared = await prepareJournalRecord(journal, options.waitMs ?? 5_000)
    await writeJournalState(input.userDataDir, prepared)
    await archiveJournal(prepared, input.userDataDir)
    const archiveCommitted: ManagedTurnJournal = { ...prepared, phase: 'archive_committed' }
    await writeJournalState(input.userDataDir, archiveCommitted)
    if (!archiveCommitted.recordId) throw new Error('managed recorder journal has no prepared record id')
    const evidence = archiveCommitted.request.turn.turnEvidence
    if (!evidence) throw new Error('managed recorder journal is missing TurnEvidence')
    const committed = await commitManagedRecorderTurn({
      workspace: input.cwd,
      provider: input.providerId,
      sessionId: input.sessionId,
      runId: input.turn.runId,
      recordId: archiveCommitted.recordId,
      archiveFingerprint: archiveCommitted.archiveFingerprint,
      providerTurnId: input.providerTurnId,
      userText: input.turn.userText,
      evidence,
      timing: input.timing,
      status: input.status,
      env: options.commitHookEnv,
      commitNotifications: 'detach'
    })
    if (committed.status !== 'committed' && committed.status !== 'duplicate') {
      throw new Error('reason' in committed ? committed.reason : 'managed recorder canonical commit is still pending')
    }
    await removeArtifact(progressPath(input.userDataDir, input.turn.runId))
    await removeArtifact(path)
    // A state orphan cannot authorize recovery without the manifest and is cleaned second.
    await removeArtifact(journalStatePath(input.userDataDir, input.turn.runId))
    return { recorder: 'committed' as const, recordId: committed.recordId }
  })
}

export async function persistManagedTraceProgress(
  input: ManagedTraceTurnCommitInput
): Promise<void> {
  input = (await protectManagedInput(input)).input
  assertManagedTraceInput(input)
  const path = progressPath(input.userDataDir, input.turn.runId)
  const existing = await readJson<ManagedTurnProgress>(path)
  if (existing) {
    if (existing.schemaVersion !== 1) {
      throw new Error(`invalid managed recorder progress for ${input.turn.runId}`)
    }
    assertProgressIdentity(existing, input)
  }
  const { userDataDir: _userDataDir, ...request } = input
  await writeJsonAtomic(path, {
    schemaVersion: 1,
    persistedAt: new Date().toISOString(),
    request
  } satisfies ManagedTurnProgress)
}

export async function recoverManagedTraceProgress(
  userDataDir: string,
  options: {
    cwd?: string
    sessionId?: string
    providerId?: ManagedRecorderProviderId
    waitMs?: number
    commitHookEnv?: NodeJS.ProcessEnv
    isLiveManagedRun?: (runId: string) => boolean
  } = {}
): Promise<ManagedTurnRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  const scoped = Boolean(options.cwd || options.sessionId || options.providerId)
  for (const name of await listFiles(progressRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(progressRoot(userDataDir), name)
    const progress = await readJson<ManagedTurnProgress>(path)
    if (!validProgress(progress)) {
      const identity = managedArtifactIdentity(progress)
      if (!scoped || (identity && managedIdentityMatches(identity, options))) {
        pending++
        errors.push(`invalid managed turn progress: ${name}`)
      }
      continue
    }
    if (options.cwd && progress.request.cwd !== options.cwd) continue
    if (options.sessionId && progress.request.sessionId !== options.sessionId) continue
    if (options.providerId && progress.request.providerId !== options.providerId) continue
    if (options.isLiveManagedRun?.(progress.request.turn.runId)) continue
    try {
      const canonicalJournalPath = journalPath(userDataDir, progress.request.turn.runId)
      const journal = await readJson<ManagedTurnJournal>(canonicalJournalPath)
      if (journal || artifactExists(canonicalJournalPath)) {
        pending++
        errors.push(`managed turn ${progress.request.turn.runId} has a canonical journal that must recover first`)
        continue
      }
      const input = { ...progress.request, userDataDir }
      assertManagedTraceInput(input)
      const existing = await matchingArchiveTurn(input)
      if (existing) {
        const disposition = existingTurnDisposition(existing, progress.request.turn)
        if (disposition === 'conflict') {
          throw new Error(`managed recorder progress conflicts with committed archive: ${progress.request.turn.runId}`)
        }
        if (disposition === 'existing_dominates') {
          await rm(path, { force: true })
          recovered++
          continue
        }
      }
      await commitManagedTraceTurn(
        input,
        { waitMs: options.waitMs ?? 250, commitHookEnv: options.commitHookEnv, requireManaged: true }
      )
      recovered++
    } catch (error) {
      pending++
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { recovered, pending, errors }
}

export async function recoverManagedTraceTurns(
  userDataDir: string,
  options: {
    cwd?: string
    sessionId?: string
    providerId?: ManagedRecorderProviderId
    waitMs?: number
    commitHookEnv?: NodeJS.ProcessEnv
    isLiveManagedRun?: (runId: string) => boolean
  } = {}
): Promise<ManagedTurnRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  const scoped = Boolean(options.cwd || options.sessionId || options.providerId)
  for (const name of await listFiles(journalRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(journalRoot(userDataDir), name)
    const journal = await readManagedJournalAt(
      path,
      join(journalStateRoot(userDataDir), name)
    )
    if (!validJournal(journal)) {
      const identity = managedArtifactIdentity(journal)
      if (!scoped || (identity && managedIdentityMatches(identity, options))) {
        pending++
        errors.push(`invalid managed turn journal: ${name}`)
      }
      continue
    }
    if (options.cwd && journal.request.cwd !== options.cwd) continue
    if (options.sessionId && journal.request.sessionId !== options.sessionId) continue
    if (options.providerId && journal.request.providerId !== options.providerId) continue
    if (options.isLiveManagedRun?.(journal.request.turn.runId)) continue
    const result = await withDirectoryLock(
      lockPath(userDataDir, journal.request.turn.runId),
      () => replayJournal(path, userDataDir, journal, options.waitMs ?? 250, options.commitHookEnv),
      { waitMs: options.waitMs ?? 250 }
    ).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error))
      return 'pending' as const
    })
    if (result === 'recovered') recovered++
    else {
      pending++
      errors.push(`managed turn ${journal.request.turn.runId} is still pending`)
    }
  }
  return { recovered, pending, errors }
}
