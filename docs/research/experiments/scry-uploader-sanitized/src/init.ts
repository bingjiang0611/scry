import { chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { actorIdentity, ensureTransportInstalled, toolArgumentStyle } from './transport.js'
import { PROVIDERS, VERSION } from './constants.js'
import { enqueueWakeup } from './queue.js'
import { bundledScryEntrypoint, runScry, uploaderEntrypoint, verifyScryVersion } from './scry.js'
import { initializeUploadState, localUploadStatus, prepareUploadRoot } from './uploader.js'
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function launcherSource(workspace: string, action: 'notify' | 'wakeup', transportPath: string): string {
  return `#!/bin/sh
export TRANSPORT_CLI_PATH=${shellQuote(transportPath)}
exec ${shellQuote(process.execPath)} ${shellQuote(uploaderEntrypoint())} ${action} --workspace ${shellQuote(workspace)}
`
}

function wrapperSource(workspace: string, transportPath: string): string {
  return `#!/bin/sh
# ${UPLOADER_MARKER} ${VERSION}
set -u
workspace=${shellQuote(workspace)}
export TRANSPORT_CLI_PATH=${shellQuote(transportPath)}
"$workspace/.scry/provider-hook-scry.sh" "$@"
hook_status=$?
case "\${2:-}" in
  UserPromptSubmit|Stop)
    "$workspace/.scry/upload/runtime/wakeup" </dev/null >/dev/null 2>&1 || true
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

async function ensureCommitHook(workspace: string): Promise<void> {
  const path = join(workspace, 'scry.config.json')
  const config = await readJson<Record<string, unknown>>(path)
  if (!config) throw new Error(`${path} 不存在`)
  const managed = {
    entry: '.scry/upload/runtime/record-committed',
    files: ['.scry/upload/runtime/record-committed']
  }
  const current = object(config.commitHook)
  if (current) {
    if (
      current.entry !== managed.entry ||
      !Array.isArray(current.files) ||
      !current.files.includes(managed.entry)
    )
      throw new Error(`${path} 已配置其他 commitHook；scry-upload 不会覆盖它`)
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
  await ensureCommitHook(workspace)
  const providerList = Array.isArray(scryResult.providers) ? scryResult.providers.map(String) : []
  const bridgePath = join(workspace, '.scry', 'provider-hook.sh')
  const scryBridge = await readFile(bridgePath, 'utf8')
  if (!scryBridge.includes(SCRY_MARKER)) throw new Error('Scry init 未生成预期的 Provider bridge')

  await prepareUploadRoot(workspace)
  const runtime = join(workspace, '.scry', 'upload', 'runtime')
  await ensurePrivateDirectory(runtime, false)
  const recorderLauncher = join(runtime, 'record-committed')
  const wakeupLauncher = join(runtime, 'wakeup')
  const originalBridge = join(workspace, '.scry', 'provider-hook-scry.sh')
  await writeFileAtomic(recorderLauncher, launcherSource(workspace, 'notify', transportPath), 0o700)
  await writeFileAtomic(wakeupLauncher, launcherSource(workspace, 'wakeup', transportPath), 0o700)
  await writeFileAtomic(originalBridge, scryBridge, 0o700)
  await writeFileAtomic(bridgePath, wrapperSource(workspace, transportPath), 0o700)
  await Promise.all(
    [recorderLauncher, wakeupLauncher, originalBridge, bridgePath].map((path) => chmod(path, 0o700))
  )

  const beforeState = await localUploadStatus(workspace)
  const baselineSequence = beforeState.initialized === true ? Number(beforeState.enqueuedThrough ?? 0) : 0
  await initializeUploadState(workspace, baselineSequence)
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
      const metadata = await stat(join(workspace, '.scry', 'upload', 'runtime', name))
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
