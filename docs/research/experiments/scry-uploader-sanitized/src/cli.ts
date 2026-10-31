#!/usr/bin/env node
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { VERSION } from './constants.js'
import { doctorWorkspace, initWorkspace } from './init.js'
import { enqueueWakeup, notifyRecordCommit, runQueueWorker, validateNotification } from './queue.js'
import {
  installScheduler,
  recoverRegistered,
  registerWorkspace,
  schedulerStatus,
  unregisterWorkspace
} from './scheduler.js'
import {
  localUploadStatus,
  migrateLegacy,
  pruneAckedBodies,
  releaseDisabled,
  runUpload,
  setUploadPolicy
} from './uploader.js'

async function canonicalWorkspace(path: string): Promise<string> {
  const root = await realpath(path)
  if (!(await stat(root)).isDirectory()) throw new Error('workspace is not a directory')
  return root
}

interface Args {
  positionals: string[]
  values: Map<string, string>
  flags: Set<string>
}
function parseArgs(argv: string[]): Args {
  const positionals: string[] = []
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i]
    if (!current.startsWith('--')) {
      positionals.push(current)
      continue
    }
    const equal = current.indexOf('=')
    if (equal > 2) {
      values.set(current.slice(2, equal), current.slice(equal + 1))
      continue
    }
    const name = current.slice(2)
    if (['workspace', 'providers', 'record-id', 'release-disabled'].includes(name)) {
      const next = argv[++i]
      if (!next) throw new Error(`--${name} 缺少值`)
      values.set(name, next)
    } else flags.add(name)
  }
  return { positionals, values, flags }
}
function help(): string {
  return `scry-upload ${VERSION}

Usage:
  scry-upload init [--providers claude,codex,qoder,opencode] [--json]
  scry-upload notify [--workspace ROOT] < stdin-event.json
  scry-upload wakeup --workspace ROOT
  scry-upload flush --workspace ROOT [--release-disabled RECORD_ID]
  scry-upload migrate --workspace ROOT
  scry-upload prune --workspace ROOT
  scry-upload doctor|status [--workspace ROOT] [--json]
  scry-upload register|unregister [--workspace ROOT]
  scry-upload enable|disable [--workspace ROOT]
  scry-upload scheduler-install|scheduler-status [--json]
`
}
async function readStdin(limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk)
    size += b.length
    if (size > limit) throw new Error('stdin exceeds limit')
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}
function print(value: unknown, json: boolean): void {
  process.stdout.write(`${json || typeof value !== 'string' ? JSON.stringify(value, null, 2) : value}\n`)
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const command = args.positionals[0]
  if (args.flags.has('version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (!command || args.flags.has('help') || command === 'help') {
    process.stdout.write(help())
    return 0
  }
  const json = args.flags.has('json')
  if (command === 'notify') {
    const value = JSON.parse(await readStdin())
    const canonical = validateNotification(value)
    const explicit = args.values.get('workspace')
    const workspace = await canonicalWorkspace(canonical.workspace)
    if (explicit !== undefined && (await canonicalWorkspace(explicit)) !== workspace)
      throw new Error('notification workspace does not match --workspace')
    await notifyRecordCommit(workspace, { ...canonical, workspace })
    return 0
  }
  const workspaceInput = resolve(args.values.get('workspace') ?? process.cwd())
  if (command === 'init') {
    const result = await initWorkspace(workspaceInput, args.values.get('providers'))
    if (json) print(result, true)
    else print(`Scry 上传链路已初始化：${result.workspace}`, false)
    return 0
  }
  if (command === 'unregister') {
    await unregisterWorkspace(workspaceInput)
    return 0
  }
  const workspace = await canonicalWorkspace(workspaceInput)
  if (command === 'doctor') {
    const result = await doctorWorkspace(workspace)
    print(result, json)
    return result.healthy ? 0 : 4
  }
  if (command === 'status') {
    print(await localUploadStatus(workspace), json)
    return 0
  }
  if (command === 'register') {
    print({ workspace: await registerWorkspace(workspace) }, json)
    return 0
  }
  if (command === 'enable' || command === 'disable') {
    print(await setUploadPolicy(workspace, command === 'enable'), json)
    return 0
  }
  if (command === 'scheduler-install') {
    print(await installScheduler(), json)
    return 0
  }
  if (command === 'scheduler-status') {
    print(await schedulerStatus(), true)
    return 0
  }
  if (command === 'migrate') {
    print(await migrateLegacy(workspace), json)
    return 0
  }
  if (command === 'prune') {
    print({ pruned: await pruneAckedBodies(workspace) }, json)
    return 0
  }
  if (command === 'flush') {
    const release = args.values.get('release-disabled') ?? args.values.get('record-id')
    if (release) {
      await releaseDisabled(workspace, release)
      return 0
    }
    print(await runUpload(workspace, { mode: 'flush' }), json)
    return 0
  }
  if (command === 'wakeup') {
    await enqueueWakeup(workspace)
    return 0
  }
  if (command === '_record-committed') {
    const notification = validateNotification(JSON.parse(await readStdin()), workspace)
    await notifyRecordCommit(workspace, notification)
    return 0
  }
  if (command === '_wakeup') {
    await enqueueWakeup(workspace)
    return 0
  }
  if (command === '_worker') {
    await runQueueWorker(workspace)
    return 0
  }
  if (command === '_recover') {
    await recoverRegistered()
    return 0
  }
  throw new Error(`未知命令：${command}`)
}
try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`scry-upload: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
