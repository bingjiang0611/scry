#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateCdp, waitForRendererOwnership } from './cdp_ownership.mjs'

const RUN_PREFIX = 'validate-scry-rate-workflow-'
const DRAFT_PREPARE_TIMEOUT_MS = 15_000
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CONTRACT = JSON.parse(readFileSync(join(SCRIPT_DIR, '..', 'references', 'contract.json'), 'utf8'))
const RUN_ROOT_PARENT = resolve(CONTRACT.retention.runRootParent)

function parseOptions(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`invalid option near ${key ?? '<end>'}`)
    result.set(key.slice(2), value)
  }
  return result
}

function requireOption(options, name) {
  const value = options.get(name)
  if (!value) throw new Error(`missing --${name}`)
  return value
}

function safeRunRoot(raw) {
  const path = realpathSync(resolve(raw))
  if (!basename(path).startsWith(RUN_PREFIX) || realpathSync(dirname(path)) !== realpathSync(RUN_ROOT_PARENT)) {
    throw new Error(`run root must be ${RUN_ROOT_PARENT}/${RUN_PREFIX}*`)
  }
  return path
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

async function ownedTarget(state) {
  const ownership = await waitForRendererOwnership({
    port: state.port,
    expectedUrl: state.expectedRendererUrl,
    expectedBrowserPath: state.expectedBrowserPath,
    launchId: state.launchId,
    expectedTargetId: state.rendererOwnership?.actual?.targetId,
    timeoutMs: 2_000,
  })
  if (ownership.evidence.status !== 'verified' || !ownership.target) {
    throw new Error(`expected one verified owned Scry Test renderer, got ${ownership.evidence.status}: ${JSON.stringify(ownership.evidence)}`)
  }
  return ownership.target
}

const contract = readJson(join(SCRIPT_DIR, '..', 'references', 'contract.json'))
const permission = contract.permission

function expectedAgentProfileId(provider) {
  return contract.providers[provider]?.agentProfileId ?? null
}

function expectedSelectedAgentId(provider) {
  return expectedAgentProfileId(provider) ?? provider
}

function expectedPermissionLabel(provider) {
  return contract.providers[provider]?.permissionLabel ?? permission.label
}

async function prepareDraftIdentity(target, workspace, provider, launchId) {
  const providerContract = contract.providers[provider]
  if (!providerContract) throw new Error(`unsupported provider: ${provider}`)
  const actual = await evaluateCdp(target, `(async () => {
    const expectedWorkspace = ${JSON.stringify(workspace)}
    const expectedWorkspaceLabel = ${JSON.stringify(basename(workspace))}
    const expectedProvider = ${JSON.stringify(provider)}
    const expectedProviderLabel = ${JSON.stringify(providerContract.displayName)}
    const expectedAgentProfileId = ${JSON.stringify(expectedAgentProfileId(provider))}
    const expectedSelectedAgentId = ${JSON.stringify(expectedSelectedAgentId(provider))}
    const expectedLaunchId = ${JSON.stringify(launchId)}
    const timeoutMs = ${DRAFT_PREPARE_TIMEOUT_MS}
    const wait = (ms) => new Promise((done) => setTimeout(done, ms))
    const poll = async (read, ready, label) => {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        try {
          last = await read()
          if (ready(last)) return last
        } catch (error) {
          last = { error: error instanceof Error ? error.message : String(error) }
        }
        await wait(100)
      }
      throw new Error(label + ' timed out: ' + JSON.stringify(last))
    }

    try {
      const input = document.querySelector('.composer textarea')
      const providerButton = document.querySelector('.clibtn')
      const turnCount = document.querySelectorAll('.turn').length
      const inputLength = input instanceof HTMLTextAreaElement ? input.value.length : null
      if (
        document.documentElement.dataset.scryTestApp !== 'true'
        || document.documentElement.dataset.scryTestLaunchId !== expectedLaunchId
      ) return { ok: false, reason: 'test_renderer_identity_mismatch', turnCount, inputLength }
      if (
        !(input instanceof HTMLTextAreaElement)
        || !(providerButton instanceof HTMLButtonElement)
        || providerButton.disabled
        || turnCount !== 0
        || input.value.length !== 0
      ) return { ok: false, reason: 'draft_not_new_and_empty', turnCount, inputLength, providerDisabled: providerButton?.disabled ?? null }

      let workspaceButton = document.querySelector('.wdbtn')
      if (!(workspaceButton instanceof HTMLButtonElement)) return { ok: false, reason: 'workspace_picker_missing' }
      if (workspaceButton.textContent?.trim() !== expectedWorkspaceLabel) {
        workspaceButton.click()
        const workspaceOption = await poll(
          () => [...document.querySelectorAll('.wdrecent-pick')]
            .find((candidate) => candidate instanceof HTMLButtonElement && candidate.title === expectedWorkspace) ?? null,
          (candidate) => candidate instanceof HTMLButtonElement,
          'workspace option'
        )
        workspaceOption.click()
        workspaceButton = await poll(
          () => document.querySelector('.wdbtn'),
          (candidate) => candidate instanceof HTMLButtonElement
            && candidate.textContent?.trim() === expectedWorkspaceLabel,
          'workspace selection'
        )
      }

      let selectedProviderButton = document.querySelector('.clibtn')
      if (!(selectedProviderButton instanceof HTMLButtonElement)) return { ok: false, reason: 'provider_picker_missing' }
      if (selectedProviderButton.dataset.agentId !== expectedSelectedAgentId) {
        selectedProviderButton.click()
        const providerOption = await poll(
          () => [...document.querySelectorAll('.climenu .mitem')]
            .find((candidate) => candidate instanceof HTMLButtonElement
              && candidate.dataset.agentId === expectedSelectedAgentId) ?? null,
          (candidate) => candidate instanceof HTMLButtonElement,
          'provider option'
        )
        providerOption.click()
      }

      const ready = await poll(async () => {
        const currentProviderButton = document.querySelector('.clibtn')
        const providerStatus = document.querySelector('.tb-agent-status')
        const providerStatusLabel = providerStatus?.querySelector('.agent-name')?.textContent?.trim() ?? ''
        const permissionSelect = document.querySelector(${JSON.stringify(permission.selector)})
        const descriptors = await window.scry.providerDescriptors()
        const descriptor = descriptors.find((item) => item.id === expectedProvider)
        return {
          workspaceLabel: document.querySelector('.wdbtn')?.textContent?.trim() ?? '',
          providerLabel: currentProviderButton?.textContent?.trim() ?? '',
          selectedAgentId: currentProviderButton instanceof HTMLButtonElement
            ? currentProviderButton.dataset.agentId ?? null
            : null,
          providerStatusLabel,
          providerDisabled: currentProviderButton instanceof HTMLButtonElement ? currentProviderButton.disabled : null,
          providerOff: Boolean(providerStatus?.querySelector('.dot.off')),
          descriptor: descriptor ? {
            id: descriptor.id,
            label: descriptor.label,
            runtimeProvider: descriptor.runtimeProvider,
            available: descriptor.available,
            disabledReason: descriptor.disabledReason ?? null,
            health: descriptor.health?.state ?? null
          } : null,
          permissionReady: permissionSelect instanceof HTMLSelectElement
            && !permissionSelect.disabled
            && [...permissionSelect.options].some((option) => option.value === ${JSON.stringify(permission.value)})
        }
      }, (value) => value.workspaceLabel === expectedWorkspaceLabel
        && value.providerLabel === expectedProviderLabel
        && value.selectedAgentId === expectedSelectedAgentId
        && value.providerStatusLabel === expectedProviderLabel
        && value.providerDisabled === false
        && value.providerOff === false
        && value.descriptor?.id === expectedProvider
        && value.descriptor?.label === expectedProviderLabel
        && value.descriptor?.available === true
        && value.descriptor?.disabledReason == null
        && value.permissionReady === true,
      'draft identity')

      return {
        ok: true,
        turnCount,
        inputLength,
        workspace: expectedWorkspace,
        provider: expectedProvider,
        agentProfileId: ready.selectedAgentId === expectedSelectedAgentId ? expectedAgentProfileId : null,
        ...ready
      }
    } catch (error) {
      return { ok: false, reason: 'prepare_failed', message: error instanceof Error ? error.message : String(error) }
    }
  })()`, { phase: 'capture_prepare_identity', timeoutMs: DRAFT_PREPARE_TIMEOUT_MS + 5_000 })
  if (!actual?.ok) throw new Error(`draft identity preparation failed: ${JSON.stringify(actual)}`)
  return actual
}

async function permissionSnapshot(target, workspace, provider, launchId, setPermission) {
  const providerContract = contract.providers[provider]
  if (!providerContract) throw new Error(`unsupported provider: ${provider}`)
  return await evaluateCdp(target, `(async () => {
    const selector = ${JSON.stringify(permission.selector)}
    const expectedWorkspace = ${JSON.stringify(workspace)}
    const expectedWorkspaceLabel = ${JSON.stringify(basename(workspace))}
    const expectedProviderLabel = ${JSON.stringify(providerContract.displayName)}
    const expectedAgentProfileId = ${JSON.stringify(expectedAgentProfileId(provider))}
    const expectedSelectedAgentId = ${JSON.stringify(expectedSelectedAgentId(provider))}
    let select = document.querySelector(selector)
    if (!(select instanceof HTMLSelectElement)) return { found: false }
    const optionPresent = [...select.options].some((option) => option.value === ${JSON.stringify(permission.value)})
    if (${setPermission ? 'true' : 'false'} && !select.disabled && optionPresent) {
      select.value = ${JSON.stringify(permission.value)}
      select.dispatchEvent(new Event('input', { bubbles: true }))
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((done) => setTimeout(done, 0))
      select = document.querySelector(selector)
    }
    const activeProject = document.querySelector('.sb-proj-head.on[data-project-path]')
    const providerButton = document.querySelector('.clibtn')
    const providerStatus = document.querySelector('.tb-agent-status')
    const workspaceButton = document.querySelector('.wdbtn')
    const providerLabel = providerButton?.textContent?.trim() ?? ''
    const selectedAgentId = providerButton instanceof HTMLButtonElement
      ? providerButton.dataset.agentId ?? null
      : null
    const providerStatusLabel = providerStatus?.querySelector('.agent-name')?.textContent?.trim() ?? ''
    const workspaceLabel = workspaceButton?.textContent?.trim() ?? ''
    const workspacePath = activeProject?.dataset?.projectPath ?? null
    const workspaceExact = workspacePath === expectedWorkspace
    let providerDescriptor = null
    try {
      const descriptors = await window.scry.providerDescriptors()
      const descriptor = descriptors.find((item) => item.id === ${JSON.stringify(provider)})
      if (descriptor) providerDescriptor = {
        id: descriptor.id,
        label: descriptor.label,
        runtimeProvider: descriptor.runtimeProvider,
        available: descriptor.available,
        disabledReason: descriptor.disabledReason ?? null,
        health: descriptor.health?.state ?? null
      }
    } catch {}
    return {
      found: select instanceof HTMLSelectElement,
      disabled: select instanceof HTMLSelectElement ? select.disabled : null,
      optionPresent,
      value: select instanceof HTMLSelectElement ? select.value : null,
      label: select instanceof HTMLSelectElement ? select.selectedOptions[0]?.textContent?.trim() ?? '' : null,
      workspacePath,
      workspaceLabel,
      workspaceExact,
      providerLabel,
      selectedAgentId,
      providerStatusLabel,
      providerDescriptor,
      agentProfileId: selectedAgentId === expectedSelectedAgentId ? expectedAgentProfileId : null,
      providerSelectable: providerButton instanceof HTMLButtonElement && !providerButton.disabled,
      providerHealthy: providerButton instanceof HTMLButtonElement
        && providerLabel === expectedProviderLabel
        && selectedAgentId === expectedSelectedAgentId
        && providerStatusLabel === expectedProviderLabel
        && providerDescriptor?.label === expectedProviderLabel
        && providerDescriptor?.available === true
        && providerDescriptor?.disabledReason == null
        && !providerStatus?.querySelector('.dot.off'),
      identityMatches: (workspaceExact || workspaceLabel === expectedWorkspaceLabel)
        && providerLabel === expectedProviderLabel
        && selectedAgentId === expectedSelectedAgentId
        && providerStatusLabel === expectedProviderLabel
        && providerDescriptor?.label === expectedProviderLabel,
      title: document.title,
      testApp: document.documentElement.dataset.scryTestApp === 'true',
      testLaunchId: document.documentElement.dataset.scryTestLaunchId ?? null
    }
  })()`, { phase: setPermission ? 'capture_set_permission' : 'capture_read_permission', timeoutMs: 5_000 })
}

function assertSnapshot(actual, workspace, provider, launchId, requireExactWorkspace, requireSelectableProvider) {
  const expectedProviderLabel = contract.providers[provider]?.displayName
  const agentProfileId = expectedAgentProfileId(provider)
  const selectedAgentId = expectedSelectedAgentId(provider)
  if (
    !actual?.found
    || actual.disabled
    || !actual.optionPresent
    || actual.value !== permission.value
    || actual.label !== expectedPermissionLabel(provider)
    || actual.workspaceLabel !== basename(workspace)
    || (actual.workspacePath !== null && actual.workspacePath !== workspace)
    || (requireExactWorkspace && (!actual.workspaceExact || actual.workspacePath !== workspace))
    || actual.providerLabel !== expectedProviderLabel
    || actual.selectedAgentId !== selectedAgentId
    || actual.providerStatusLabel !== expectedProviderLabel
    || (requireSelectableProvider && !actual.providerSelectable)
    || !actual.providerHealthy
    || actual.providerDescriptor?.id !== provider
    || actual.providerDescriptor?.label !== expectedProviderLabel
    || actual.providerDescriptor?.runtimeProvider !== contract.providers[provider]?.runtime
    || actual.agentProfileId !== agentProfileId
    || !actual.identityMatches
    || !actual.testApp
    || actual.testLaunchId !== launchId
  ) throw new Error(`full_access identity/DOM verification failed: ${JSON.stringify(actual)}`)
}

function runSelfTest() {
  const workspace = '/tmp/qoder-workspace'
  const launchId = 'self-test-launch'
  const snapshot = {
    found: true,
    disabled: false,
    optionPresent: true,
    value: permission.value,
    label: permission.label,
    workspacePath: null,
    workspaceLabel: basename(workspace),
    workspaceExact: false,
    providerLabel: 'Qoder',
    selectedAgentId: 'qoder',
    providerStatusLabel: 'Qoder',
    providerDescriptor: {
      id: 'qoder',
      label: 'Qoder',
      runtimeProvider: 'qoder_cli',
      available: true,
      disabledReason: null,
      health: 'ready',
    },
    agentProfileId: null,
    providerSelectable: true,
    providerHealthy: true,
    identityMatches: true,
    title: 'Scry Test',
    testApp: true,
    testLaunchId: launchId,
  }
  assertSnapshot(snapshot, workspace, 'qoder', launchId, false, true)
  assertSnapshot({ ...snapshot, workspacePath: workspace, workspaceExact: true, providerSelectable: false }, workspace, 'qoder', launchId, true, false)

  let lockedDraftRejected = false
  try {
    assertSnapshot({ ...snapshot, providerSelectable: false }, workspace, 'qoder', launchId, false, true)
  } catch {
    lockedDraftRejected = true
  }
  if (!lockedDraftRejected) throw new Error('self-test accepted a locked provider before the first prompt')

  for (const drifted of [
    { ...snapshot, providerLabel: 'Qoder CLI' },
    { ...snapshot, providerStatusLabel: 'Qoder CLI' },
    { ...snapshot, providerDescriptor: { ...snapshot.providerDescriptor, label: 'Qoder CLI' } },
  ]) {
    let rejected = false
    try {
      assertSnapshot(drifted, workspace, 'qoder', launchId, false, true)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`self-test accepted provider label drift: ${JSON.stringify(drifted)}`)
  }
  const piSnapshot = {
    ...snapshot,
    label: expectedPermissionLabel('pi'),
    providerLabel: 'Pi',
    selectedAgentId: 'pi:default',
    providerStatusLabel: 'Pi',
    providerDescriptor: {
      ...snapshot.providerDescriptor,
      id: 'pi',
      label: 'Pi',
      runtimeProvider: 'pi_rpc',
    },
    agentProfileId: 'pi:default',
  }
  assertSnapshot(piSnapshot, workspace, 'pi', launchId, false, true)
  for (const drifted of [
    { ...piSnapshot, selectedAgentId: 'pi' },
    { ...piSnapshot, selectedAgentId: 'pi:other' },
    { ...snapshot, selectedAgentId: 'pi:default' },
  ]) {
    let rejected = false
    try {
      assertSnapshot(drifted, drifted.providerLabel === 'Pi' ? 'pi' : 'qoder', launchId, false, true)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`self-test accepted selected Agent id drift: ${JSON.stringify(drifted)}`)
  }
  let crossProfileRejected = false
  try {
    assertSnapshot({ ...snapshot, agentProfileId: 'pi:default' }, workspace, 'qoder', launchId, false, true)
  } catch {
    crossProfileRejected = true
  }
  if (!crossProfileRejected) throw new Error('self-test accepted a Pi profile on a non-Pi provider')
  process.stdout.write('self-test: PASS\n')
}

const [action, ...rawOptions] = process.argv.slice(2)
if (action === 'self-test') {
  if (rawOptions.length > 0) throw new Error('self-test does not accept options')
  runSelfTest()
  process.exit(0)
}
if (!['capture', 'bind'].includes(action)) {
  throw new Error('usage: capture_permission.mjs self-test | capture --run-root <path> --workspace <path> --provider <id> | bind --run-root <path> --session-id <id>')
}
const options = parseOptions(rawOptions)
const runRoot = safeRunRoot(requireOption(options, 'run-root'))
const statePath = join(runRoot, 'test-scry-state.json')
const evidencePath = join(runRoot, 'permission-evidence.json')
if (!existsSync(statePath)) throw new Error(`missing test app state: ${statePath}`)
const state = readJson(statePath)
const rendererRoot = state.runtimeRoot ?? state.scryRepo
const expectedRendererUrl = rendererRoot
  ? pathToFileURL(join(realpathSync(rendererRoot), 'out', 'renderer', 'index.html')).href
  : null
if (
  ![2, 3].includes(state.version)
  || state.mode !== 'test'
  || state.status !== 'running'
  || state.ownedRendererReady !== true
  || state.expectedRendererUrl !== expectedRendererUrl
  || !state.expectedBrowserPath
  || state.rendererOwnership?.schemaVersion !== 2
  || state.rendererOwnership?.status !== 'verified'
  || !state.rendererOwnership?.actual?.targetId
  || !state.launchId
  || !Number.isInteger(state.pid)
  || !Number.isInteger(state.port)
) {
  throw new Error('test app state is not a valid running owned launch')
}

if (action === 'capture') {
  for (const name of ['workspace', 'provider']) requireOption(options, name)
  if ([...options.keys()].some((key) => !['run-root', 'workspace', 'provider'].includes(key))) throw new Error('unsupported capture option')
  if (existsSync(evidencePath)) throw new Error(`permission evidence already exists: ${evidencePath}`)
  const workspace = realpathSync(resolve(requireOption(options, 'workspace')))
  const provider = requireOption(options, 'provider')
  const providerContract = contract.providers[provider]
  if (!providerContract) throw new Error(`unsupported provider: ${provider}`)
  if (state.expectedWorkspace !== workspace) {
    throw new Error(`test app workspace mismatch: expected ${state.expectedWorkspace ?? '<missing>'}, got ${workspace}`)
  }
  const target = await ownedTarget(state)
  const prepared = await prepareDraftIdentity(target, workspace, provider, state.launchId)
  const actual = await permissionSnapshot(target, workspace, provider, state.launchId, true)
  assertSnapshot(actual, workspace, provider, state.launchId, false, true)
  const evidence = {
    schemaVersion: 2,
    launchId: state.launchId,
    pid: state.pid,
    port: state.port,
    workspace,
    provider,
    agentProfileId: expectedAgentProfileId(provider),
    expected: {
      value: permission.value,
      label: expectedPermissionLabel(provider),
      workspace,
      providerLabel: providerContract.displayName,
      agentProfileId: expectedAgentProfileId(provider),
    },
    prepared,
    actual,
    capturedAt: new Date().toISOString(),
    sessionId: null,
    boundAt: null,
  }
  writeJsonAtomic(evidencePath, evidence)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  process.exit(0)
}

if ([...options.keys()].some((key) => !['run-root', 'session-id'].includes(key))) throw new Error('unsupported bind option')
if (!existsSync(evidencePath)) throw new Error(`missing permission evidence: ${evidencePath}`)
const sessionId = requireOption(options, 'session-id')
const evidence = readJson(evidencePath)
if (evidence.launchId !== state.launchId) throw new Error('permission evidence launchId drifted')
if (evidence.agentProfileId !== expectedAgentProfileId(evidence.provider)) {
  throw new Error(`permission evidence agentProfileId drifted: ${JSON.stringify(evidence.agentProfileId)}`)
}
if (evidence.sessionId && evidence.sessionId !== sessionId) throw new Error(`permission evidence already bound to ${evidence.sessionId}`)
const target = await ownedTarget(state)
const actualAtBind = await permissionSnapshot(target, evidence.workspace, evidence.provider, state.launchId, false)
assertSnapshot(actualAtBind, evidence.workspace, evidence.provider, state.launchId, true, false)
const bound = {
  ...evidence,
  sessionId,
  boundAt: evidence.boundAt ?? new Date().toISOString(),
  actualAtBind: evidence.actualAtBind ?? actualAtBind,
}
writeJsonAtomic(evidencePath, bound)
process.stdout.write(`${JSON.stringify(bound)}\n`)
