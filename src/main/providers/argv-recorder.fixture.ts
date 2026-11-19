import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthorizedMcpExecution } from './types'

/** Secret values a fixture MCP config carries; none may appear in a Provider's argv. */
export const MCP_SECRET_VALUES = ['hdr-secret-1', 'env-secret-2', 'bearer-secret-3'] as const

export const secretMcpTargets: AuthorizedMcpExecution['targets'] = [
  {
    targetId: 'remote',
    name: 'remote',
    enabled: true,
    config: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { 'X-Api-Key': 'hdr-secret-1' } }
  },
  {
    targetId: 'local',
    name: 'local',
    enabled: true,
    config: { command: '/bin/echo', args: ['ok'], env: { API_KEY: 'env-secret-2' } }
  }
]

export interface ArgvRecord {
  argv: string[]
  /** The `--mcp-config` document, read from the file when the value is a path. */
  config: unknown
  configPath?: string
  fileMode?: number
  directoryMode?: number
}

/**
 * A stand-in CLI that records the argv it was launched with, then exits 1. Both
 * SDKs spawn whatever executable they are given, so this captures the exact
 * arguments the real SDK code path builds, without network or a real Provider.
 */
export function createArgvRecorder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-argv-recorder-')))
  const recordPath = join(root, 'record.json')
  const executable = join(root, 'fake-cli')
  writeFileSync(executable, `#!${process.execPath}
const { readFileSync, statSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')
const argv = process.argv.slice(2)
const index = argv.indexOf('--mcp-config')
const record = { argv, config: null }
if (index >= 0) {
  const value = argv[index + 1]
  if (value.trim().startsWith('{')) record.config = JSON.parse(value)
  else {
    record.config = JSON.parse(readFileSync(value, 'utf8'))
    record.configPath = value
    record.fileMode = statSync(value).mode & 0o777
    record.directoryMode = statSync(dirname(value)).mode & 0o777
  }
}
writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record))
process.exit(1)
`)
  chmodSync(executable, 0o700)
  return {
    root,
    executable,
    recorded: (): boolean => existsSync(recordPath),
    record: (): ArgvRecord => JSON.parse(readFileSync(recordPath, 'utf8')) as ArgvRecord,
    cleanup: (): void => rmSync(root, { recursive: true, force: true })
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the recorded launch')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export function leakedSecrets(argv: string[], secrets: readonly string[] = MCP_SECRET_VALUES): string[] {
  const joined = argv.join('\n')
  return secrets.filter((secret) => joined.includes(secret))
}
