#!/usr/bin/env node
// Send one contract-fixed prompt into the single owned "Scry Test" renderer.
//
// The prompt text is built from contract.json, never from the caller, so the
// three user texts cannot drift. Identity is bound through the launcher state: the
// dedicated CDP port, the owned browser path, the owned renderer target and this
// run's launchId marker. Every precondition that a real run has broken before is
// checked first: renderer identity, an idle (not busy) session, the exact turn
// count for this round, the full_access permission still selected, and an exact
// readback of the typed text before the send button is clicked.
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CdpEvaluationError, evaluateCdp, waitForRendererOwnership } from './cdp_ownership.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CONTRACT = JSON.parse(readFileSync(join(SCRIPT_DIR, '..', 'references', 'contract.json'), 'utf8'))
const RUN_PREFIX = 'validate-scry-rate-workflow-'
const RUN_ROOT_PARENT = realpathSync(resolve(CONTRACT.retention.runRootParent))
const START_DEADLINE_MS = 60_000
const EVALUATE_TIMEOUT_MS = 20_000
const FIXED_WORKSPACE_SCRIPT = join(SCRIPT_DIR, 'fixed_workspace.py')

function expectedAgentProfileId(provider) {
  return CONTRACT.providers[provider]?.agentProfileId ?? null
}

function expectedSelectedAgentId(provider) {
  return expectedAgentProfileId(provider) ?? provider
}

function expectedPermissionLabel(provider) {
  return CONTRACT.providers[provider]?.permissionLabel ?? CONTRACT.permission.label
}

export function promptText(provider, turn, workitemId, localEqualityOnly = false) {
  const descriptor = CONTRACT.providers[provider]
  if (!descriptor) throw new Error(`unsupported provider: ${provider}`)
  if (turn === 2) return CONTRACT.secondPrompt
  if (turn === 3) return CONTRACT.thirdPrompt
  if (turn !== 1) throw new Error(`turn must be 1, 2 or 3, got ${turn}`)
  if (!/^[0-9]+$/.test(String(workitemId ?? ''))) throw new Error(`turn 1 needs a plain numeric workitem id, got ${workitemId}`)
  if (String(workitemId) === CONTRACT.sourceWorkitem.id && !localEqualityOnly) {
    throw new Error('turn 1 must use the cloned workitem id unless --local-equality-only true was explicit')
  }
  if (String(workitemId) !== CONTRACT.sourceWorkitem.id && localEqualityOnly) {
    throw new Error('--local-equality-only must use the fixed source workitem id')
  }
  return `${descriptor.command} ${workitemId} ${CONTRACT.firstPromptSuffix}`
}

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

function safeRunRoot(raw) {
  const path = realpathSync(resolve(raw))
  if (!basename(path).startsWith(RUN_PREFIX) || realpathSync(dirname(path)) !== RUN_ROOT_PARENT) {
    throw new Error(`run root must be ${RUN_ROOT_PARENT}/${RUN_PREFIX}*`)
  }
  return path
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function prepareIntentUnderLifecycleGate(runRoot, provider, turn, intent) {
  const completed = spawnSync(
    process.env.PYTHON3 || 'python3',
    [
      FIXED_WORKSPACE_SCRIPT,
      'prepare-send-intent',
      '--provider', provider,
      '--run-root', runRoot,
      '--turn', String(turn),
    ],
    {
      input: JSON.stringify(intent),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  )
  if (completed.error) throw new Error(`send intent gate failed: ${completed.error.message}`)
  let evidence = null
  try {
    evidence = JSON.parse(completed.stdout)
  } catch {
    // The structured error below includes bounded stderr/stdout without prompt text.
  }
  if (completed.status !== 0 || evidence?.ok !== true) {
    const detail = evidence?.error || completed.stderr.trim() || 'invalid helper output'
    throw new Error(`send intent gate rejected turn ${turn}: ${detail}`)
  }
  return evidence
}

function prepareDraftUnderLifecycleGate(runRoot, provider, draft) {
  const completed = spawnSync(
    process.env.PYTHON3 || 'python3',
    [
      FIXED_WORKSPACE_SCRIPT,
      'record-draft',
      '--provider', provider,
      '--run-root', runRoot,
    ],
    {
      input: JSON.stringify(draft),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  )
  if (completed.error) throw new Error(`draft gate failed: ${completed.error.message}`)
  let evidence = null
  try {
    evidence = JSON.parse(completed.stdout)
  } catch {
    // The structured error below includes bounded stderr/stdout without prompt text.
  }
  if (completed.status !== 0 || evidence?.ok !== true) {
    const detail = evidence?.error || completed.stderr.trim() || 'invalid helper output'
    throw new Error(`draft gate rejected turn 1: ${detail}`)
  }
  return evidence
}

async function ownedTarget(state) {
  const ownership = await waitForRendererOwnership({
    port: state.port,
    expectedUrl: state.expectedRendererUrl,
    expectedBrowserPath: state.expectedBrowserPath,
    launchId: state.launchId,
    expectedTargetId: state.rendererOwnership?.actual?.targetId,
    timeoutMs: 5_000,
  })
  if (ownership.evidence.status !== 'verified' || !ownership.target) {
    throw new Error(`expected one verified owned Scry Test renderer, got ${ownership.evidence.status}: ${JSON.stringify(ownership.evidence)}`)
  }
  return ownership.target
}

const composerState = (launchId, agentProfileId = null) => `(() => {
  const launchId = ${JSON.stringify(launchId)}
  const expectedAgentProfileId = ${JSON.stringify(agentProfileId)}
  const input = document.querySelector('.composer textarea')
  const send = document.querySelector('button.send')
  const permission = document.querySelector('select[aria-label="权限"]')
  const provider = document.querySelector('.clibtn')
  return {
    identity: document.documentElement.dataset.scryTestApp === 'true'
      && document.documentElement.dataset.scryTestLaunchId === launchId,
    title: document.title,
    turnCount: document.querySelectorAll('.turn').length,
    inputValue: input instanceof HTMLTextAreaElement ? input.value : null,
    sendDisabled: send instanceof HTMLButtonElement ? send.disabled : null,
    sendLabel: document.querySelector('.send-label')?.textContent?.trim() ?? null,
    slashOpen: Boolean(document.querySelector('.slash')),
    busy: Boolean(document.querySelector('button.stop')),
    permissionValue: permission instanceof HTMLSelectElement ? permission.value : null,
    permissionLabel: permission instanceof HTMLSelectElement
      ? permission.selectedOptions[0]?.textContent?.trim() ?? null
      : null,
    providerLabel: provider ? provider.textContent.trim() : null,
    selectedAgentId: provider instanceof HTMLButtonElement ? provider.dataset.agentId ?? null : null,
    agentProfileId: expectedAgentProfileId !== null && provider instanceof HTMLButtonElement
      ? provider.dataset.agentId ?? null
      : null,
    composerError: document.querySelector('.composer-error')?.textContent?.trim() ?? null,
  }
})()`

function cdpFailure(error) {
  if (error instanceof CdpEvaluationError) {
    return {
      name: error.name,
      code: error.code,
      phase: error.phase,
      kind: error.kind,
      targetId: error.targetId,
      elapsedMs: error.elapsedMs,
      message: error.message,
    }
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    phase: typeof error?.phase === 'string' ? error.phase : null,
    kind: typeof error?.kind === 'string' ? error.kind : 'unknown',
    targetId: typeof error?.targetId === 'string' ? error.targetId : null,
    elapsedMs: typeof error?.elapsedMs === 'number' ? error.elapsedMs : null,
    message: error instanceof Error ? error.message : String(error),
  }
}

async function typeContractText(target, text, evaluate = evaluateCdp) {
  return await evaluate(target, `(async () => {
    const text = ${JSON.stringify(text)}
    const input = document.querySelector('.composer textarea')
    if (!(input instanceof HTMLTextAreaElement)) return { ok: false, reason: 'composer_missing' }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((done) => setTimeout(done, 400))
    // A leading slash opens the command menu, where Enter would pick a command
    // instead of sending. Dismiss it and click the send button explicitly.
    if (document.querySelector('.slash')) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((done) => setTimeout(done, 200))
    }
    return { ok: input.value === text, value: input.value, slashOpen: Boolean(document.querySelector('.slash')) }
  })()`, { phase: 'type', timeoutMs: EVALUATE_TIMEOUT_MS })
}

function exactComposerText(snapshot, text) {
  return snapshot?.inputValue === text && snapshot?.slashOpen === false
}

export async function ensureContractText({ target, state, before, text }, dependencies = {}) {
  const evaluate = dependencies.evaluate ?? evaluateCdp
  const reacquireTarget = dependencies.ownedTarget ?? ownedTarget
  if (exactComposerText(before, text)) {
    return {
      ok: true,
      value: text,
      slashOpen: false,
      reused: true,
      recoveredAfterTimeout: false,
      readback: before,
    }
  }
  try {
    const typed = await typeContractText(target, text, evaluate)
    if (!typed?.ok || typed.value !== text || typed.slashOpen) {
      throw new Error(`typing failed: ${JSON.stringify(typed)}`)
    }
    return { ...typed, reused: false, recoveredAfterTimeout: false }
  } catch (error) {
    if (!(error instanceof CdpEvaluationError) || error.kind !== 'timeout') throw error
    const liveTarget = await reacquireTarget(state)
    const readback = await evaluate(liveTarget, composerState(state.launchId), {
      phase: 'type_reconcile',
      timeoutMs: EVALUATE_TIMEOUT_MS,
    })
    if (!exactComposerText(readback, text)) throw error
    return {
      ok: true,
      value: text,
      slashOpen: false,
      reused: false,
      recoveredAfterTimeout: true,
      timeout: cdpFailure(error),
      readback,
    }
  }
}

async function preconditions(runRoot, provider, turn, text, dependencies = {}) {
  const evaluate = dependencies.evaluate ?? evaluateCdp
  const acquireTarget = dependencies.ownedTarget ?? ownedTarget
  const state = JSON.parse(readFileSync(join(runRoot, 'test-scry-state.json'), 'utf8'))
  const target = await acquireTarget(state)
  const before = await evaluate(target, composerState(state.launchId, expectedAgentProfileId(provider)), {
    phase: 'preconditions',
    timeoutMs: EVALUATE_TIMEOUT_MS,
  })
  assertComposerPreconditions(before, provider, turn, text)
  return { state, target, before }
}

function assertComposerPreconditions(before, provider, turn, text) {
  const expectedLabel = CONTRACT.providers[provider].displayName
  const selectedAgentId = expectedSelectedAgentId(provider)
  if (!before.identity) throw new Error(`renderer identity mismatch: ${JSON.stringify(before)}`)
  if (before.providerLabel !== expectedLabel) throw new Error(`provider drifted: expected ${expectedLabel}, got ${JSON.stringify(before.providerLabel)}`)
  if (before.selectedAgentId !== selectedAgentId) {
    throw new Error(`agent profile drifted: expected ${selectedAgentId}, got ${JSON.stringify(before.selectedAgentId)}`)
  }
  if (before.agentProfileId !== expectedAgentProfileId(provider)) {
    throw new Error(`normalized agent profile drifted: expected ${JSON.stringify(expectedAgentProfileId(provider))}, got ${JSON.stringify(before.agentProfileId)}`)
  }
  if (before.permissionValue !== CONTRACT.permission.value || before.permissionLabel !== expectedPermissionLabel(provider)) {
    throw new Error(`permission drifted: ${JSON.stringify(before)}`)
  }
  if (before.busy) throw new Error(`session is still running; wait for the previous turn to finish: ${JSON.stringify(before)}`)
  if (before.turnCount !== turn - 1) throw new Error(`expected ${turn - 1} finished turns before turn ${turn}, found ${before.turnCount}`)
  // A retry after a transport timeout finds the exact draft already typed; any
  // other leftover text would silently change the contract-fixed user text.
  if (before.inputValue !== '' && before.inputValue !== text) {
    throw new Error(`composer holds unexpected draft text: ${JSON.stringify(before.inputValue)}`)
  }
}

function newSendAttempt(runRoot, provider, turn, text) {
  const path = join(runRoot, `turn${turn}-send-attempt.json`)
  let attemptNumber = 1
  if (existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8'))
      if (previous?.runRoot === runRoot && previous?.provider === provider && previous?.turn === turn) {
        attemptNumber = Number(previous.attemptNumber ?? 0) + 1
      }
    } catch {
      // A malformed prior diagnostic must not be trusted or merged.
    }
  }
  return {
    path,
    value: {
      schemaVersion: 1,
      runRoot,
      provider,
      agentProfileId: expectedAgentProfileId(provider),
      turn,
      text,
      attemptNumber,
      stage: 'CREATED',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [],
    },
  }
}

function recordAttempt(attempt, stage, detail = {}) {
  const at = new Date().toISOString()
  attempt.value.stage = stage
  attempt.value.updatedAt = at
  attempt.value.history.push({ stage, at, ...detail })
  writeJsonAtomic(attempt.path, attempt.value)
}

async function waitForTurnStart({ state, target, expectedTurnCount }, dependencies = {}) {
  const evaluate = dependencies.evaluate ?? evaluateCdp
  const acquireTarget = dependencies.ownedTarget ?? ownedTarget
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
  const deadline = now() + (dependencies.deadlineMs ?? START_DEADLINE_MS)
  const pollMs = dependencies.pollMs ?? 200
  let currentTarget = target
  let last = null
  let transientFailure = null
  while (now() < deadline) {
    try {
      last = await evaluate(currentTarget, composerState(state.launchId), {
        phase: 'start_reconcile',
        timeoutMs: Math.min(EVALUATE_TIMEOUT_MS, Math.max(1, deadline - now())),
      })
      transientFailure = null
    } catch (error) {
      transientFailure = cdpFailure(error)
      if (!(error instanceof CdpEvaluationError)) throw error
      currentTarget = await acquireTarget(state)
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
      continue
    }
    if (last?.composerError) return { ok: false, reason: 'composer_error', error: last.composerError, snapshot: last }
    if (last?.turnCount > expectedTurnCount + 1) {
      return { ok: false, reason: 'unexpected_extra_turn', snapshot: last }
    }
    if (last?.busy === true || last?.turnCount === expectedTurnCount + 1) {
      return { ok: true, snapshot: last }
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
  }
  return { ok: false, reason: 'turn_did_not_start', snapshot: last, transientFailure }
}

export async function startTurnOnce({
  state,
  target,
  text,
  expectedTurnCount,
  selectedAgentId = null,
  permissionLabel = null,
}, dependencies = {}) {
  const evaluate = dependencies.evaluate ?? evaluateCdp
  const onStage = dependencies.onStage ?? (() => {})
  let click = null
  let clickFailure = null
  try {
    click = await evaluate(target, `(() => {
      const text = ${JSON.stringify(text)}
      const expectedTurnCount = ${expectedTurnCount}
      const expectedSelectedAgentId = ${JSON.stringify(selectedAgentId)}
      const expectedPermissionLabel = ${JSON.stringify(permissionLabel)}
      const input = document.querySelector('.composer textarea')
      const send = document.querySelector('button.send')
      const provider = document.querySelector('.clibtn')
      const permission = document.querySelector('select[aria-label="权限"]')
      const actualTurnCount = document.querySelectorAll('.turn').length
      if (!(input instanceof HTMLTextAreaElement)) return { ok: false, reason: 'composer_missing' }
      if (input.value !== text) return { ok: false, reason: 'composer_text_drifted', value: input.value }
      if (document.querySelector('.slash')) return { ok: false, reason: 'slash_open' }
      if (actualTurnCount !== expectedTurnCount) return { ok: false, reason: 'turn_count_drifted', actualTurnCount }
      if (expectedSelectedAgentId !== null && provider?.dataset.agentId !== expectedSelectedAgentId) {
        return { ok: false, reason: 'agent_profile_drifted', selectedAgentId: provider?.dataset.agentId ?? null }
      }
      if (expectedPermissionLabel !== null && (
        !(permission instanceof HTMLSelectElement)
        || permission.value !== ${JSON.stringify(CONTRACT.permission.value)}
        || permission.selectedOptions[0]?.textContent?.trim() !== expectedPermissionLabel
      )) return { ok: false, reason: 'permission_drifted' }
      if (!(send instanceof HTMLButtonElement) || send.disabled) return { ok: false, reason: 'send_unavailable' }
      send.click()
      return {
        ok: true,
        beforeTurnCount: actualTurnCount,
        selectedAgentId: provider?.dataset.agentId ?? null,
        permissionLabel: permission instanceof HTMLSelectElement
          ? permission.selectedOptions[0]?.textContent?.trim() ?? null
          : null
      }
    })()`, { phase: 'click', timeoutMs: EVALUATE_TIMEOUT_MS })
    if (!click?.ok) {
      onStage('CLICK_REJECTED', { click })
      throw new Error(`send failed: ${JSON.stringify(click)}`)
    }
    onStage('CLICK_DISPATCHED', { click })
  } catch (error) {
    if (!(error instanceof CdpEvaluationError)) throw error
    // The click is non-idempotent. Once CDP has accepted the expression, any
    // transport outcome is ambiguous, so never click a second time here.
    clickFailure = cdpFailure(error)
    onStage('CLICK_UNCONFIRMED', { error: clickFailure })
  }
  const started = await waitForTurnStart(
    { state, target, expectedTurnCount },
    dependencies,
  )
  if (!started.ok) {
    const error = new Error(`send start confirmation failed: ${JSON.stringify(started)}`)
    error.startEvidence = started
    error.clickFailure = clickFailure
    throw error
  }
  return {
    ...started,
    click,
    clickRecoveredAfterFailure: clickFailure !== null,
    clickFailure,
  }
}

async function send(runRoot, provider, turn, workitemId, localEqualityOnly, dependencies = {}) {
  const text = promptText(provider, turn, workitemId, localEqualityOnly)
  const attempt = newSendAttempt(runRoot, provider, turn, text)
  recordAttempt(attempt, 'CREATED')
  try {
    const { state, target, before } = await preconditions(runRoot, provider, turn, text, dependencies)
    recordAttempt(attempt, 'PRECONDITIONS_READ', {
      targetId: target.id ?? null,
      turnCount: before.turnCount,
      inputMatches: before.inputValue === text,
      slashOpen: before.slashOpen,
      selectedAgentId: before.selectedAgentId,
      agentProfileId: before.agentProfileId,
      permissionLabel: before.permissionLabel,
    })
    const typed = await ensureContractText({ state, target, before, text }, dependencies)
    if (!typed.ok) throw new Error(`typing failed: ${JSON.stringify(typed)}`)
    recordAttempt(attempt, 'TEXT_CONFIRMED', {
      reused: typed.reused,
      recoveredAfterTimeout: typed.recoveredAfterTimeout,
    })

    const intentPath = join(runRoot, `turn${turn}-send-intent.json`)
    const intent = {
      schemaVersion: 1,
      status: 'prepared',
      runRoot,
      provider,
      agentProfileId: expectedAgentProfileId(provider),
      turn,
      workitemId: turn === 1 ? String(workitemId) : null,
      text,
      localEqualityOnly,
      launchId: state.launchId,
      pid: state.pid,
      port: state.port,
      preparedAt: new Date().toISOString(),
    }
    const prepareIntent = dependencies.prepareIntent ?? prepareIntentUnderLifecycleGate
    prepareIntent(runRoot, provider, turn, intent)
    recordAttempt(attempt, 'INTENT_PREPARED')

    const started = await startTurnOnce(
      {
        state,
        target,
        text,
        expectedTurnCount: turn - 1,
        selectedAgentId: expectedSelectedAgentId(provider),
        permissionLabel: expectedPermissionLabel(provider),
      },
      {
        ...dependencies,
        onStage: (stage, detail) => recordAttempt(attempt, stage, detail),
      },
    )
    recordAttempt(attempt, 'START_CONFIRMED', {
      clickRecoveredAfterFailure: started.clickRecoveredAfterFailure,
      turnCount: started.snapshot?.turnCount ?? null,
      busy: started.snapshot?.busy ?? null,
    })
    const sentAt = new Date().toISOString()
    writeJsonAtomic(intentPath, { ...intent, status: 'sent', sentAt })

    const evidence = {
      schemaVersion: 1,
      runRoot,
      provider,
      turn,
      workitemId: turn === 1 ? String(workitemId) : null,
      localEqualityOnly,
      text,
      agentProfileId: expectedAgentProfileId(provider),
      launchId: state.launchId,
      pid: state.pid,
      port: state.port,
      before,
      typed,
      started,
      sentAt,
    }
    writeJsonAtomic(join(runRoot, `turn${turn}-send.json`), evidence)
    recordAttempt(attempt, 'SENT', { sentAt })
    return evidence
  } catch (error) {
    recordAttempt(attempt, 'FAILED', {
      error: cdpFailure(error),
      startEvidence: error?.startEvidence ?? null,
      clickFailure: error?.clickFailure ?? null,
    })
    throw error
  }
}

async function draft(runRoot, provider, workitemId, localEqualityOnly) {
  // A draft stops at the typed first message: exact readback verified, no
  // send click, no send intent. The draft record is committed atomically by
  // `fixed_workspace.py record-draft` under the same lifecycle gate the
  // finalizer holds, so the run classifies as RETAINED_DRAFT afterwards.
  const text = promptText(provider, 1, workitemId, localEqualityOnly)
  const { state, target, before } = await preconditions(runRoot, provider, 1, text)
  const typed = await ensureContractText({ state, target, before, text })
  if (!typed.ok) throw new Error(`typing failed: ${JSON.stringify(typed)}`)

  const draftRecord = {
    schemaVersion: 1,
    status: 'drafted',
    runRoot,
    provider,
    turn: 1,
    workitemId: String(workitemId),
    text,
    localEqualityOnly,
    agentProfileId: expectedAgentProfileId(provider),
    launchId: state.launchId,
    pid: state.pid,
    port: state.port,
    draftedAt: new Date().toISOString(),
  }
  prepareDraftUnderLifecycleGate(runRoot, provider, draftRecord)

  const evidence = {
    schemaVersion: 1,
    runRoot,
    provider,
    turn: 1,
    workitemId: String(workitemId),
    localEqualityOnly,
    text,
    agentProfileId: expectedAgentProfileId(provider),
    launchId: state.launchId,
    pid: state.pid,
    port: state.port,
    before,
    typed,
    draftedAt: new Date().toISOString(),
  }
  writeJsonAtomic(join(runRoot, 'turn1-draft-evidence.json'), evidence)
  return evidence
}

async function selfTest() {
  const expected = {
    claude: '/rate-workflow 85237895 理解prd后停下',
    codex: '/rate-workflow 85237895 理解prd后停下',
    qoder: '/rate-native-rate-workflow 85237895 理解prd后停下',
    opencode: '/rate-workflow 85237895 理解prd后停下',
    pi: '/skill:rate-workflow 85237895 理解prd后停下',
  }
  for (const [provider, text] of Object.entries(expected)) {
    if (promptText(provider, 1, '85237895') !== text) throw new Error(`turn 1 text drifted for ${provider}`)
    if (promptText(provider, 2) !== '确认并继续 写技术方案前停下') throw new Error(`turn 2 text drifted for ${provider}`)
    if (promptText(provider, 3) !== '确认 写完技术方案后停下') throw new Error(`turn 3 text drifted for ${provider}`)
  }
  if (promptText('codex', 1, CONTRACT.sourceWorkitem.id, true) !== `/rate-workflow ${CONTRACT.sourceWorkitem.id} ${CONTRACT.firstPromptSuffix}`) {
    throw new Error('local equality prompt drifted')
  }
  for (const bad of ['', 'REQ-1', '85237895 ', undefined, CONTRACT.sourceWorkitem.id]) {
    let rejected = false
    try {
      promptText('qoder', 1, bad)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`turn 1 accepted an invalid workitem id: ${JSON.stringify(bad)}`)
  }
  let unsupported = false
  try {
    promptText('gemini', 1, '85237895')
  } catch {
    unsupported = true
  }
  if (!unsupported) throw new Error('unsupported provider was accepted')

  const preconditionFixture = {
    identity: true,
    providerLabel: 'Pi',
    selectedAgentId: 'pi:default',
    agentProfileId: 'pi:default',
    permissionValue: CONTRACT.permission.value,
    permissionLabel: expectedPermissionLabel('pi'),
    busy: false,
    turnCount: 0,
    inputValue: '',
  }
  assertComposerPreconditions(preconditionFixture, 'pi', 1, expected.pi)
  for (const drifted of [
    { ...preconditionFixture, selectedAgentId: 'pi:other' },
    { ...preconditionFixture, selectedAgentId: 'pi' },
    { ...preconditionFixture, agentProfileId: 'pi:other' },
    { ...preconditionFixture, permissionLabel: CONTRACT.permission.label },
  ]) {
    let rejected = false
    try {
      assertComposerPreconditions(drifted, 'pi', 1, expected.pi)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`Pi composer identity drift was accepted: ${JSON.stringify(drifted)}`)
  }

  const text = '确认 写完技术方案后停下'
  const exact = {
    inputValue: text,
    slashOpen: false,
    turnCount: 2,
    busy: false,
  }
  let evaluateCalls = 0
  const reused = await ensureContractText({
    state: { launchId: 'launch-fixture' },
    target: { id: 'target-fixture' },
    before: exact,
    text,
  }, {
    evaluate: async () => { evaluateCalls += 1 },
  })
  if (!reused.reused || evaluateCalls !== 0) throw new Error('exact closed composer text was typed again')

  const timeout = new CdpEvaluationError({
    phase: 'type',
    kind: 'timeout',
    targetId: 'target-fixture',
    elapsedMs: EVALUATE_TIMEOUT_MS,
    message: 'fixture timeout',
    cause: new Error('fixture timeout'),
  })
  let mutationCalls = 0
  let reconcileCalls = 0
  const recovered = await ensureContractText({
    state: { launchId: 'launch-fixture' },
    target: { id: 'target-fixture' },
    before: { ...exact, inputValue: '' },
    text,
  }, {
    evaluate: async (_target, _expression, options) => {
      if (options.phase === 'type') {
        mutationCalls += 1
        throw timeout
      }
      if (options.phase === 'type_reconcile') {
        reconcileCalls += 1
        return exact
      }
      throw new Error(`unexpected self-test phase ${options.phase}`)
    },
    ownedTarget: async () => ({ id: 'target-fixture-reacquired' }),
  })
  if (!recovered.recoveredAfterTimeout || mutationCalls !== 1 || reconcileCalls !== 1) {
    throw new Error('typing timeout did not reconcile through one read-only snapshot')
  }

  let clickCalls = 0
  let clock = 0
  const clickStages = []
  const started = await startTurnOnce({
    state: { launchId: 'launch-fixture' },
    target: { id: 'target-fixture' },
    text,
    expectedTurnCount: 2,
  }, {
    evaluate: async (_target, _expression, options) => {
      if (options.phase === 'click') {
        clickCalls += 1
        throw new CdpEvaluationError({
          phase: 'click',
          kind: 'timeout',
          targetId: 'target-fixture',
          elapsedMs: EVALUATE_TIMEOUT_MS,
          message: 'fixture click timeout',
          cause: new Error('fixture click timeout'),
        })
      }
      if (options.phase === 'start_reconcile') return { turnCount: 3, busy: true, composerError: null }
      throw new Error(`unexpected self-test phase ${options.phase}`)
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    deadlineMs: 1_000,
    onStage: (stage) => clickStages.push(stage),
  })
  if (
    !started.clickRecoveredAfterFailure
    || clickCalls !== 1
    || !started.ok
    || JSON.stringify(clickStages) !== JSON.stringify(['CLICK_UNCONFIRMED'])
  ) {
    throw new Error('click timeout was not reconciled without a second click')
  }
  console.log('self-test: PASS')
}

async function main() {
  const [action, ...rest] = process.argv.slice(2)
  if (action === 'self-test') return selfTest()
  if (action !== 'send' && action !== 'draft') {
    console.error('usage: send_prompt.mjs send --run-root DIR --provider ID --turn 1|2|3 [--workitem-id ID] [--local-equality-only true]\n       send_prompt.mjs draft --run-root DIR --provider ID --turn 1 --workitem-id ID [--local-equality-only true]\n       send_prompt.mjs self-test')
    process.exitCode = 2
    return
  }
  const options = parseOptions(rest)
  const rawRunRoot = options.get('run-root')
  const provider = options.get('provider')
  const turn = Number(options.get('turn'))
  const localEqualityRaw = options.get('local-equality-only')
  if (localEqualityRaw !== undefined && !['true', 'false'].includes(localEqualityRaw)) {
    throw new Error('--local-equality-only must be true or false')
  }
  const localEqualityOnly = localEqualityRaw === 'true'
  if (!rawRunRoot || !provider) throw new Error('missing --run-root or --provider')
  const runRoot = safeRunRoot(rawRunRoot)
  const allowed = new Set(['run-root', 'provider', 'turn', 'workitem-id', 'local-equality-only'])
  if ([...options.keys()].some((key) => !allowed.has(key))) throw new Error('unsupported send option')
  let evidence
  if (action === 'send') {
    evidence = await send(runRoot, provider, turn, options.get('workitem-id'), localEqualityOnly)
  } else {
    if (turn !== 1) throw new Error('draft only supports turn 1')
    evidence = await draft(runRoot, provider, options.get('workitem-id'), localEqualityOnly)
  }
  console.log(JSON.stringify(evidence, null, 2))
}

await main()
