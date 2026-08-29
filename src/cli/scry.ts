#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderId } from '../shared/provider.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'
import { recorderDaemonStatus, serveRecorderDaemon, startRecorderDaemon, stopRecorderDaemon } from '../core/turn-recorder/daemon.js'
import { handleRecorderHook, recoverRecorder, recorderEnablement, refreshRecorderPendingHealth } from '../core/turn-recorder/recorder.js'
import { RECORDER_VERSION, exportRecords, listRecords, readHealth, recordError, showRecord, verifyStore } from '../core/turn-recorder/store.js'
import { compactModelTiming, summarizeTurnRecords, turnTimeline } from '../core/turn-recorder/turns-summary.js'
import { installPiIntegration, piIntegrationStatus } from './pi-integration.js'
import {
  consumeUpdateNotice,
  runBackgroundUpdate,
  scheduleBackgroundUpdate,
  shouldScheduleAutoUpdate,
  upgradeCli
} from './update.js'

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

const VALUE_FLAGS = new Set(['workspace', 'provider', 'event', 'socket', 'after', 'limit', 'snapshot'])
const BOOLEAN_FLAGS = new Set(['all', 'check', 'help', 'json', 'managed', 'no-update-check', 'quiet', 'start-daemon', 'stdin', 'verbose', 'version'])

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '-h') {
      flags.set('help', true)
      continue
    }
    if (value.startsWith('-') && !value.startsWith('--')) throw new Error(`unknown option: ${value}`)
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const equals = value.indexOf('=')
    const key = value.slice(2, equals > 2 ? equals : undefined)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equals > 2) throw new Error(`--${key} does not accept a value`)
      flags.set(key, true)
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown option: --${key}`)
    const next = equals > 2 ? value.slice(equals + 1) : argv[index + 1]
    if (!next || (equals < 0 && next.startsWith('--'))) throw new Error(`missing value for --${key}`)
    flags.set(key, next)
    if (equals < 0) index++
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
  if (!value || !['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(value)) throw new Error('--provider must be claude|codex|qoder|opencode|pi')
  return value as ProviderId
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function helpText(): string {
  return `Scry CLI\n\nUsage:\n  scry recorder hook|recover|start|serve|status|stop|restart [options]\n  scry turns list|show|timeline|summary|export|verify [options]\n  scry doctor [--workspace <root>]\n  scry integrations install-pi|status-pi\n  scry upgrade [--check]\n  scry version\n\nOptions:\n  --workspace <root>   Workspace root (also accepts --workspace=<root>)\n  --help, -h           Show help\n  --version            Show version\n`
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
  const verbose = args.flags.has('verbose') && !quiet
  const workspace = workspaceOf(args)
  let delegatedToCore = false
  try {
    const source = await readStdin()
    const payload = source.trim() ? JSON.parse(source) as Record<string, unknown> : {}
    const event = flag(args, 'event')
    if (!event) throw new Error('--event is required')
    const provider = providerOf(args)
    delegatedToCore = true
    const result = await handleRecorderHook({
      provider,
      event,
      workspace,
      payload,
      managed: args.flags.has('managed')
    })
    if (args.flags.has('start-daemon') && result.status !== 'disabled') {
      const scriptPath = process.argv[1]
      if (scriptPath) await startRecorderDaemon({ workspace, scriptPath, waitForReady: false }).catch(() => undefined)
    }
    if (verbose) print(result)
  } catch (error) {
    const enablement = await recorderEnablement(workspace).catch(() => null)
    if (!delegatedToCore && enablement?.enabled) await recordError(enablement.dataRoot, error)
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
      compactions: record.compactions?.value?.length ?? null,
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
    if (!record) {
      print({ found: false, selector })
      return 1
    }
    print(record)
    return 0
  }
  if (action === 'timeline') {
    const selector = args.positionals[2]
    if (!selector) throw new Error('usage: scry turns timeline <sequence|recordId> --workspace <root>')
    const record = await showRecord(dataRoot, selector)
    if (!record) {
      print({ found: false, selector })
      return 1
    }
    print(turnTimeline(record))
    return 0
  }
  if (action === 'summary') {
    if (args.positionals[2] && args.flags.has('all')) {
      throw new Error('scry turns summary accepts either <sessionId> or --all, not both')
    }
    const records = await listRecords(dataRoot)
    const sessionId = args.positionals[2] ?? (args.flags.has('all') ? undefined : records.at(-1)?.sessionId)
    print(summarizeTurnRecords(records, sessionId, args.flags.has('all') ? { scope: 'workspace' } : {}))
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
  throw new Error('usage: scry turns list|show|timeline|summary [sessionId|--all]|export|verify ...')
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
  const degraded = !!health.lastError || health.pendingCount > 0
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

async function integrationsCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[1]
  if (action === 'install-pi') {
    print(await installPiIntegration())
    return 0
  }
  if (action === 'status-pi') {
    const status = await piIntegrationStatus()
    print(status)
    return status.installed ? 0 : 1
  }
  throw new Error('usage: scry integrations install-pi|status-pi')
}

async function upgradeCommand(args: ParsedArgs): Promise<number> {
  if (process.env.SCRY_CLI_BUNDLED === '1') {
    print({
      status: 'managed_by_app',
      currentVersion: RECORDER_VERSION,
      message: 'Scry App 内置 CLI 随 App 一起升级'
    })
    return 0
  }
  const result = await upgradeCli({
    currentVersion: RECORDER_VERSION,
    entryPath: process.argv[1],
    checkOnly: args.flags.has('check'),
    allowBreaking: !args.flags.has('check')
  })
  print(result)
  return result.status === 'error' ? 1 : 0
}

export async function runScryCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.flags.has('version') || args.positionals[0] === 'version') {
    process.stdout.write(`${RECORDER_VERSION}\n`)
    return 0
  }
  if (args.flags.has('help') || args.positionals[0] === 'help' || args.positionals.length === 0) {
    process.stdout.write(helpText())
    return 0
  }
  switch (args.positionals[0]) {
    case '__auto_update':
      {
        const result = await runBackgroundUpdate(
          process.env.SCRY_UPDATE_CURRENT_VERSION ?? RECORDER_VERSION,
          process.argv[1]
        )
        if (result?.status === 'updated' && result.latestVersion) {
          process.stderr.write(`Scry CLI 已自动更新：${result.currentVersion} → ${result.latestVersion}\n`)
        }
        return 0
      }
    case 'recorder': return recorderCommand(args)
    case 'turns': return turnsCommand(args)
    case 'doctor': return doctorCommand(args)
    case 'integrations': return integrationsCommand(args)
    case 'upgrade': return upgradeCommand(args)
    default:
      throw new Error('usage: scry recorder|turns|doctor|integrations|upgrade ...')
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsedCliArgs: ParsedArgs
  try {
    parsedCliArgs = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`scry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  const autoUpdateEligible = shouldScheduleAutoUpdate({
    command: parsedCliArgs.positionals[0],
    action: parsedCliArgs.positionals[1],
    noUpdateCheck: parsedCliArgs.flags.has('no-update-check'),
    stderrIsTTY: process.stderr.isTTY === true
  })
  try {
    if (autoUpdateEligible) {
      const notice = await consumeUpdateNotice()
      if (notice) process.stderr.write(`${notice}\n`)
    }
    process.exitCode = await runScryCli(argv)
  } catch (error) {
    process.stderr.write(`scry: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    if (autoUpdateEligible) await scheduleBackgroundUpdate(RECORDER_VERSION, process.argv[1])
  }
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {}
if (isMain) await main()
