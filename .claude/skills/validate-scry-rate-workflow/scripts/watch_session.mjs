#!/usr/bin/env node
// Read-only progress watcher for the owned "Scry Test" renderer of one run.
//
// Renderer idle is necessary but not sufficient: a turn is complete only when
// the exact workspace/provider/session has both a done archive turn and a
// completed CLI record with the same unique providerTurnId.  The first turn
// freezes that unique session identity for every later invocation.
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateCdp, waitForRendererOwnership } from './cdp_ownership.mjs'

const SESSION_FILE = 'turn-session.json'
const QUESTION_JOURNAL_FILE = 'qoder-question-journal.json'
const LEASE_HANDOVER_JOURNAL_FILE = 'lease-handover-question.json'
const LEASE_HANDOVER_AUTHORIZATION_FILE = 'lease-handover-authorization.json'
const CONTRACT = JSON.parse(readFileSync(new URL('../references/contract.json', import.meta.url), 'utf8'))
const FIXED_DOCUMENT_URL = CONTRACT.document.url

function parseOptions(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid option near ${key ?? '<end>'}`)
    result.set(key.slice(2), value)
  }
  return result
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

function writeJsonExclusiveAtomic(path, value) {
  const temporary = `${path}.claim-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    // link(2) creates the final name atomically without replacing a journal
    // another watcher may have won between our observation and this write.
    linkSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function filesRecursively(root, predicate) {
  if (!existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && predicate(entry.name)) found.push(path)
    }
  }
  visit(root)
  return found.sort()
}

function safeRead(path, readErrors) {
  try {
    return readJson(path)
  } catch (error) {
    readErrors.push({ path, error: error?.name ?? 'Error' })
    return null
  }
}

function afterLaunch(value, launchedAt) {
  const moment = Date.parse(value ?? '')
  const launch = Date.parse(launchedAt ?? '')
  return Number.isFinite(moment) && Number.isFinite(launch) && moment >= launch
}

function addGrouped(groups, sessionId, value) {
  if (typeof sessionId !== 'string' || !sessionId) return
  const items = groups.get(sessionId) ?? []
  items.push(value)
  groups.set(sessionId, items)
}

function archiveTurns(state, provider, readErrors) {
  const groups = new Map()
  const root = join(state.userDataDir, 'trace-archive-turns-v1')
  for (const path of filesRecursively(root, (name) => /^turn-.*\.json$/.test(name))) {
    const archive = safeRead(path, readErrors)
    if (
      !archive
      || archive.cwd !== state.expectedWorkspace
      || archive.providerId !== provider
      || !Array.isArray(archive.turns)
    ) continue
    for (const turn of archive.turns) {
      if (!turn || !afterLaunch(turn.startedAt, state.startedAt)) continue
      addGrouped(groups, archive.sessionId, {
        providerTurnId: turn.providerTurnId,
        status: turn.status,
        done: turn.done,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        userText: turn.userText,
      })
    }
  }
  return groups
}

function cliRecords(state, provider, readErrors) {
  const groups = new Map()
  const root = join(state.expectedWorkspace, '.scry', 'records')
  for (const path of filesRecursively(root, (name) => name.endsWith('.json'))) {
    const record = safeRead(path, readErrors)
    if (
      !record
      || record.workspace?.root !== state.expectedWorkspace
      || record.provider?.id !== provider
      || !afterLaunch(record.startedAt, state.startedAt)
    ) continue
    addGrouped(groups, record.sessionId, {
      providerTurnId: record.providerTurnId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      turnIndex: record.turnIndex,
      userText: record.user?.value?.text,
    })
  }
  return groups
}

function duplicateValues(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

function assessSession(sessionId, archives, records, expectedPrompts) {
  const reasons = []
  const archiveIds = archives.map((item) => item.providerTurnId)
  const recordIds = records.map((item) => item.providerTurnId)
  const invalidArchiveIds = archiveIds.filter((value) => typeof value !== 'string' || !value)
  const invalidRecordIds = recordIds.filter((value) => typeof value !== 'string' || !value)
  const archiveDuplicates = duplicateValues(archiveIds)
  const recordDuplicates = duplicateValues(recordIds)
  const expectedTurns = expectedPrompts.length
  if (archives.length !== expectedTurns) reasons.push(`archive_count:${archives.length}!=${expectedTurns}`)
  if (records.length !== expectedTurns) reasons.push(`record_count:${records.length}!=${expectedTurns}`)
  if (archives.some((item) => item.done !== true || item.status !== 'completed' || typeof item.completedAt !== 'string')) {
    reasons.push('archive_not_done')
  }
  if (records.some((item) => item.status !== 'completed' || typeof item.completedAt !== 'string')) {
    reasons.push('record_not_completed')
  }
  if (invalidArchiveIds.length || archiveDuplicates.length) reasons.push('archive_provider_turn_id_not_unique')
  if (invalidRecordIds.length || recordDuplicates.length) reasons.push('record_provider_turn_id_not_unique')
  if (
    invalidArchiveIds.length === 0
    && invalidRecordIds.length === 0
    && (archiveIds.length !== recordIds.length || archiveIds.some((value) => !recordIds.includes(value)))
  ) reasons.push('provider_turn_id_sets_differ')

  const orderedArchives = [...archives].sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)))
  const orderedRecords = [...records].sort((left, right) => {
    if (Number.isInteger(left.turnIndex) && Number.isInteger(right.turnIndex)) return left.turnIndex - right.turnIndex
    return String(left.startedAt).localeCompare(String(right.startedAt))
  })
  if (orderedArchives.some((item, index) => item.userText !== expectedPrompts[index])) reasons.push('archive_prompt_mismatch')
  if (orderedRecords.some((item, index) => item.userText !== expectedPrompts[index])) reasons.push('record_prompt_mismatch')

  const exactTerminalCounts = Boolean(
    archives.length === expectedTurns
    && records.length === expectedTurns
    && archives.every((item) => item.done === true && item.status === 'completed' && typeof item.completedAt === 'string')
    && records.every((item) => item.status === 'completed' && typeof item.completedAt === 'string'),
  )
  const terminalIdentityMismatch = reasons.some((reason) => [
    'archive_provider_turn_id_not_unique',
    'record_provider_turn_id_not_unique',
    'provider_turn_id_sets_differ',
    'archive_prompt_mismatch',
    'record_prompt_mismatch',
  ].includes(reason))
  const irrecoverable = Boolean(
    archives.length > expectedTurns
    || records.length > expectedTurns
    || (exactTerminalCounts && terminalIdentityMismatch),
  )

  return {
    sessionId,
    ready: reasons.length === 0,
    irrecoverable,
    reasons,
    archiveTurns: archives.length,
    doneArchiveTurns: archives.filter((item) => item.done === true && item.status === 'completed').length,
    cliRecords: records.length,
    completedCliRecords: records.filter((item) => item.status === 'completed').length,
    providerTurnIds: [...new Set(archiveIds.filter((value) => typeof value === 'string' && value))].sort(),
  }
}

function rendererTurnOverflow(renderer, expectedTurns) {
  return Boolean(
    renderer?.identity === true
    && Number.isInteger(renderer.turnCount)
    && renderer.turnCount > expectedTurns,
  )
}

function loadSendEvidence(runRoot, expectedTurns) {
  const evidence = []
  for (let turn = 1; turn <= expectedTurns; turn += 1) {
    const path = join(runRoot, `turn${turn}-send.json`)
    if (!existsSync(path)) throw new Error(`send evidence missing for turn ${turn}: ${path}`)
    const value = readJson(path)
    if (value.turn !== turn || typeof value.provider !== 'string' || typeof value.text !== 'string') {
      throw new Error(`invalid send evidence for turn ${turn}: ${path}`)
    }
    evidence.push(value)
  }
  const providers = new Set(evidence.map((item) => item.provider))
  if (providers.size !== 1) throw new Error(`send evidence provider drift: ${JSON.stringify([...providers])}`)
  const workitemId = evidence[0].workitemId
  if (typeof workitemId !== 'string' || !/^\d+$/.test(workitemId)) {
    throw new Error('turn 1 send evidence has no plain numeric workitemId')
  }
  return { provider: evidence[0].provider, prompts: evidence.map((item) => item.text), workitemId }
}

function loadFrozenSession(runRoot, state, provider) {
  const path = join(runRoot, SESSION_FILE)
  if (!existsSync(path)) return null
  const value = readJson(path)
  if (
    value.schemaVersion !== 1
    || value.runRoot !== runRoot
    || value.workspace !== state.expectedWorkspace
    || value.provider !== provider
    || value.launchId !== state.launchId
    || typeof value.sessionId !== 'string'
    || !value.sessionId
  ) throw new Error(`frozen turn session identity is invalid: ${path}`)
  return value
}

function persistedEvidence(runRoot, state, provider, expectedPrompts, frozen) {
  const readErrors = []
  const archives = archiveTurns(state, provider, readErrors)
  const records = cliRecords(state, provider, readErrors)
  const sessionIds = [...new Set([...archives.keys(), ...records.keys()])].sort()
  const candidates = sessionIds.map((sessionId) => assessSession(
    sessionId,
    archives.get(sessionId) ?? [],
    records.get(sessionId) ?? [],
    expectedPrompts,
  ))
  const ready = candidates.filter((item) => item.ready)
  const failed = candidates.filter((item) => item.irrecoverable)
  const selected = frozen
    ? ready.find((item) => item.sessionId === frozen.sessionId) ?? null
    : candidates.length === 1 && ready.length === 1 ? ready[0] : null
  let stateName = selected ? 'ready' : 'pending'
  if (
    (frozen && failed.some((item) => item.sessionId === frozen.sessionId))
    || (!frozen && candidates.length === 1 && failed.length === 1)
  ) stateName = 'failed'
  if (!frozen && candidates.length > 1) stateName = 'ambiguous'
  if (frozen && candidates.some((item) => item.sessionId !== frozen.sessionId)) stateName = 'session_drift'
  return {
    state: stateName,
    expectedTurns: expectedPrompts.length,
    selected,
    failed,
    candidates,
    readErrors,
  }
}

function freezeSession(runRoot, state, provider, selected) {
  const path = join(runRoot, SESSION_FILE)
  const existing = loadFrozenSession(runRoot, state, provider)
  if (existing) {
    if (existing.sessionId !== selected.sessionId) throw new Error('completed session differs from frozen session')
    return existing
  }
  const value = {
    schemaVersion: 1,
    runRoot,
    workspace: state.expectedWorkspace,
    provider,
    launchId: state.launchId,
    sessionId: selected.sessionId,
    firstTurnProviderTurnIds: selected.providerTurnIds,
    frozenAt: new Date().toISOString(),
  }
  writeJsonAtomic(path, value)
  return value
}

function questionFingerprint(question) {
  const canonical = {
    head: typeof question?.head === 'string' ? question.head : null,
    legends: Array.isArray(question?.legends) ? question.legends : [],
    options: Array.isArray(question?.options) ? question.options : [],
    links: Array.isArray(question?.links) ? question.links : [],
    runId: typeof question?.runId === 'string' ? question.runId : null,
    toolCallId: typeof question?.toolCallId === 'string' ? question.toolCallId : null,
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

function questionSessionId(frozen, persistence, state, provider, firstPrompt, question) {
  if (typeof frozen?.sessionId === 'string' && frozen.sessionId) return frozen.sessionId
  const ids = [...new Set(
    (persistence?.candidates ?? [])
      .map((candidate) => candidate?.sessionId)
      .filter((value) => typeof value === 'string' && value),
  )]
  if (ids.length === 1) return ids[0]
  try {
    const sessions = readJson(join(state.userDataDir, 'app-sessions.json'))
    const matches = Array.isArray(sessions)
      ? sessions.filter((item) => (
          item
          && item.cwd === state.expectedWorkspace
          && item.providerId === provider
          && item.preview === firstPrompt
          && (!question?.runId || item.runId === question.runId)
          && typeof item.sessionId === 'string'
          && item.sessionId
        ))
      : []
    const sessionIds = [...new Set(matches.map((item) => item.sessionId))]
    return sessionIds.length === 1 ? sessionIds[0] : null
  } catch {
    return null
  }
}

function questionObservation(state, question, sessionId) {
  return {
    observedAt: new Date().toISOString(),
    launchId: state.launchId,
    sessionId,
    runId: typeof question?.runId === 'string' && question.runId ? question.runId : null,
    toolCallId: typeof question?.toolCallId === 'string' && question.toolCallId ? question.toolCallId : null,
    questionFingerprint: questionFingerprint(question),
    links: Array.isArray(question?.links)
      ? question.links.filter((value) => typeof value === 'string')
      : [],
  }
}

function readQuestionJournal(path, runRoot, launchId) {
  try {
    if (lstatSync(path).isSymbolicLink()) return { valid: false, error: 'journal_is_symlink' }
    const value = readJson(path)
    const valid = Boolean(
      value
      && value.schemaVersion === 1
      && value.runRoot === runRoot
      && value.provider === 'qoder'
      && value.expectedTurns === 1
      && value.launchId === launchId
      && value.fixedDocumentUrl === FIXED_DOCUMENT_URL
      && Number.isInteger(value.observationCount)
      && value.observationCount >= 1
      && Number.isInteger(value.distinctQuestionCount)
      && value.distinctQuestionCount >= 1
      && typeof value.questionFingerprint === 'string'
      && value.questionFingerprint.startsWith('sha256:'),
    )
    return valid ? { valid: true, value } : { valid: false, error: 'journal_identity_invalid' }
  } catch (error) {
    return { valid: false, error: `journal_unreadable:${error?.name ?? 'Error'}` }
  }
}

function recordQoderAnswer(runRoot, answer) {
  const path = join(runRoot, QUESTION_JOURNAL_FILE)
  if (!existsSync(path)) throw new Error(`Qoder question journal is missing: ${path}`)
  const launchState = readJson(join(runRoot, 'test-scry-state.json'))
  const loaded = readQuestionJournal(path, runRoot, launchState.launchId)
  if (!loaded.valid) throw new Error(`Qoder question journal is invalid: ${loaded.error}`)
  if (loaded.value.state !== 'WAITING_FOR_QODER_QUESTION' || loaded.value.answerEvidence) {
    throw new Error(`Qoder answer was already recorded or is not waiting: ${loaded.value.state}`)
  }
  const normalizedAnswer = typeof answer === 'string' ? answer.trim() : ''
  if (!normalizedAnswer) throw new Error('Qoder answer stdin must not be empty')
  const evidence = {
    bytes: Buffer.byteLength(normalizedAnswer, 'utf8'),
    sha256: `sha256:${createHash('sha256').update(normalizedAnswer).digest('hex')}`,
    recordedAt: new Date().toISOString(),
  }
  writeJsonAtomic(path, {
    ...loaded.value,
    state: 'ANSWER_RECORDED',
    answerEvidence: evidence,
  })
  return { ok: true, state: 'ANSWER_RECORDED', questionJournalPath: path, answerEvidence: evidence }
}

function sameQuestionIdentity(prior, observation) {
  if (prior.toolCallId && observation.toolCallId) return prior.toolCallId === observation.toolCallId
  if (prior.runId && observation.runId && prior.runId !== observation.runId) return false
  return prior.questionFingerprint === observation.questionFingerprint
}

function existingQuestionState(runRoot, state, journalPath, observation) {
  const prior = readQuestionJournal(journalPath, runRoot, state.launchId)
  if (!prior.valid) {
    return {
      state: 'SESSION_FAIL',
      exitCode: 5,
      reason: 'qoder_question_journal_invalid',
      manualReviewRequired: true,
      autoAnswered: false,
      questionJournalPath: journalPath,
      journalError: prior.error,
    }
  }
  const observationCount = prior.value.observationCount + 1
  const sameQuestion = sameQuestionIdentity(prior.value, observation)
  if (sameQuestion && prior.value.state === 'WAITING_FOR_QODER_QUESTION') {
    writeJsonAtomic(journalPath, {
      ...prior.value,
      observationCount,
      lastObservedAt: observation.observedAt,
      lastObservation: observation,
    })
    return {
      state: 'WAITING_FOR_QODER_QUESTION',
      exitCode: 3,
      idempotentObservation: true,
      manualReviewRequired: true,
      autoAnswered: false,
      questionJournalPath: journalPath,
      observationCount,
      questionFingerprint: observation.questionFingerprint,
      sessionId: observation.sessionId,
      toolCallId: observation.toolCallId,
    }
  }
  if (sameQuestion && prior.value.state === 'ANSWER_RECORDED') {
    writeJsonAtomic(journalPath, {
      ...prior.value,
      observationCount,
      lastObservedAt: observation.observedAt,
      lastObservation: observation,
    })
    return {
      state: 'WAITING_FOR_QODER_ANSWER_ACK',
      continueWatching: true,
      manualReviewRequired: false,
      autoAnswered: false,
      questionJournalPath: journalPath,
      observationCount,
      questionFingerprint: observation.questionFingerprint,
    }
  }
  const updated = {
    ...prior.value,
    observationCount,
    lastObservedAt: observation.observedAt,
    lastObservation: observation,
    state: 'SESSION_FAIL',
    distinctQuestionCount: 2,
    failureReason: 'second_qoder_question',
  }
  writeJsonAtomic(journalPath, updated)
  return {
    state: 'SESSION_FAIL',
    exitCode: 5,
    reason: 'second_qoder_question',
    manualReviewRequired: true,
    autoAnswered: false,
    questionJournalPath: journalPath,
    observationCount,
    firstQuestionFingerprint: prior.value.questionFingerprint,
    repeatedQuestionFingerprint: observation.questionFingerprint,
  }
}

function leaseHandoverQuestion(question, workitemId) {
  if (!question || typeof workitemId !== 'string' || !/^\d+$/.test(workitemId)) return false
  const legends = Array.isArray(question.legends) ? question.legends.filter((value) => typeof value === 'string') : []
  const options = Array.isArray(question.options) ? question.options.filter((value) => typeof value === 'string') : []
  const body = legends.join('\n')
  const fullQuestion = `${body}\n${options.join('\n')}`
  const hasReq = new RegExp(`(?:\\bREQ-?|需求\\s*)${workitemId}\\b`, 'i').test(body)
  const hasActiveGeneration = /活动\s*generation|active\s+generation|另一个会话占用|旧\s*generation|旧代/i.test(fullQuestion)
  const hasRestartImpact = /放弃旧代|放弃旧\s*generation|从\s*P0\s*(?:重跑|重新运行)|重新开始摄入|重新摄入/i.test(fullQuestion)
  const hasLease = /\bLEASE\b|租约|orphaned\s+lease/i.test(fullQuestion) || (hasActiveGeneration && hasRestartImpact)
  const affirmative = options.some((value) => /^(?:是(?:[，,\s]|$)|(?:在本|当前)会话继续|继续(?:[，,\s]|$)|放弃旧代并(?:继续|重跑))/u.test(value.trim()))
  const negative = options.some((value) => /^(?:否(?:[，,\s]|$)|先不继续|暂不继续|不继续(?:[，,\s]|$)|保留旧)/u.test(value.trim()))
  return hasReq && hasLease && hasActiveGeneration && hasRestartImpact && affirmative && negative
}

function recoverableLeaseMisclassification(path, observation) {
  try {
    const prior = readJson(path)
    return Boolean(
      prior
      && prior.schemaVersion === 1
      && prior.state === 'SESSION_FAIL'
      && prior.failureReason === 'qoder_document_url_mismatch'
      && prior.questionFingerprint === observation.questionFingerprint
      && Array.isArray(prior.observedLinks)
      && prior.observedLinks.length === 0
      && prior.distinctQuestionCount === 1
    )
  } catch {
    return false
  }
}

function readLeaseHandoverJournal(path, runRoot, state, provider, workitemId) {
  try {
    if (lstatSync(path).isSymbolicLink()) return { valid: false, error: 'journal_is_symlink' }
    const value = readJson(path)
    const valid = Boolean(
      value
      && value.schemaVersion === 1
      && value.state === 'WAITING_FOR_LEASE_HANDOVER'
      && value.runRoot === runRoot
      && value.provider === provider
      && value.expectedTurns === 1
      && value.workitemId === workitemId
      && value.launchId === state.launchId
      && typeof value.questionFingerprint === 'string'
      && value.questionFingerprint.startsWith('sha256:')
      && Number.isInteger(value.observationCount)
      && value.observationCount >= 1,
    )
    return valid ? { valid: true, value } : { valid: false, error: 'journal_identity_invalid' }
  } catch (error) {
    return { valid: false, error: `journal_unreadable:${error?.name ?? 'Error'}` }
  }
}

function leaseStatusProvesInactiveOwner(value, workitemId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value.status
  const doctor = value.doctor
  const taskId = `REQ-${workitemId}`
  if (
    !status || typeof status !== 'object' || Array.isArray(status)
    || status.task_id !== taskId
    || status.lifecycle_status !== 'active'
    || status.delivery_complete !== false
    || !doctor || typeof doctor !== 'object' || Array.isArray(doctor)
    || doctor.target_task !== taskId
    || doctor.turn?.state !== 'open'
    || !Number.isInteger(doctor.turn?.opened_ms)
    || doctor.turn.opened_ms <= 0
    || doctor.prompt_receipts !== 1
    || typeof doctor.runtime_session !== 'string'
    || !doctor.runtime_session
    || !Array.isArray(doctor.parallel_active_leases)
  ) return false
  const conflicts = doctor.parallel_active_leases.filter((item) => item?.task_id === taskId)
  if (conflicts.length !== 1) return false
  const conflict = conflicts[0]
  const owner = conflict.owner
  return Boolean(
    typeof conflict.task_generation === 'string'
    && conflict.task_generation
    && typeof conflict.owner_session_id === 'string'
    && conflict.owner_session_id
    && owner && typeof owner === 'object' && !Array.isArray(owner)
    && owner.session_id === conflict.owner_session_id
    && Number.isInteger(owner.last_activity_ms)
    && owner.last_activity_ms >= 0
    && owner.last_activity_ms < doctor.turn.opened_ms,
  )
}

function readLeaseHandoverAuthorization(path, journal) {
  if (!existsSync(path)) return { state: 'missing', valid: false, error: null }
  try {
    if (lstatSync(path).isSymbolicLink()) return { state: 'invalid', valid: false, error: 'authorization_is_symlink' }
    const value = readJson(path)
    const valid = Boolean(
      value
      && value.schemaVersion === 1
      && value.state === 'AUTHORIZED'
      && value.runRoot === journal.runRoot
      && value.provider === journal.provider
      && value.expectedTurns === 1
      && value.workitemId === journal.workitemId
      && value.launchId === journal.launchId
      && value.questionFingerprint === journal.questionFingerprint
      && value.decision === 'continue'
      && value.impactAcknowledged === true
      && typeof value.userQuote === 'string'
      && value.userQuote.trim().length > 0
      && leaseStatusProvesInactiveOwner(value.oldGenerationStatus, journal.workitemId)
      && typeof value.authorizedAt === 'string'
      && Number.isFinite(Date.parse(value.authorizedAt)),
    )
    return valid
      ? { state: 'authorized', valid: true, value }
      : { state: 'invalid', valid: false, error: 'authorization_identity_invalid' }
  } catch (error) {
    return { state: 'invalid', valid: false, error: `authorization_unreadable:${error?.name ?? 'Error'}` }
  }
}

function leaseHandoverWaitingState(runRoot, journal, authorization, extra = {}) {
  return {
    state: authorization.valid ? 'WAITING_FOR_LEASE_HANDOVER' : authorization.state === 'invalid' ? 'SESSION_FAIL' : 'WAITING_FOR_LEASE_HANDOVER',
    exitCode: authorization.state === 'invalid' ? 5 : 3,
    reason: authorization.state === 'invalid' ? 'lease_handover_authorization_invalid' : undefined,
    manualReviewRequired: true,
    autoAnswered: false,
    authorized: authorization.valid,
    authorizationRequired: !authorization.valid,
    leaseHandoverJournalPath: join(runRoot, LEASE_HANDOVER_JOURNAL_FILE),
    authorizationPath: join(runRoot, LEASE_HANDOVER_AUTHORIZATION_FILE),
    authorizationError: authorization.error,
    observationCount: journal.observationCount,
    questionFingerprint: journal.questionFingerprint,
    workitemId: journal.workitemId,
    ...extra,
  }
}

function leaseHandoverQuestionState(runRoot, state, provider, question, sessionId, workitemId) {
  const journalPath = join(runRoot, LEASE_HANDOVER_JOURNAL_FILE)
  const authorizationPath = join(runRoot, LEASE_HANDOVER_AUTHORIZATION_FILE)
  const observation = questionObservation(state, question, sessionId)
  let journal
  if (existsSync(journalPath)) {
    const prior = readLeaseHandoverJournal(journalPath, runRoot, state, provider, workitemId)
    if (!prior.valid) {
      return {
        state: 'SESSION_FAIL',
        exitCode: 5,
        reason: 'lease_handover_journal_invalid',
        manualReviewRequired: true,
        autoAnswered: false,
        leaseHandoverJournalPath: journalPath,
        journalError: prior.error,
      }
    }
    if (!sameQuestionIdentity(prior.value, observation)) {
      return {
        state: 'SESSION_FAIL',
        exitCode: 5,
        reason: 'second_or_drifted_lease_handover_question',
        manualReviewRequired: true,
        autoAnswered: false,
        leaseHandoverJournalPath: journalPath,
        firstQuestionFingerprint: prior.value.questionFingerprint,
        repeatedQuestionFingerprint: observation.questionFingerprint,
      }
    }
    journal = {
      ...prior.value,
      observationCount: prior.value.observationCount + 1,
      lastObservedAt: observation.observedAt,
      lastObservation: observation,
    }
    writeJsonAtomic(journalPath, journal)
  } else {
    journal = {
      schemaVersion: 1,
      state: 'WAITING_FOR_LEASE_HANDOVER',
      runRoot,
      provider,
      expectedTurns: 1,
      workitemId,
      launchId: observation.launchId,
      sessionId: observation.sessionId,
      runId: observation.runId,
      toolCallId: observation.toolCallId,
      questionFingerprint: observation.questionFingerprint,
      observationCount: 1,
      firstObservedAt: observation.observedAt,
      firstObservation: observation,
    }
    try {
      writeJsonExclusiveAtomic(journalPath, journal)
    } catch (error) {
      if (error?.code === 'EEXIST') return leaseHandoverQuestionState(runRoot, state, provider, question, sessionId, workitemId)
      throw error
    }
  }
  const authorization = readLeaseHandoverAuthorization(authorizationPath, journal)
  return leaseHandoverWaitingState(runRoot, journal, authorization, {
    sessionId: observation.sessionId,
    toolCallId: observation.toolCallId,
  })
}

function pendingLeaseHandoverState(runRoot, state, provider, workitemId) {
  const journalPath = join(runRoot, LEASE_HANDOVER_JOURNAL_FILE)
  if (!existsSync(journalPath)) return null
  const loaded = readLeaseHandoverJournal(journalPath, runRoot, state, provider, workitemId)
  if (!loaded.valid) {
    return {
      state: 'SESSION_FAIL',
      exitCode: 5,
      reason: 'lease_handover_journal_invalid',
      manualReviewRequired: true,
      autoAnswered: false,
      leaseHandoverJournalPath: journalPath,
      journalError: loaded.error,
    }
  }
  const authorization = readLeaseHandoverAuthorization(
    join(runRoot, LEASE_HANDOVER_AUTHORIZATION_FILE),
    loaded.value,
  )
  return authorization.valid ? null : leaseHandoverWaitingState(runRoot, loaded.value, authorization, { questionVisible: false })
}

function recordLeaseHandoverAuthorization(runRoot, input) {
  const state = readJson(join(runRoot, 'test-scry-state.json'))
  const turnOne = readJson(join(runRoot, 'turn1-send.json'))
  const provider = turnOne.provider
  const workitemId = turnOne.workitemId
  const journalPath = join(runRoot, LEASE_HANDOVER_JOURNAL_FILE)
  if (!existsSync(journalPath)) throw new Error(`lease handover journal is missing: ${journalPath}`)
  const loaded = readLeaseHandoverJournal(journalPath, runRoot, state, provider, workitemId)
  if (!loaded.valid) throw new Error(`lease handover journal is invalid: ${loaded.error}`)
  if (
    !input
    || input.decision !== 'continue'
    || input.impactAcknowledged !== true
    || typeof input.userQuote !== 'string'
    || !input.userQuote.trim()
    || !leaseStatusProvesInactiveOwner(input.oldGenerationStatus, workitemId)
  ) {
    throw new Error('authorization needs explicit user consent plus status/doctor evidence proving the old owner was inactive after this turn opened')
  }
  const authorizationPath = join(runRoot, LEASE_HANDOVER_AUTHORIZATION_FILE)
  const authorization = {
    schemaVersion: 1,
    state: 'AUTHORIZED',
    runRoot,
    provider,
    expectedTurns: 1,
    workitemId,
    launchId: state.launchId,
    questionFingerprint: loaded.value.questionFingerprint,
    decision: 'continue',
    impactAcknowledged: true,
    userQuote: input.userQuote.trim(),
    oldGenerationStatus: input.oldGenerationStatus,
    authorizedAt: new Date().toISOString(),
  }
  writeJsonExclusiveAtomic(authorizationPath, authorization)
  return {
    ok: true,
    state: 'AUTHORIZED',
    authorizationPath,
    questionFingerprint: authorization.questionFingerprint,
    workitemId,
  }
}

function questionState(runRoot, state, provider, expectedTurns, question, sessionId, workitemId) {
  if (!question) return null
  const links = Array.isArray(question.links) ? question.links.filter((value) => typeof value === 'string') : []
  const qoderDocumentQuestion = provider === 'qoder'
    && expectedTurns === 1
    && links.length === 1
    && links[0] === FIXED_DOCUMENT_URL
  if (qoderDocumentQuestion && existsSync(join(runRoot, LEASE_HANDOVER_JOURNAL_FILE))) {
    return {
      state: 'SESSION_FAIL', exitCode: 5, reason: 'second_manual_question', manualReviewRequired: true, autoAnswered: false,
    }
  }
  if (expectedTurns === 1 && leaseHandoverQuestion(question, workitemId)) {
    const documentJournalPath = join(runRoot, QUESTION_JOURNAL_FILE)
    if (existsSync(documentJournalPath)) {
      const observation = questionObservation(state, question, sessionId)
      if (!recoverableLeaseMisclassification(documentJournalPath, observation)) {
        return {
          state: 'SESSION_FAIL', exitCode: 5, reason: 'second_manual_question', manualReviewRequired: true, autoAnswered: false,
        }
      }
    }
    return leaseHandoverQuestionState(runRoot, state, provider, question, sessionId, workitemId)
  }
  if (provider !== 'qoder' || expectedTurns !== 1) {
    return {
      state: 'SESSION_FAIL',
      exitCode: 5,
      reason: provider === 'qoder' ? 'qoder_question_outside_first_turn' : 'question_from_non_qoder_provider',
      manualReviewRequired: true,
      autoAnswered: false,
    }
  }

  const journalPath = join(runRoot, QUESTION_JOURNAL_FILE)
  const observation = questionObservation(state, question, sessionId)
  if (existsSync(journalPath)) return existingQuestionState(runRoot, state, journalPath, observation)

  const linksMatch = observation.links.length === 1 && observation.links[0] === FIXED_DOCUMENT_URL
  const journal = {
    schemaVersion: 1,
    state: linksMatch ? 'WAITING_FOR_QODER_QUESTION' : 'SESSION_FAIL',
    runRoot,
    provider,
    expectedTurns,
    launchId: observation.launchId,
    sessionId: observation.sessionId,
    runId: observation.runId,
    toolCallId: observation.toolCallId,
    questionFingerprint: observation.questionFingerprint,
    fixedDocumentUrl: FIXED_DOCUMENT_URL,
    observedLinks: observation.links,
    observationCount: 1,
    distinctQuestionCount: 1,
    firstObservedAt: observation.observedAt,
    firstObservation: observation,
    ...(linksMatch ? {} : { failureReason: 'qoder_document_url_mismatch' }),
  }
  try {
    writeJsonExclusiveAtomic(journalPath, journal)
  } catch (error) {
    if (error?.code === 'EEXIST') return existingQuestionState(runRoot, state, journalPath, observation)
    throw error
  }
  if (linksMatch) {
    return {
      state: 'WAITING_FOR_QODER_QUESTION',
      exitCode: 3,
      manualReviewRequired: true,
      autoAnswered: false,
      questionJournalPath: journalPath,
      observationCount: 1,
      questionFingerprint: observation.questionFingerprint,
      sessionId: observation.sessionId,
      toolCallId: observation.toolCallId,
    }
  }
  return {
    state: 'SESSION_FAIL',
    exitCode: 5,
    reason: 'qoder_document_url_mismatch',
    manualReviewRequired: true,
    autoAnswered: false,
    expectedDocumentUrl: FIXED_DOCUMENT_URL,
    observedLinks: observation.links,
    questionJournalPath: journalPath,
    observationCount: 1,
  }
}

const SNAPSHOT = (launchId) => `(() => {
  const question = document.querySelector('form.question-form')
  const questionInputName = question?.querySelector('input[name^="question-"]')?.getAttribute('name') ?? null
  const toolCallMatch = questionInputName?.match(/^question-(.+)-\\d+$/) ?? null
  const runLabel = question?.closest('.turn-assistant')?.querySelector('.runid')?.textContent?.trim() ?? null
  const anchorLinks = question ? [...question.querySelectorAll('a[href]')].map((node) => node.href) : []
  const textLinks = question
    ? [...question.innerText.matchAll(/https?:\\/\\/[^\\s<>"']+/g)]
        .map((match) => match[0].replace(/[)\\]}>.,;!?，。；！？]+$/u, ''))
    : []
  const questionLinks = [...new Set([...anchorLinks, ...textLinks])]
  const turns = document.querySelectorAll('.turn')
  const last = turns[turns.length - 1]
  return {
    at: new Date().toISOString(),
    identity: document.documentElement.dataset.scryTestApp === 'true'
      && document.documentElement.dataset.scryTestLaunchId === ${JSON.stringify(launchId)},
    turnCount: turns.length,
    busy: Boolean(document.querySelector('button.stop')),
    sendLabel: document.querySelector('.send-label')?.textContent?.trim() ?? null,
    inputValue: document.querySelector('.composer textarea')?.value ?? null,
    composerError: document.querySelector('.composer-error')?.textContent?.trim() ?? null,
    question: question
      ? {
          head: question.querySelector('.question-dialog-head')?.innerText?.trim() ?? null,
          legends: [...question.querySelectorAll('legend')].map((node) => node.innerText.trim()),
          options: [...question.querySelectorAll('label.question-option')].map((node) => node.innerText.trim().slice(0, 200)),
          links: questionLinks,
          runId: runLabel?.replace(/^run\\s*·\\s*/, '') || null,
          toolCallId: toolCallMatch?.[1] ?? null,
        }
      : null,
    lastTurnTail: last ? last.innerText.slice(-1200) : null,
  }
})()`

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'watch-session-'))
  try {
    // Compile the JavaScript later injected through CDP; outer-module syntax
    // checks cannot see malformed escaping inside this generated expression.
    new Function(SNAPSHOT('launch-syntax-fixture'))
    const runRoot = join(root, 'run')
    const workspace = join(root, 'workspace')
    const userDataDir = join(runRoot, 'user-data')
    mkdirSync(join(workspace, '.scry', 'records'), { recursive: true })
    mkdirSync(join(userDataDir, 'trace-archive-turns-v1', 'codex', 'cwd-fixture', 'sid-fixture'), { recursive: true })
    const state = {
      expectedWorkspace: workspace,
      userDataDir,
      launchId: 'launch-fixture',
      startedAt: '2026-08-08T00:00:00.000Z',
    }
    const prompts = [
      `/rate-workflow 85237895 ${CONTRACT.firstPromptSuffix}`,
      CONTRACT.secondPrompt,
      CONTRACT.thirdPrompt,
    ]
    if (!rendererTurnOverflow({ identity: true, turnCount: 4 }, 3)) {
      throw new Error('renderer fourth turn was not classified as an immediate overflow')
    }
    if (rendererTurnOverflow({ identity: false, turnCount: 4 }, 3)) {
      throw new Error('unowned renderer turn count was trusted')
    }
    const writeTurn = (turn, providerTurnId) => {
      const startedAt = `2026-08-08T00:0${turn}:00.000Z`
      const completedAt = `2026-08-08T00:0${turn}:30.000Z`
      writeFileSync(
        join(userDataDir, 'trace-archive-turns-v1', 'codex', 'cwd-fixture', 'sid-fixture', `turn-${turn}.json`),
        `${JSON.stringify({
          cwd: workspace,
          providerId: 'codex',
          sessionId: 'session-fixture',
          turns: [{ providerTurnId, status: 'completed', done: true, startedAt, completedAt, userText: prompts[turn - 1] }],
        })}\n`,
      )
      writeFileSync(
        join(workspace, '.scry', 'records', `record-${turn}.json`),
        `${JSON.stringify({
          workspace: { root: workspace },
          provider: { id: 'codex' },
          sessionId: 'session-fixture',
          providerTurnId,
          status: 'completed',
          startedAt,
          completedAt,
          turnIndex: turn,
          user: { value: { text: prompts[turn - 1] } },
        })}\n`,
      )
    }
    writeTurn(1, 'provider-turn-1')
    const first = persistedEvidence(runRoot, state, 'codex', prompts.slice(0, 1), null)
    if (first.state !== 'ready' || first.selected?.sessionId !== 'session-fixture') throw new Error('first completed turn was not selected')
    const foreignArchive = join(userDataDir, 'trace-archive-turns-v1', 'codex', 'cwd-fixture', 'sid-fixture', 'turn-foreign.json')
    writeFileSync(foreignArchive, `${JSON.stringify({
      cwd: workspace,
      providerId: 'codex',
      sessionId: 'foreign-session',
      turns: [{
        providerTurnId: 'foreign-provider-turn',
        status: 'completed',
        done: true,
        startedAt: '2026-08-08T00:01:00.000Z',
        completedAt: '2026-08-08T00:01:30.000Z',
        userText: prompts[0],
      }],
    })}\n`)
    if (persistedEvidence(runRoot, state, 'codex', prompts.slice(0, 1), null).state !== 'ambiguous') {
      throw new Error('a second post-launch session was not rejected as ambiguous')
    }
    rmSync(foreignArchive)
    const frozen = freezeSession(runRoot, state, 'codex', first.selected)
    if (frozen.sessionId !== 'session-fixture') throw new Error('session identity was not frozen')
    writeTurn(2, 'provider-turn-2')
    const second = persistedEvidence(runRoot, state, 'codex', prompts.slice(0, 2), frozen)
    if (second.state !== 'ready' || second.selected?.providerTurnIds.length !== 2) throw new Error('second turn did not converge')
    const secondRecord = join(workspace, '.scry', 'records', 'record-2.json')
    const drifted = readJson(secondRecord)
    drifted.providerTurnId = 'different-provider-turn'
    drifted.user = { value: { text: 'edited prompt' } }
    writeFileSync(secondRecord, `${JSON.stringify(drifted)}\n`)
    if (persistedEvidence(runRoot, state, 'codex', prompts.slice(0, 2), frozen).state !== 'failed') {
      throw new Error('terminal providerTurnId or prompt mismatch did not fail immediately')
    }
    writeTurn(3, 'provider-turn-3')
    if (persistedEvidence(runRoot, state, 'codex', prompts.slice(0, 2), frozen).state !== 'failed') {
      throw new Error('an extra completed turn did not fail immediately')
    }
    drifted.providerTurnId = 'provider-turn-2'
    drifted.user = { value: { text: prompts[1] } }
    writeFileSync(secondRecord, `${JSON.stringify(drifted)}\n`)
    const third = persistedEvidence(runRoot, state, 'codex', prompts, frozen)
    if (third.state !== 'ready' || third.selected?.providerTurnIds.length !== 3) {
      throw new Error('third turn did not converge')
    }
    // Both persistence projections must agree before the watcher opens the gate.
    const pendingRecord = readJson(secondRecord)
    pendingRecord.status = 'running'
    delete pendingRecord.completedAt
    writeFileSync(secondRecord, `${JSON.stringify(pendingRecord)}\n`)
    if (persistedEvidence(runRoot, state, 'codex', prompts, frozen).state === 'ready') {
      throw new Error('a completed archive side alone released the gate')
    }
    writeFileSync(secondRecord, `${JSON.stringify(drifted)}\n`)
    const firstQuestion = questionState(runRoot, state, 'qoder', 1, {
      head: 'fixture',
      links: [FIXED_DOCUMENT_URL],
      runId: 'run-fixture',
      toolCallId: 'tool-fixture',
    }, 'session-fixture')
    if (firstQuestion?.state !== 'WAITING_FOR_QODER_QUESTION' || firstQuestion.exitCode !== 3) {
      throw new Error('Qoder first-turn question did not enter structured waiting state')
    }
    const journal = readJson(join(runRoot, QUESTION_JOURNAL_FILE))
    if (
      journal.observationCount !== 1
      || journal.launchId !== state.launchId
      || journal.sessionId !== 'session-fixture'
      || journal.toolCallId !== 'tool-fixture'
      || !journal.questionFingerprint?.startsWith('sha256:')
    ) throw new Error('Qoder first question journal did not freeze its identity')
    const sameObservation = questionState(runRoot, state, 'qoder', 1, {
      head: 'fixture',
      links: [FIXED_DOCUMENT_URL],
      runId: 'run-fixture',
      toolCallId: 'tool-fixture',
    }, 'session-fixture')
    if (
      sameObservation?.state !== 'WAITING_FOR_QODER_QUESTION'
      || sameObservation.exitCode !== 3
      || sameObservation.idempotentObservation !== true
    ) throw new Error('the same Qoder tool call was mistaken for a second question')
    const answerRunRoot = join(root, 'answered-question-run')
    mkdirSync(answerRunRoot)
    writeFileSync(join(answerRunRoot, 'test-scry-state.json'), `${JSON.stringify(state)}\n`)
    const answerQuestion = questionState(answerRunRoot, state, 'qoder', 1, {
      head: 'fixture answer',
      links: [FIXED_DOCUMENT_URL],
      toolCallId: 'tool-answer',
    }, 'session-fixture')
    if (answerQuestion?.state !== 'WAITING_FOR_QODER_QUESTION') throw new Error('answer fixture did not wait')
    const answerEvidence = recordQoderAnswer(answerRunRoot, 'prefetched fixture body')
    const answeredJournal = readJson(join(answerRunRoot, QUESTION_JOURNAL_FILE))
    if (
      answerEvidence.state !== 'ANSWER_RECORDED'
      || answeredJournal.state !== 'ANSWER_RECORDED'
      || answeredJournal.answerEvidence.bytes !== Buffer.byteLength('prefetched fixture body')
      || !answeredJournal.answerEvidence.sha256.startsWith('sha256:')
    ) throw new Error('Qoder answer evidence did not record only byte count/hash')
    const awaitingAck = questionState(answerRunRoot, state, 'qoder', 1, {
      head: 'fixture answer',
      links: [FIXED_DOCUMENT_URL],
      toolCallId: 'tool-answer',
    }, 'session-fixture')
    if (awaitingAck?.state !== 'WAITING_FOR_QODER_ANSWER_ACK' || awaitingAck.continueWatching !== true) {
      throw new Error('an answered Qoder tool call did not wait idempotently for UI acknowledgement')
    }
    const repeated = questionState(runRoot, state, 'qoder', 1, {
      head: 'second question',
      links: [FIXED_DOCUMENT_URL],
      toolCallId: 'tool-second',
    }, 'session-fixture')
    if (repeated?.state !== 'SESSION_FAIL' || repeated.exitCode !== 5 || repeated.reason !== 'second_qoder_question') {
      throw new Error('a distinct second Qoder question did not become SESSION_FAIL')
    }
    if (readJson(join(runRoot, QUESTION_JOURNAL_FILE)).observationCount !== 3) {
      throw new Error('Qoder observations were not journaled')
    }
    writeFileSync(join(userDataDir, 'app-sessions.json'), `${JSON.stringify([{
      cwd: workspace,
      providerId: 'qoder',
      preview: '/rate-native-rate-workflow 85237895',
      runId: 'run-indexed',
      sessionId: 'session-indexed',
    }])}\n`)
    if (questionSessionId(null, { candidates: [] }, state, 'qoder', '/rate-native-rate-workflow 85237895', { runId: 'run-indexed' }) !== 'session-indexed') {
      throw new Error('active Qoder session was not recovered from the exact app session index entry')
    }
    const invalidRunRoot = join(root, 'invalid-question-run')
    mkdirSync(invalidRunRoot)
    const invalidUrl = questionState(invalidRunRoot, state, 'qoder', 1, {
      head: 'other document',
      links: [`${FIXED_DOCUMENT_URL}?drift=1`],
    }, null)
    if (invalidUrl?.state !== 'SESSION_FAIL' || invalidUrl.reason !== 'qoder_document_url_mismatch') {
      throw new Error('Qoder question without one exact structured document link was accepted')
    }
    const fingerprintOnlyRunRoot = join(root, 'fingerprint-only-question-run')
    mkdirSync(fingerprintOnlyRunRoot)
    const fingerprintOnly = questionState(fingerprintOnlyRunRoot, state, 'qoder', 1, {
      head: 'fixture without a DOM tool id',
      links: [FIXED_DOCUMENT_URL],
    }, null)
    const fingerprintOnlyJournal = readJson(join(fingerprintOnlyRunRoot, QUESTION_JOURNAL_FILE))
    if (
      fingerprintOnly?.state !== 'WAITING_FOR_QODER_QUESTION'
      || fingerprintOnlyJournal.toolCallId !== null
      || !fingerprintOnlyJournal.questionFingerprint?.startsWith('sha256:')
    ) throw new Error('Qoder question without a DOM id did not retain a stable fingerprint fallback')
    if (questionState(invalidRunRoot, state, 'codex', 1, { head: 'fixture' }, null)?.state !== 'SESSION_FAIL') {
      throw new Error('non-Qoder question was generalized into the Qoder waiting branch')
    }
    const secondTurnRunRoot = join(root, 'second-turn-question-run')
    mkdirSync(secondTurnRunRoot)
    if (questionState(secondTurnRunRoot, state, 'qoder', 2, { links: [FIXED_DOCUMENT_URL] }, 'session-fixture')?.state !== 'SESSION_FAIL') {
      throw new Error('Qoder second-turn question was accepted')
    }

    const leaseQuestion = {
      head: 'Provider 需要你的选择',
      legends: ['01\nLEASE 冲突\nREQ-85237895 已被另一个会话占用活动 generation。是否在当前会话继续该需求？这会放弃旧代并从 P0 重跑。'],
      options: ['是，继续\n放弃旧代并从 P0 重新摄入', '否\n保留旧代不动', '其他\n输入其他回答'],
      links: [],
      runId: 'run-lease-fixture',
      toolCallId: 'tool-lease-fixture',
    }
    for (const provider of Object.keys(CONTRACT.providers)) {
      const leaseRunRoot = join(root, `lease-${provider.replace(/[^a-z0-9_-]/gi, '-')}`)
      mkdirSync(leaseRunRoot)
      const waiting = questionState(
        leaseRunRoot,
        state,
        provider,
        1,
        leaseQuestion,
        'session-lease-fixture',
        '85237895',
      )
      if (
        waiting?.state !== 'WAITING_FOR_LEASE_HANDOVER'
        || waiting.exitCode !== 3
        || waiting.authorized !== false
        || waiting.autoAnswered !== false
      ) throw new Error(`${provider} lease handover question was not classified as waiting`)
    }
    const nativeQoderLeaseQuestion = {
      legends: ['01\n重开需求\n是否在当前会话放弃旧 generation，并从 P0 重新执行需求 85237895？'],
      options: [
        '放弃旧代并继续（推荐）\n释放旧 lease，在当前会话重新摄入并完成需求理解后停下。',
        '暂不继续\n保留旧 generation，本次停止执行。',
        '其他\n输入其他回答',
      ],
      links: [],
      runId: 'run-native-qoder-lease',
      toolCallId: 'tool-native-qoder-lease',
    }
    const nativeQoderLeaseRunRoot = join(root, 'lease-qoder-native')
    mkdirSync(nativeQoderLeaseRunRoot)
    const nativeQoderLease = questionState(
      nativeQoderLeaseRunRoot, state, 'qoder', 1, nativeQoderLeaseQuestion, 'session-native-qoder-lease', '85237895'
    )
    if (nativeQoderLease?.state !== 'WAITING_FOR_LEASE_HANDOVER') {
      throw new Error('native Qoder lease question was misclassified as a document question')
    }
    const currentQoderLeaseQuestion = {
      legends: ['01\n会话接管\n是否放弃旧 generation，并在当前会话从 P0 重新运行需求 85237895？'],
      options: [
        '放弃旧代并重跑（推荐）\n旧 generation 尚停在 P0 且无已完成阶段；当前会话从 P0 重新摄入。',
        '保留旧代并停止\n当前会话不继续处理该需求。',
        '其他\n输入其他回答',
      ],
      links: [],
      runId: 'run-current-qoder-lease',
      toolCallId: 'tool-current-qoder-lease',
    }
    const currentQoderLeaseRunRoot = join(root, 'lease-qoder-current')
    mkdirSync(currentQoderLeaseRunRoot)
    const currentQoderLease = questionState(
      currentQoderLeaseRunRoot, state, 'qoder', 1, currentQoderLeaseQuestion, 'session-current-qoder-lease', '85237895'
    )
    if (currentQoderLease?.state !== 'WAITING_FOR_LEASE_HANDOVER') {
      throw new Error('current Qoder lease question was misclassified as a document question')
    }
    const conciseQoderLeaseQuestion = {
      legends: ['01\n接管需求\n是否在当前会话继续需求 85237895？'],
      options: [
        '当前会话继续（推荐）\n放弃旧 generation，在当前会话从 P0 重新摄入并理解 PRD。',
        '保留旧会话\n当前会话停止，不接管该需求。',
        '其他\n输入其他回答',
      ],
      links: [],
      runId: 'run-concise-qoder-lease',
      toolCallId: 'tool-concise-qoder-lease',
    }
    const conciseQoderLeaseRunRoot = join(root, 'lease-qoder-concise')
    mkdirSync(conciseQoderLeaseRunRoot)
    const conciseQoderLease = questionState(
      conciseQoderLeaseRunRoot, state, 'qoder', 1, conciseQoderLeaseQuestion, 'session-concise-qoder-lease', '85237895'
    )
    if (conciseQoderLease?.state !== 'WAITING_FOR_LEASE_HANDOVER') {
      throw new Error('concise Qoder lease question was misclassified as a document question')
    }
    const linklessLeaseQuestion = {
      legends: ['01\n旧代处理\nREQ-85237895 已被另一个已失联会话占用（旧代停在 P0）。是否在当前会话继续该需求？这会放弃旧代、从 P0 重跑。'],
      options: [
        '是，放弃旧代重跑\n释放该 orphaned lease，在当前会话新建 generation 并从 P0 重新摄入。',
        '否，先不动\n保留旧代 lease，本轮不启动工作流。',
        '其他\n输入其他回答',
      ],
      links: [],
      runId: 'run-linkless-lease',
      toolCallId: 'tool-linkless-lease',
    }
    const linklessLeaseRunRoot = join(root, 'lease-qoder-linkless')
    mkdirSync(linklessLeaseRunRoot)
    const linklessLease = questionState(
      linklessLeaseRunRoot, state, 'qoder', 1, linklessLeaseQuestion, 'session-linkless-lease', '85237895'
    )
    if (linklessLease?.state !== 'WAITING_FOR_LEASE_HANDOVER') {
      throw new Error('linkless Qoder orphaned lease question was misclassified as a document question')
    }
    const recoveredLeaseRunRoot = join(root, 'lease-qoder-misclassified')
    mkdirSync(recoveredLeaseRunRoot)
    const misclassifiedObservation = questionObservation(state, linklessLeaseQuestion, 'session-linkless-lease')
    writeJsonAtomic(join(recoveredLeaseRunRoot, QUESTION_JOURNAL_FILE), {
      schemaVersion: 1,
      state: 'SESSION_FAIL',
      failureReason: 'qoder_document_url_mismatch',
      questionFingerprint: misclassifiedObservation.questionFingerprint,
      observedLinks: [],
      distinctQuestionCount: 1,
    })
    const recoveredLease = questionState(
      recoveredLeaseRunRoot, state, 'qoder', 1, linklessLeaseQuestion, 'session-linkless-lease', '85237895'
    )
    if (recoveredLease?.state !== 'WAITING_FOR_LEASE_HANDOVER') {
      throw new Error('recoverable Qoder lease misclassification did not enter the handover path')
    }

    const authorizationRunRoot = join(root, 'lease-authorization')
    mkdirSync(authorizationRunRoot)
    writeFileSync(join(authorizationRunRoot, 'test-scry-state.json'), `${JSON.stringify(state)}\n`)
    writeFileSync(join(authorizationRunRoot, 'turn1-send.json'), `${JSON.stringify({
      provider: 'opencode',
      turn: 1,
      workitemId: '85237895',
      text: `/rate-workflow 85237895 ${CONTRACT.firstPromptSuffix}`,
    })}\n`)
    const authorizationWaiting = questionState(
      authorizationRunRoot,
      state,
      'opencode',
      1,
      leaseQuestion,
      'session-lease-fixture',
      '85237895',
    )
    if (authorizationWaiting?.state !== 'WAITING_FOR_LEASE_HANDOVER') {
      throw new Error('lease authorization fixture did not enter waiting state')
    }
    if (pendingLeaseHandoverState(authorizationRunRoot, state, 'opencode', '85237895')?.state !== 'WAITING_FOR_LEASE_HANDOVER') {
      throw new Error('missing lease authorization did not keep the gate closed after the question disappeared')
    }
    let unsafeOwnerAccepted = false
    try {
      recordLeaseHandoverAuthorization(authorizationRunRoot, {
        decision: 'continue',
        impactAcknowledged: true,
        userQuote: '全部重跑',
        oldGenerationStatus: { active: true },
      })
      unsafeOwnerAccepted = true
    } catch {
      // Expected: arbitrary/active status is not inactivity proof.
    }
    if (unsafeOwnerAccepted) throw new Error('active old owner was accepted for lease handover')
    const authorized = recordLeaseHandoverAuthorization(authorizationRunRoot, {
      decision: 'continue',
      impactAcknowledged: true,
      userQuote: '全部重跑',
      oldGenerationStatus: {
        status: {
          task_id: 'REQ-85237895',
          lifecycle_status: 'active',
          delivery_complete: false,
        },
        doctor: {
          target_task: 'REQ-85237895',
          runtime_session: 'new-session',
          prompt_receipts: 1,
          turn: { state: 'open', opened_ms: 200 },
          parallel_active_leases: [{
            task_id: 'REQ-85237895',
            task_generation: 'REQ-85237895@generation',
            owner_session_id: 'old-session',
            owner: { session_id: 'old-session', last_activity_ms: 199 },
          }],
        },
      },
    })
    if (authorized.state !== 'AUTHORIZED') throw new Error('lease authorization was not recorded')
    if (pendingLeaseHandoverState(authorizationRunRoot, state, 'opencode', '85237895') !== null) {
      throw new Error('valid lease authorization did not open the post-question progress gate')
    }
    const visibleAfterAuthorization = questionState(
      authorizationRunRoot,
      state,
      'opencode',
      1,
      leaseQuestion,
      'session-lease-fixture',
      '85237895',
    )
    if (visibleAfterAuthorization?.state !== 'WAITING_FOR_LEASE_HANDOVER' || visibleAfterAuthorization.authorized !== true) {
      throw new Error('authorized lease question was auto-answered or lost its authorization state')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  process.stdout.write('self-test: PASS\n')
}

async function main() {
  if (process.argv[2] === 'self-test') {
    if (process.argv.length !== 3) throw new Error('self-test does not accept options')
    selfTest()
    return
  }
  if (process.argv[2] === 'record-qoder-answer') {
    const options = parseOptions(process.argv.slice(3))
    if ([...options.keys()].some((key) => key !== 'run-root') || !options.get('run-root')) {
      throw new Error('usage: watch_session.mjs record-qoder-answer --run-root DIR < answer.txt')
    }
    const result = recordQoderAnswer(options.get('run-root'), readFileSync(0, 'utf8'))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (process.argv[2] === 'record-lease-handover-authorization') {
    const options = parseOptions(process.argv.slice(3))
    if ([...options.keys()].some((key) => key !== 'run-root') || !options.get('run-root')) {
      throw new Error('usage: watch_session.mjs record-lease-handover-authorization --run-root DIR < authorization.json')
    }
    let input
    try {
      input = JSON.parse(readFileSync(0, 'utf8'))
    } catch (error) {
      throw new Error(`lease handover authorization stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const result = recordLeaseHandoverAuthorization(options.get('run-root'), input)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const options = parseOptions(process.argv.slice(2))
  const allowed = new Set(['run-root', 'interval', 'max-minutes', 'until-idle', 'expect-turns'])
  if ([...options.keys()].some((key) => !allowed.has(key))) throw new Error('unsupported watcher option')
  const runRoot = options.get('run-root')
  if (!runRoot) throw new Error('missing --run-root')
  const intervalMs = Number(options.get('interval') ?? 15_000)
  const maxMinutes = Number(options.get('max-minutes') ?? 180)
  const untilIdle = options.get('until-idle') === 'true'
  const expectedTurns = Number(options.get('expect-turns') ?? 1)
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error('--interval must be at least 250ms')
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be positive')
  if (!Number.isInteger(expectedTurns) || expectedTurns < 1 || expectedTurns > 3) throw new Error('--expect-turns must be 1, 2 or 3')

  const state = readJson(join(runRoot, 'test-scry-state.json'))
  const send = loadSendEvidence(runRoot, expectedTurns)
  const provider = send.provider
  const frozen = loadFrozenSession(runRoot, state, provider)
  if (expectedTurns > 1 && !frozen) throw new Error(`turn 1 did not freeze ${SESSION_FILE}`)
  const ownership = await waitForRendererOwnership({
    port: state.port,
    expectedUrl: state.expectedRendererUrl,
    expectedBrowserPath: state.expectedBrowserPath,
    launchId: state.launchId,
    expectedTargetId: state.rendererOwnership?.actual?.targetId,
    timeoutMs: 5_000,
  })
  if (ownership.evidence.status !== 'verified' || !ownership.target) {
    throw new Error(`ownership ${ownership.evidence.status}: ${JSON.stringify(ownership.evidence)}`)
  }
  const logPath = join(runRoot, 'turn-watch.jsonl')
  const deadline = Date.now() + maxMinutes * 60_000
  while (Date.now() < deadline) {
    const renderer = await evaluateCdp(ownership.target, SNAPSHOT(state.launchId), {
      phase: 'watch_snapshot',
      timeoutMs: 20_000,
    })
    const persistence = persistedEvidence(runRoot, state, provider, send.prompts, frozen)
    const uiReady = renderer.identity === true && renderer.busy === false && renderer.turnCount === expectedTurns
    const observation = {
      schemaVersion: 2,
      state: 'WATCHING',
      at: new Date().toISOString(),
      provider,
      workspace: state.expectedWorkspace,
      expectedTurns,
      frozenSessionId: frozen?.sessionId ?? null,
      uiReady,
      renderer,
      persistence,
    }

    if (rendererTurnOverflow(renderer, expectedTurns)) {
      const failed = { ...observation, state: 'SESSION_FAIL', reason: 'renderer_turn_count_exceeded' }
      const line = `${JSON.stringify(failed)}\n`
      appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
      process.stdout.write(line)
      process.exitCode = 5
      return
    }

    const question = questionState(
      runRoot,
      state,
      provider,
      expectedTurns,
      renderer.question,
      questionSessionId(frozen, persistence, state, provider, send.prompts[0], renderer.question),
      send.workitemId,
    )
    if (question) {
      const waiting = { ...observation, ...question }
      const line = `${JSON.stringify(waiting)}\n`
      appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
      process.stdout.write(line)
      if (question.continueWatching === true) {
        if (!untilIdle) return
        await new Promise((done) => setTimeout(done, intervalMs))
        continue
      }
      process.exitCode = question.exitCode
      return
    }
    const leaseGate = pendingLeaseHandoverState(runRoot, state, provider, send.workitemId)
    if (leaseGate) {
      const waiting = { ...observation, ...leaseGate }
      const line = `${JSON.stringify(waiting)}\n`
      appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
      process.stdout.write(line)
      process.exitCode = leaseGate.exitCode
      return
    }
    if (persistence.state === 'ambiguous' || persistence.state === 'session_drift') {
      const failed = { ...observation, state: persistence.state === 'ambiguous' ? 'AMBIGUOUS_SESSION' : 'SESSION_DRIFT' }
      const line = `${JSON.stringify(failed)}\n`
      appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
      process.stdout.write(line)
      process.exitCode = 5
      return
    }
    if (persistence.state === 'failed') {
      const failed = { ...observation, state: 'SESSION_FAIL', reason: 'irrecoverable_persistence_mismatch' }
      const line = `${JSON.stringify(failed)}\n`
      appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
      process.stdout.write(line)
      process.exitCode = 5
      return
    }
    if (untilIdle && uiReady && persistence.state === 'ready' && persistence.selected) {
      if (provider === 'qoder' && expectedTurns === 1 && existsSync(join(runRoot, QUESTION_JOURNAL_FILE))) {
        const journal = readQuestionJournal(join(runRoot, QUESTION_JOURNAL_FILE), runRoot, state.launchId)
        if (!journal.valid || journal.value.state !== 'ANSWER_RECORDED' || !journal.value.answerEvidence) {
          const failed = {
            ...observation,
            state: 'SESSION_FAIL',
            reason: 'qoder_answer_evidence_missing',
            questionJournalPath: join(runRoot, QUESTION_JOURNAL_FILE),
          }
          const line = `${JSON.stringify(failed)}\n`
          appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
          process.stdout.write(line)
          process.exitCode = 5
          return
        }
      }
      const session = freezeSession(runRoot, state, provider, persistence.selected)
      const completed = {
        ...observation,
        state: 'COMPLETED',
        sessionId: session.sessionId,
        providerTurnIds: persistence.selected.providerTurnIds,
      }
      const line = `${JSON.stringify(completed)}\n`
      appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
      process.stdout.write(line)
      return
    }

    const line = `${JSON.stringify(observation)}\n`
    appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 })
    process.stdout.write(line)
    if (!untilIdle) return
    await new Promise((done) => setTimeout(done, intervalMs))
  }
  const timeout = {
    schemaVersion: 2,
    state: 'TIMEOUT',
    provider,
    workspace: state.expectedWorkspace,
    expectedTurns,
    frozenSessionId: frozen?.sessionId ?? null,
    at: new Date().toISOString(),
  }
  const line = `${JSON.stringify(timeout)}\n`
  appendFileSync(join(runRoot, 'turn-watch.jsonl'), line, { encoding: 'utf8', mode: 0o600 })
  process.stdout.write(line)
  process.exitCode = 4
}

await main()
