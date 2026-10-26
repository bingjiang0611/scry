import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import type { ProviderId } from '../shared/provider.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'


export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

export const VALUE_FLAGS = new Set(['workspace', 'providers', 'provider', 'event', 'socket', 'after', 'limit', 'offset', 'snapshot', 'before', 'out', 'sequence'])
export const BOOLEAN_FLAGS = new Set(['all', 'all-dead', 'apply', 'check', 'help', 'json', 'managed', 'no-update-check', 'force', 'quiet', 'start-daemon', 'stdin', 'verbose', 'version', 'yes'])

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

export function flag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key)
  return typeof value === 'string' ? value : undefined
}

export function intFlag(args: ParsedArgs, key: string): number | undefined {
  const value = flag(args, key)
  if (value == null) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`--${key} must be a non-negative integer`)
  return number
}

export function workspaceOf(args: ParsedArgs): string {
  const workspace = resolve(flag(args, 'workspace') ?? process.cwd())
  try {
    return realpathSync(workspace)
  } catch {
    return workspace
  }
}

export function providerOf(args: ParsedArgs): ProviderId {
  const value = flag(args, 'provider')
  if (!value || !['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(value)) throw new Error('--provider must be claude|codex|qoder|opencode|pi')
  return value as ProviderId
}

export function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

export async function dataRootOf(workspace: string): Promise<string> {
  const location = await resolveRecorderLocation(workspace)
  if (!location.valid) throw new Error(`recorder storage unavailable: ${location.reason}${location.detail ? ` (${location.detail})` : ''}`)
  return location.dataRoot
}
