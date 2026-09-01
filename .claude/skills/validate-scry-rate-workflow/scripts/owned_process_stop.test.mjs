import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { acquireStopLock, OwnedProcessStopError, StopLockError, stopOwnedProcess, withStopStateLock } from './owned_process_stop.mjs'

const state = { pid: 42, port: 9222 }
const ownedCommand = 'Electron /repo/scry --user-data-dir=/tmp/run --remote-debugging-port=9222'

function harness({ commandAt, cdpAt = () => false }) {
  let time = 0
  const signals = []
  return {
    dependencies: {
      processCommand: () => commandAt(time, signals),
      commandMatches: (_state, command) => command === ownedCommand,
      cdpOpen: async () => cdpAt(time, signals),
      sendSignal: (_pid, signal) => signals.push({ signal, time }),
      now: () => time,
      sleep: async (ms) => { time += ms },
    },
    signals,
    time: () => time,
  }
}

test('uses one SIGTERM when the owned process exits promptly', async () => {
  const fixture = harness({
    commandAt: (time, signals) => signals.length > 0 && time >= 1_000 ? '' : ownedCommand,
    cdpAt: (time, signals) => !(signals.length > 0 && time >= 1_000),
  })
  const result = await stopOwnedProcess(state, fixture.dependencies)

  assert.equal(result.outcome, 'stopped')
  assert.equal(fixture.signals.length, 1)
  assert.equal(fixture.time(), 1_000)
})

test('sends a second SIGTERM at 8s when CDP closes but the exact process remains', async () => {
  const fixture = harness({
    commandAt: (time, signals) => signals.length === 2 && time >= 31_000 ? '' : ownedCommand,
    cdpAt: (_time, signals) => signals.length === 0,
  })
  const result = await stopOwnedProcess(state, fixture.dependencies)

  assert.equal(result.outcome, 'stopped')
  assert.deepEqual(fixture.signals.map((item) => item.time), [0, 8_000])
  assert.equal(fixture.time(), 31_000)
})

test('rechecks command identity before the second SIGTERM', async () => {
  const fixture = harness({
    commandAt: (time) => time >= 8_000 ? 'another process' : ownedCommand,
  })
  await assert.rejects(
    stopOwnedProcess(state, fixture.dependencies),
    (error) => error instanceof OwnedProcessStopError && error.code === 'PROCESS_IDENTITY_MISMATCH',
  )
  assert.equal(fixture.signals.length, 1)
})

test('never escalates beyond two SIGTERM signals when shutdown times out', async () => {
  const fixture = harness({ commandAt: () => ownedCommand, cdpAt: () => true })
  await assert.rejects(
    stopOwnedProcess(state, fixture.dependencies),
    (error) => error instanceof OwnedProcessStopError && error.code === 'STOP_TIMEOUT',
  )
  assert.equal(fixture.signals.length, 2)
  assert.deepEqual(fixture.signals.map((item) => item.signal), ['SIGTERM', 'SIGTERM'])
  assert.equal(fixture.time(), 35_000)
})

test('does not signal when the PID is already absent', async () => {
  const fixture = harness({ commandAt: () => '' })
  const result = await stopOwnedProcess(state, fixture.dependencies)

  assert.equal(result.outcome, 'stale')
  assert.equal(fixture.signals.length, 0)
})

test('treats ESRCH during the first signal as a clean stale race', async () => {
  let commandReads = 0
  const fixture = harness({ commandAt: () => commandReads++ === 0 ? ownedCommand : '' })
  fixture.dependencies.sendSignal = () => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  }
  const result = await stopOwnedProcess(state, fixture.dependencies)

  assert.equal(result.outcome, 'stale')
  assert.equal(result.signals.length, 1)
  assert.equal(result.signals[0].sent, false)
  assert.equal(result.signalsReserved, 1)
})

test('does not signal again after the launch-wide signal budget is exhausted', async () => {
  const fixture = harness({ commandAt: () => ownedCommand, cdpAt: () => true })
  await assert.rejects(
    stopOwnedProcess(state, fixture.dependencies, { signalsReserved: 2 }),
    (error) => error instanceof OwnedProcessStopError && error.code === 'SIGNAL_BUDGET_EXHAUSTED',
  )
  assert.equal(fixture.signals.length, 0)
})

test('rejects a second live stop controller', (t) => {
  if (!existsSync('/usr/bin/shlock')) return t.skip('/usr/bin/shlock is unavailable')
  const runRoot = mkdtempSync('/tmp/validate-scry-rate-workflow-lock-test-')
  t.after(() => rmSync(runRoot, { recursive: true, force: true }))
  const statePath = `${runRoot}/test-scry-state.json`
  const release = acquireStopLock(statePath)

  assert.throws(
    () => acquireStopLock(statePath),
    (error) => error instanceof StopLockError && error.code === 'STOP_LOCK_HELD',
  )
  release()
})

test('recovers a crashed controller lock without resetting the signal budget', async (t) => {
  if (!existsSync('/usr/bin/shlock')) return t.skip('/usr/bin/shlock is unavailable')
  const runRoot = mkdtempSync('/tmp/validate-scry-rate-workflow-lock-test-')
  t.after(() => rmSync(runRoot, { recursive: true, force: true }))
  const statePath = `${runRoot}/test-scry-state.json`
  const lockPath = `${statePath}.stop.lock`
  let deadPid = 999_999
  while (deadPid > 100_000) {
    try {
      process.kill(deadPid, 0)
      deadPid -= 1
    } catch (error) {
      if (error?.code === 'ESRCH') break
      throw error
    }
  }
  writeFileSync(statePath, `${JSON.stringify({ stopControl: { signalsReserved: 0 } })}\n`)
  const staleSnapshot = JSON.parse(readFileSync(statePath, 'utf8'))
  acquireStopLock(statePath, { controllerPid: deadPid })
  writeFileSync(statePath, `${JSON.stringify({ stopControl: { signalsReserved: 1 } })}\n`)
  await new Promise((done) => setTimeout(done, 1_100))

  const fixture = harness({
    commandAt: (_time, signals) => signals.length > 0 ? '' : ownedCommand,
  })
  let lockedState
  const result = await withStopStateLock(
    statePath,
    (path) => JSON.parse(readFileSync(path, 'utf8')),
    async (latestState) => {
      lockedState = latestState
      assert.equal(readFileSync(lockPath, 'utf8').trim(), String(process.pid))
      return await stopOwnedProcess(state, fixture.dependencies, {
        signalsReserved: latestState.stopControl.signalsReserved,
        retryDelayMs: 0,
      })
    },
  )

  assert.equal(staleSnapshot.stopControl.signalsReserved, 0)
  assert.equal(lockedState.stopControl.signalsReserved, 1)
  assert.equal(result.outcome, 'stopped')
  assert.equal(result.signalsReserved, 2)
  assert.equal(fixture.signals.length, 1)
  assert.equal(existsSync(lockPath), false)
})
