#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  batchPlan,
  parseAbabArgs,
  parseProtocolLine,
  protocolLine,
  validateBatchSamples
} from './performance-abab-protocol.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scenarios = Object.keys(JSON.parse(readFileSync(join(root, 'scripts/performance-budgets.json'), 'utf8')).scenarios)

function waitForFile(path, child) {
  if (existsSync(path)) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const cleanup = () => {
      fsWatcher.close()
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      error ? reject(error) : resolvePromise()
    }
    const onExit = (code, signal) => finish(new Error(`ABAB worker exited before ready: ${code ?? signal}`))
    const onError = error => finish(new Error(`ABAB worker failed before ready: ${error.message}`))
    const fsWatcher = watch(dirname(path), (_event, name) => {
      if (name === path.split('/').at(-1) && existsSync(path)) finish()
    })
    child.once('exit', onExit)
    child.once('error', onError)
    // The marker may have appeared between the initial check and watch registration.
    if (existsSync(path)) finish()
    else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`ABAB worker exited before ready: ${child.exitCode ?? child.signalCode}`))
  })
}

async function connectWorker(socketPath, readyPath, child) {
  await waitForFile(readyPath, child)
  const socket = createConnection(socketPath)
  await once(socket, 'connect')
  let buffer = ''
  let closed = false
  let nextId = 1
  const pending = new Map()
  let resolveReady
  let rejectReady
  const ready = new Promise((resolvePromise, reject) => { resolveReady = resolvePromise; rejectReady = reject })
  const rejectAll = error => {
    if (closed) return
    closed = true
    rejectReady(error)
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }
  const dispatch = message => {
    if (message.id === 0) {
      if (!message.ok) rejectReady(new Error(message.error ?? 'ABAB worker is not ready'))
      else resolveReady(message.value)
      return
    }
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      if (message.ok) waiter.resolve(message.value)
      else waiter.reject(new Error(message.error ?? 'ABAB worker request failed'))
    }
  }
  socket.on('data', data => {
    buffer += data.toString()
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      try { dispatch(parseProtocolLine(line)) }
      catch (error) { rejectAll(error instanceof Error ? error : new Error(String(error))) }
    }
  })
  socket.on('error', error => rejectAll(error))
  socket.on('close', () => rejectAll(new Error('ABAB worker control socket closed')))
  const request = message => new Promise((resolvePromise, reject) => {
    if (closed) { reject(new Error('ABAB worker control socket is closed')); return }
    const id = nextId++
    pending.set(id, { resolve: resolvePromise, reject })
    socket.write(protocolLine({ ...message, id }), error => { if (error) rejectAll(error) })
  })
  const readyValue = await ready
  if (!readyValue?.ready || typeof readyValue.revision !== 'string') throw new Error('ABAB worker readiness receipt is invalid')
  return { socket, request, ready: readyValue }
}

function spawnWorker(directory, side, roundDirectory, batches) {
  const workerRoot = resolve(directory)
  const socketPath = join(roundDirectory, `${side}.sock`)
  const readyPath = join(roundDirectory, `${side}.ready.json`)
  const log = createWriteStream(join(roundDirectory, `${side}-worker.log`))
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workerRoot, encoding: 'utf8' }).trim()
  const vitest = join(workerRoot, 'node_modules/vitest/vitest.mjs')
  const child = spawn(process.execPath, [vitest, 'run', 'scripts/performance-abab-worker.test.ts', '--maxWorkers=1'], {
    cwd: workerRoot,
    env: {
      ...process.env,
      SCRY_ABAB_WORKER: '1',
      SCRY_ABAB_SIDE: side,
      SCRY_ABAB_REVISION: revision,
      SCRY_ABAB_CONTROL_SOCKET: socketPath,
      SCRY_ABAB_READY_FILE: readyPath,
      SCRY_ABAB_BATCHES: String(batches)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.once('close', () => log.end())
  return { child, socketPath, readyPath }
}

async function stopWorker(worker, force = false) {
  if (!worker) return { exitCode: null, signalCode: null }
  if (force && worker.child.exitCode === null && worker.child.signalCode === null && !worker.child.killed) worker.child.kill('SIGTERM')
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    const [exitCode, signalCode] = await once(worker.child, 'close')
    return { exitCode, signalCode }
  }
  return { exitCode: worker.child.exitCode, signalCode: worker.child.signalCode }
}

export async function runAbab(options) {
  const roundDirectory = resolve(options.output)
  mkdirSync(roundDirectory, { recursive: true })
  const baseline = spawnWorker(options.baseline, 'baseline', roundDirectory, options.batches)
  const candidate = spawnWorker(options.candidate, 'candidate', roundDirectory, options.batches)
  let baselineClient
  let candidateClient
  let status = 'completed'
  const errors = []
  try {
    baselineClient = await connectWorker(baseline.socketPath, baseline.readyPath, baseline.child)
    candidateClient = await connectWorker(candidate.socketPath, candidate.readyPath, candidate.child)
    if (baselineClient.ready.harness !== candidateClient.ready.harness) throw new Error('ABAB frozen harness identity differs between sides')
    for (const ready of [baselineClient.ready, candidateClient.ready]) {
      if (!/^[0-9a-f]{40}$/.test(ready.revision)) throw new Error(`ABAB revision is unavailable: ${ready.revision}`)
      if (JSON.stringify([...ready.scenarios].sort()) !== JSON.stringify([...scenarios].sort())) throw new Error('ABAB scenario coverage differs from policy')
    }
    const plan = batchPlan(scenarios, options.batches)
    await runBatchPlan(plan, { baseline: baselineClient, candidate: candidateClient })
  } catch (error) {
    status = 'failed'
    errors.push(error instanceof Error ? error.message : String(error))
  }
  for (const [name, client, worker] of [['baseline', baselineClient, baseline], ['candidate', candidateClient, candidate]]) {
    let finishFailed = false
    if (!client) {
      status = 'failed'
      errors.push(`${name} worker never became ready`)
    } else {
      try {
        await client.request({ op: 'finish', output: join(roundDirectory, `${name}.json`) })
      } catch (error) {
        finishFailed = true
        status = 'failed'
        errors.push(`${name} finish: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (finishFailed) client.socket.destroy()
      else client.socket.end()
    }
    let exit
    try {
      exit = await stopWorker(worker, !client || finishFailed)
    } catch (error) {
      status = 'failed'
      errors.push(`${name} cleanup: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (client && !finishFailed && (exit.exitCode !== 0 || exit.signalCode !== null)) {
      status = 'failed'
      errors.push(`${name} worker exited unsuccessfully: code=${exit.exitCode ?? 'null'} signal=${exit.signalCode ?? 'null'}`)
    }
    if (client && !finishFailed) {
      try {
        validateBatchSamples(JSON.parse(readFileSync(join(roundDirectory, `${name}.json`), 'utf8')).results, scenarios, options.batches)
      } catch (error) {
        status = 'failed'
        errors.push(`${name} artifact: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const summary = { schema: 1, status, errors, scenarios, batches: options.batches, order: 'A1,B1...A20,B20 per scenario' }
  writeFileSync(join(roundDirectory, 'summary.json'), JSON.stringify(summary, null, 2))
  return status === 'completed'
}

export async function runBatchPlan(plan, clients) {
  for (const item of plan) {
    for (const request of item.requests) {
      const value = await clients[request.side].request({ op: 'batch', scenario: item.scenario, batchId: request.batchId })
      if (value.side !== request.side || value.scenario !== item.scenario || value.batchId !== request.batchId) throw new Error(`ABAB response identity mismatch for ${item.scenario}/${request.batchId}`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseAbabArgs(process.argv.slice(2))
    const ok = await runAbab(options)
    if (!ok) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  }
}
