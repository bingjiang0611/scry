import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export const DEFAULT_STOP_POLICY = Object.freeze({
  pollMs: 250,
  retrySignalAfterMs: 8_000,
  timeoutMs: 35_000,
  maxSignals: 2,
})

export class OwnedProcessStopError extends Error {
  constructor(code, message, evidence) {
    super(message)
    this.name = 'OwnedProcessStopError'
    this.code = code
    this.evidence = evidence
  }
}

export class StopLockError extends Error {
  constructor(code, message, evidence = null) {
    super(message)
    this.name = 'StopLockError'
    this.code = code
    this.evidence = evidence
  }
}

function lockHolder(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim()
    return /^\d+$/.test(raw) ? Number(raw) : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function acquireStopLock(statePath, dependencies = {}) {
  const lockPath = `${statePath}.stop.lock`
  const controllerPid = dependencies.controllerPid ?? process.pid
  const shlockPath = dependencies.shlockPath ?? '/usr/bin/shlock'
  const runShlock = dependencies.runShlock ?? ((args) => spawnSync(shlockPath, args, { encoding: 'utf8' }))
  const result = runShlock(['-f', lockPath, '-p', String(controllerPid)])
  if (result?.error) {
    throw new StopLockError('STOP_LOCK_UNAVAILABLE', `cannot acquire owned Scry Test stop lock: ${result.error.message}`)
  }
  if (result?.status !== 0) {
    throw new StopLockError(
      'STOP_LOCK_HELD',
      `owned Scry Test stop lock is held by live controller PID ${lockHolder(lockPath) ?? 'unknown'}: ${lockPath}`,
      { lockPath, holderPid: lockHolder(lockPath) },
    )
  }
  const holderPid = lockHolder(lockPath)
  if (holderPid !== controllerPid) {
    throw new StopLockError(
      'STOP_LOCK_IDENTITY_MISMATCH',
      `stop lock owner mismatch after acquisition: expected ${controllerPid}, got ${holderPid ?? 'unknown'}`,
      { lockPath, expectedPid: controllerPid, holderPid },
    )
  }

  let released = false
  return () => {
    if (released) return
    if (!existsSync(lockPath)) {
      released = true
      return
    }
    const currentHolder = lockHolder(lockPath)
    if (currentHolder !== controllerPid) {
      throw new StopLockError(
        'STOP_LOCK_IDENTITY_MISMATCH',
        `stop lock ownership drifted: expected ${controllerPid}, got ${currentHolder ?? 'unknown'}`,
        { lockPath, expectedPid: controllerPid, holderPid: currentHolder },
      )
    }
    unlinkSync(lockPath)
    released = true
  }
}

export async function withStopStateLock(statePath, readState, operation, dependencies = {}) {
  const releaseLock = acquireStopLock(statePath, dependencies)
  try {
    const latestState = readState(statePath)
    return await operation(latestState)
  } finally {
    releaseLock()
  }
}

async function observe(state, dependencies) {
  const command = dependencies.processCommand(state.pid)
  return {
    processAlive: command.length > 0,
    commandMatches: dependencies.commandMatches(state, command),
    cdpOpen: await dependencies.cdpOpen(state.port),
    command,
  }
}

async function waitForQuiescence(state, deadline, dependencies, policy) {
  let current = await observe(state, dependencies)
  while (dependencies.now() < deadline && (current.processAlive || current.cdpOpen)) {
    await dependencies.sleep(policy.pollMs)
    current = await observe(state, dependencies)
  }
  return current
}

function assertSignalTarget(state, current) {
  if (!current.processAlive) return false
  if (!current.commandMatches) {
    throw new OwnedProcessStopError(
      'PROCESS_IDENTITY_MISMATCH',
      `PID ${state.pid} no longer matches the owned Scry Test command; refusing to signal it`,
      current,
    )
  }
  return true
}

async function reserveAndSendSignal(state, dependencies, context) {
  if (context.signalsReserved >= context.policy.maxSignals) {
    throw new OwnedProcessStopError(
      'SIGNAL_BUDGET_EXHAUSTED',
      `owned Scry Test already consumed its ${context.policy.maxSignals}-signal budget: ${state.pid}`,
      { signalsReserved: context.signalsReserved, maxSignals: context.policy.maxSignals },
    )
  }
  const sequence = context.signalsReserved + 1
  await dependencies.beforeSignal?.({ sequence, signal: 'SIGTERM', atMs: dependencies.now() - context.startedAt })
  context.signalsReserved = sequence
  const record = { sequence, signal: 'SIGTERM', atMs: dependencies.now() - context.startedAt, sent: false, errorCode: null }
  try {
    dependencies.sendSignal(state.pid, 'SIGTERM')
    record.sent = true
    context.signals.push(record)
    await dependencies.afterSignal?.(record)
    return true
  } catch (error) {
    record.errorCode = error?.code ?? null
    context.signals.push(record)
    await dependencies.afterSignal?.(record)
    if (error?.code === 'ESRCH') return false
    throw new OwnedProcessStopError(
      'SIGNAL_FAILED',
      `failed to signal owned Scry Test PID ${state.pid}: ${error instanceof Error ? error.message : String(error)}`,
      { ...record, signalsReserved: context.signalsReserved },
    )
  }
}

export async function stopOwnedProcess(state, dependencies, overrides = {}) {
  const policy = { ...DEFAULT_STOP_POLICY, ...overrides }
  const startedAt = dependencies.now()
  const context = {
    policy,
    startedAt,
    signals: [],
    signalsReserved: overrides.signalsReserved ?? 0,
  }
  let current = await observe(state, dependencies)
  if (!current.processAlive) {
    if (current.cdpOpen) {
      throw new OwnedProcessStopError('CDP_PORT_COLLISION', `PID ${state.pid} is absent but CDP port ${state.port} is still open`, current)
    }
    return { outcome: 'stale', ...context, observation: current }
  }
  assertSignalTarget(state, current)

  if (context.signalsReserved === 0) {
    const firstSignalSent = await reserveAndSendSignal(state, dependencies, context)
    if (!firstSignalSent) {
      current = await observe(state, dependencies)
      if (!current.processAlive && !current.cdpOpen) return { outcome: 'stale', ...context, observation: current }
      assertSignalTarget(state, current)
    }
  } else if (context.signalsReserved >= policy.maxSignals) {
    throw new OwnedProcessStopError(
      'SIGNAL_BUDGET_EXHAUSTED',
      `owned Scry Test remains alive after ${context.signalsReserved} reserved signals: ${state.pid}`,
      { ...current, signalsReserved: context.signalsReserved, maxSignals: policy.maxSignals },
    )
  }

  const retryDelayMs = overrides.retryDelayMs ?? policy.retrySignalAfterMs
  current = await waitForQuiescence(state, startedAt + retryDelayMs, dependencies, policy)
  if (!current.processAlive && !current.cdpOpen) return { outcome: 'stopped', ...context, observation: current }

  if (current.processAlive && context.signalsReserved < policy.maxSignals) {
    current = await observe(state, dependencies)
    if (assertSignalTarget(state, current)) await reserveAndSendSignal(state, dependencies, context)
  }

  current = await waitForQuiescence(state, startedAt + policy.timeoutMs, dependencies, policy)
  if (!current.processAlive && !current.cdpOpen) return { outcome: 'stopped', ...context, observation: current }
  throw new OwnedProcessStopError(
    'STOP_TIMEOUT',
    `owned Scry Test did not stop within ${policy.timeoutMs}ms: ${state.pid}`,
    { ...current, signals: context.signals, signalsReserved: context.signalsReserved },
  )
}
