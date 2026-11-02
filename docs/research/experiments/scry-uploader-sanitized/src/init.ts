import { chmod, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { actorIdentity, ensureTransportInstalled, toolArgumentStyle } from './transport.js'
import { PROVIDERS, VERSION } from './constants.js'
import { enqueueWakeup } from './queue.js'
import { registerWorkspace } from './scheduler.js'
import { bundledScryEntrypoint, runScry, safeSnapshotMaxSequence, uploaderEntrypoint, verifyScryVersion } from './scry.js'
import { initializeUploadState, localUploadStatus, prepareUploadRoot, uploadRoot } from './uploader.js'
import {
  ensurePrivateDirectory,
  exactGitRoot,
  object,
  readJson,
  writeFileAtomic,
  writeJsonAtomic
} from './util.js'

const UPLOADER_MARKER = 'Managed by scry-upload'
const SCRY_MARKER = 'SCRY_HANDLER_ID=turn-recorder-v1'
// Entry written by versions that ignored `dataDir`. It stays recognized so an
// existing workspace can be re-initialized instead of rejected.
const LEGACY_RUNTIME_ENTRY = '.scry/upload/runtime/record-committed'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function launcherSource(workspace: string, action: 'notify' | 'wakeup', transportPath: string): string {
  return `#!/bin/sh
export TRANSPORT_CLI_PATH=${shellQuote(transportPath)}
exec ${shellQuote(process.execPath)} ${shellQuote(uploaderEntrypoint())} ${action} --workspace ${shellQuote(workspace)}
`
}

function wrapperSource(workspace: string, runtimeEntry: string, transportPath: string): string {
  // The runtime path follows the configured dataDir, so it is user content: hold
  // it in a quoted variable instead of splicing it into the command word, where
  // $() or a backtick would still expand inside double quotes.
  return `#!/bin/sh
# ${UPLOADER_MARKER} ${VERSION}
set -u
workspace=${shellQuote(workspace)}
runtime=${shellQuote(runtimeEntry)}
export TRANSPORT_CLI_PATH=${shellQuote(transportPath)}
"$workspace/.scry/provider-hook-scry.sh" "$@"
hook_status=$?
case "\${2:-}" in
  UserPromptSubmit|Stop)
    "$workspace/$runtime/wakeup" </dev/null >/dev/null 2>&1 || true
    ;;
esac
exit "$hook_status"
`
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function ensureCommitHook(workspace: string, runtimeEntry: string): Promise<void> {
  const path = join(workspace, 'scry.config.json')
  const config = await readJson<Record<string, unknown>>(path)
  if (!config) throw new Error(`${path} 不存在`)
  // The hook entry must point at this workspace's own uploader runtime, which
  // follows the configured dataDir rather than a fixed .scry path.
  const managed = { entry: `${runtimeEntry}/record-committed`, files: [`${runtimeEntry}/record-committed`] }
  const known = [managed.entry, LEGACY_RUNTIME_ENTRY]
  const current = object(config.commitHook)
  if (current) {
    if (
      !known.includes(String(current.entry)) ||
      !Array.isArray(current.files) ||
      !current.files.some((entry) => known.includes(String(entry)))
    )
      throw new Error(`${path} 已配置其他 commitHook；scry-upload 不会覆盖它`)
    if (current.entry === managed.entry && current.files.includes(managed.entry)) return
    await writeJsonAtomic(path, { ...config, commitHook: managed })
    return
  }
  await writeJsonAtomic(path, { ...config, commitHook: managed })
}

async function assertBridgeOwnership(workspace: string): Promise<void> {
  const path = join(workspace, '.scry', 'provider-hook.sh')
  const source = await readOptional(path)
  if (source && !source.includes(SCRY_MARKER) && !source.includes(UPLOADER_MARKER)) {
    throw new Error(`${path} 已存在且不由 Scry/scry-upload 管理`)
  }
}

export interface InitResult {
  workspace: string
  providers: string[]
  transportPath: string
  baselineSequence: number
  changedFiles: string[]
  codexTrustRequired: boolean
}

export async function initWorkspace(
  workspaceInput: string,
  providers?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<InitResult> {
  const workspace = await exactGitRoot(workspaceInput)
  if (providers) {
    const requested = providers.split(/[\s,]+/).filter(Boolean)
    if (requested.includes('pi'))
      throw new Error('Pi 不通过 scry-upload init 配置；请使用 Scry 的独立 Pi 集成或宿主适配器')
    const invalid = requested.filter(
      (provider) => !PROVIDERS.includes(provider as (typeof PROVIDERS)[number])
    )
    if (invalid.length) throw new Error(`不支持的 Provider：${invalid.join('、')}`)
  }
  await verifyScryVersion(workspace, env)
  const transportPath = await ensureTransportInstalled(env)
  await actorIdentity(env)
  await toolArgumentStyle(env)
  await assertBridgeOwnership(workspace)

  const args = ['init', '--workspace', workspace, '--json']
  if (providers) args.push('--providers', providers)
  const scryResult = JSON.parse(await runScry(args, workspace, { env, timeoutMs: 60_000 })) as Record<
    string,
    unknown
  >
  // Both the hook entry and the launchers live beside the queue, which follows
  // the workspace dataDir. `.scry/provider-hook*.sh` stays in `.scry` because it
  // is Scry's own bridge, not uploader state.
  const runtime = join(uploadRoot(workspace), 'runtime')
  const runtimeEntry = relative(workspace, runtime)
  await ensureCommitHook(workspace, runtimeEntry)
  const providerList = Array.isArray(scryResult.providers) ? scryResult.providers.map(String) : []
  const bridgePath = join(workspace, '.scry', 'provider-hook.sh')
  const scryBridge = await readFile(bridgePath, 'utf8')
  if (!scryBridge.includes(SCRY_MARKER)) throw new Error('Scry init 未生成预期的 Provider bridge')

  await prepareUploadRoot(workspace)
  await ensurePrivateDirectory(runtime, false)
  const recorderLauncher = join(runtime, 'record-committed')
  const wakeupLauncher = join(runtime, 'wakeup')
  const originalBridge = join(workspace, '.scry', 'provider-hook-scry.sh')
  await writeFileAtomic(recorderLauncher, launcherSource(workspace, 'notify', transportPath), 0o700)
  await writeFileAtomic(wakeupLauncher, launcherSource(workspace, 'wakeup', transportPath), 0o700)
  await writeFileAtomic(originalBridge, scryBridge, 0o700)
  await writeFileAtomic(bridgePath, wrapperSource(workspace, runtimeEntry, transportPath), 0o700)
  await Promise.all(
    [recorderLauncher, wakeupLauncher, originalBridge, bridgePath].map((path) => chmod(path, 0o700))
  )

  const beforeState = await localUploadStatus(workspace)
  const baselineSequence =
    beforeState.initialized === true
      ? Number(beforeState.enqueuedThrough ?? 0)
      : await safeSnapshotMaxSequence(workspace, env)
  await initializeUploadState(workspace, baselineSequence)
  await registerWorkspace(workspace, env)
  await enqueueWakeup(workspace, env)
  return {
    workspace,
    providers: providerList,
    transportPath,
    baselineSequence,
    changedFiles: [bridgePath, originalBridge, recorderLauncher, wakeupLauncher],
    codexTrustRequired: scryResult.codexTrustRequired === true
  }
}

export async function doctorWorkspace(
  workspaceInput: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  healthy: boolean
  workspace: string
  checks: Record<string, unknown>
}> {
  const workspace = await exactGitRoot(workspaceInput)
  const checks: Record<string, unknown> = {}
  const capture = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      checks[name] = { ok: true, value: await action() }
    } catch (error) {
      checks[name] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
  await capture('scry', async () => {
    const version = await verifyScryVersion(workspace, env)
    return { version, entrypoint: env.SCRY_CLI_PATH ?? bundledScryEntrypoint() }
  })
  await capture('bridge', async () => {
    const source = await readFile(join(workspace, '.scry', 'provider-hook.sh'), 'utf8')
    const original = await readFile(join(workspace, '.scry', 'provider-hook-scry.sh'), 'utf8')
    if (!source.includes(UPLOADER_MARKER) || !original.includes(SCRY_MARKER))
      throw new Error('Provider bridge 未由 scry-upload 管理')
    for (const name of ['record-committed', 'wakeup']) {
      const metadata = await stat(join(uploadRoot(workspace), 'runtime', name))
      if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error(`${name} launcher 不可执行`)
    }
    return 'configured'
  })
  await capture('actor', async () => {
    const actor = await actorIdentity(env)
    return { userId: actor.userId, nick: actor.nick }
  })
  await capture('mcp', async () => ({
    server: 'agent-trace-service',
    tool: 'submitTurns',
    argumentStyle: await toolArgumentStyle(env)
  }))
  await capture('upload', async () => await localUploadStatus(workspace))
  const healthy = Object.values(checks).every((check) => object(check)?.ok === true)
  return { healthy, workspace, checks }
}

export function isUploaderBridge(source: string): boolean {
  return source.includes(UPLOADER_MARKER)
}
