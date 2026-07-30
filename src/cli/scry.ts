#!/usr/bin/env node
import { resolve } from 'node:path'
import type { ProviderId } from '../shared/provider.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'
import { recorderDaemonStatus, serveRecorderDaemon, startRecorderDaemon, stopRecorderDaemon } from '../core/turn-recorder/daemon.js'
import { handleRecorderHook, recoverRecorder, recorderEnablement, refreshRecorderPendingHealth } from '../core/turn-recorder/recorder.js'
import { RECORDER_VERSION, exportRecords, listRecords, readHealth, recordError, showRecord, verifyStore } from '../core/turn-recorder/store.js'
import { compactModelTiming, summarizeTurnRecords } from '../core/turn-recorder/turns-summary.js'

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      flags.set(key, next)
      index++
    } else {
      flags.set(key, true)
    }
  }
  return { positionals, flags }
}

function flag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key)
  return typeof value === 'string' ? value : undefined
}

function intFlag(args: ParsedArgs, key: string): number | undefined {
  const value = flag(args, key)
  if (value == null) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`--${key} must be a non-negative integer`)
  return number
}

function workspaceOf(args: ParsedArgs): string {
  return resolve(flag(args, 'workspace') ?? process.cwd())
}

function providerOf(args: ParsedArgs): ProviderId {
  const value = flag(args, 'provider')
  if (!value || !['claude', 'codex', 'qoder', 'opencode'].includes(value)) throw new Error('--provider must be claude|codex|qoder|opencode')
  return value as ProviderId
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

async function dataRootOf(workspace: string): Promise<string> {
  const location = await resolveRecorderLocation(workspace)
  if (!location.valid) throw new Error(`recorder storage unavailable: ${location.reason}${location.detail ? ` (${location.detail})` : ''}`)
  return location.dataRoot
}

async function hookCommand(args: ParsedArgs): Promise<number> {
  const quiet = args.flags.has('quiet')
  const workspace = workspaceOf(args)
  try {
    const source = await readStdin()
    const payload = source.trim() ? JSON.parse(source) as Record<string, unknown> : {}
    const event = flag(args, 'event')
    if (!event) throw new Error('--event is required')
    const result = await handleRecorderHook({
      provider: providerOf(args),
      event,
      workspace,
      payload,
      managed: args.flags.has('managed')
    })
    if (args.flags.has('start-daemon') && result.status !== 'disabled') {
      const scriptPath = process.argv[1]
      if (scriptPath) await startRecorderDaemon({ workspace, scriptPath, waitForReady: false }).catch(() => undefined)
    }
    if (!quiet) print(result)
  } catch (error) {
    const enablement = await recorderEnablement(workspace).catch(() => null)
    if (enablement?.enabled) await recordError(enablement.dataRoot, error)
    if (!quiet) process.stderr.write(`scry recorder hook: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  // Hook mode is observational and must never block the Provider.
  return 0
}

async function recorderCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  if (action === 'hook') return hookCommand(args)
  if (action === 'recover') {
    print(await recoverRecorder(workspaceOf(args)))
    return 0
  }
  if (action === 'serve') {
    await serveRecorderDaemon({ workspace: workspaceOf(args), socketPath: flag(args, 'socket') })
    return 0
  }
  if (action === 'status') {
    print(await recorderDaemonStatus(workspaceOf(args)))
    return 0
  }
  if (action === 'stop') {
    print({ stopped: await stopRecorderDaemon(workspaceOf(args)) })
    return 0
  }
  if (action === 'start' || action === 'restart') {
    const workspace = workspaceOf(args)
    if (action === 'restart') await stopRecorderDaemon(workspace)
    const scriptPath = process.argv[1]
    if (!scriptPath) throw new Error('cannot locate scry CLI entrypoint')
    const result = await startRecorderDaemon({ workspace, scriptPath })
    if (!args.flags.has('quiet')) print(result)
    return 0
  }
  throw new Error('usage: scry recorder hook|recover|start|serve|status|stop|restart ...')
}

async function turnsCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  const dataRoot = await dataRootOf(workspaceOf(args))
  if (action === 'list') {
    const records = await listRecords(dataRoot)
    print(records.map((record) => ({
      sequence: record.sequence,
      recordId: record.recordId,
      provider: record.provider.id,
      sessionId: record.sessionId,
      turnIndex: record.turnIndex,
      status: record.status,
      durationMs: record.durationMs,
      modelTiming: compactModelTiming(record),
      startedAt: record.startedAt,
      completedAt: record.completedAt
    })))
    return 0
  }
  if (action === 'show') {
    const selector = args.positionals[2]
    if (!selector) throw new Error('usage: scry turns show <sequence|recordId> --workspace <root>')
    const record = await showRecord(dataRoot, selector)
    if (!record) return 4
    print(record)
    return 0
  }
  if (action === 'summary') {
    print(summarizeTurnRecords(await listRecords(dataRoot), args.positionals[2]))
    return 0
  }
  if (action === 'export') {
    print(await exportRecords(dataRoot, {
      after: intFlag(args, 'after'),
      limit: intFlag(args, 'limit'),
      snapshotMaxSequence: intFlag(args, 'snapshot')
    }))
    return 0
  }
  if (action === 'verify') {
    const result = await verifyStore(dataRoot)
    print(result)
    return result.ok ? 0 : 4
  }
  throw new Error('usage: scry turns list|show|summary|export|verify ...')
}

async function doctorCommand(args: ParsedArgs): Promise<number> {
  const workspace = workspaceOf(args)
  const enablement = await recorderEnablement(workspace)
  const runtime = {
    recorderVersion: RECORDER_VERSION,
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`
  }
  if (!enablement.enabled) {
    print({ healthy: false, enabled: false, ...runtime, reason: enablement.reason, detail: enablement.detail })
    return enablement.reason === 'invalid_config' || enablement.reason === 'missing_config' ? 3 : 2
  }
  await refreshRecorderPendingHealth(enablement.dataRoot)
  const [health, store] = await Promise.all([readHealth(enablement.dataRoot), verifyStore(enablement.dataRoot)])
  const degraded = !!health.lastError || health.orphanEvents > 0 || health.droppedEvents > 0 || health.pendingCount > 0
  print({
    healthy: store.ok && !degraded,
    enabled: true,
    ...runtime,
    workspace: enablement.workspaceRoot,
    dataRoot: enablement.dataRoot,
    health,
    store
  })
  if (!store.ok) return 4
  return degraded ? 5 : 0
}

export async function runScryCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.flags.has('version') || args.positionals[0] === 'version') {
    process.stdout.write(`${RECORDER_VERSION}\n`)
    return 0
  }
  switch (args.positionals[0]) {
    case 'recorder': return recorderCommand(args)
    case 'turns': return turnsCommand(args)
    case 'doctor': return doctorCommand(args)
    default:
      throw new Error('usage: scry recorder|turns|doctor ...')
  }
}

try {
  process.exitCode = await runScryCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`scry: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
