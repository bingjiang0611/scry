// 扫 PATH 检测本机已安装的 agent CLI（claude code / codex / cursor / …），
// 供 app 的 CLI 选择器（参考 open-design 的 Local CLI 下拉）。

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { RECORDER_VERSION } from '../core/turn-recorder/store.js'
import type { ProviderHealth, ProviderId } from '../shared/provider.js'
import {
  execFileOutcome,
  execFileText,
  nvmBins,
  resolveCommandOnPath,
  shellEnv,
  shellPath,
  shellPathAsync,
  versionProbePath
} from './cli-environment.js'
import { sanitizeProviderEnv } from './provider-env.js'

export {
  execFileOutcome,
  execFileText,
  mergeLoginShellEnv,
  resolveCommandOnPath,
  shellEnv,
  shellEnvError,
  warmShellEnv
} from './cli-environment.js'
export { sanitizeNestedAgentEnv, sanitizeProviderEnv } from './provider-env.js'

export const CODEX_APP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex'

const verifiedRecorderCliVersions = new Set<string>()

function executableOnProcessPath(bin: string): string | undefined {
  return resolveCommandOnPath(bin, process.env.PATH ?? '')
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  return paths.find((path): path is string => !!path && existsSync(path))
}

function fastAgentPath(id: string, bin: string): string | undefined {
  const onProcessPath = executableOnProcessPath(bin)
  if (id === 'claude') {
    const configured = process.env.SCRY_CLAUDE_PATH?.trim()
    return firstExisting([configured, `${homedir()}/.local/bin/claude`, onProcessPath])
  }
  if (id === 'codex') {
    const configured = process.env.SCRY_CODEX_PATH?.trim()
    return firstExisting([configured, onProcessPath, CODEX_APP_BIN])
  }
  if (id === 'qoder') return firstExisting([qoderPathFromEnv(), onProcessPath])
  if (id === 'opencode') {
    const configured = process.env.SCRY_OPENCODE_PATH?.trim()
    return firstExisting([
      configured,
      onProcessPath,
      `${homedir()}/.opencode/bin/opencode`,
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode'
    ])
  }
  // Pi launchers are commonly installed by nvm or under ~/.local/bin. Finder/Dock apps
  // inherit launchd's minimal PATH, so process PATH alone disagrees with the full async
  // detector and can advertise pi:rotom in the UI but fail to resolve it when sending.
  if (id === 'pi:default' || id === 'pi:rotom') return onProcessPath || which(bin)
  return onProcessPath
}

function enrichedPath(): string {
  // shell 真实 PATH 放最前 → 解析顺序和用户终端一致；其后是进程 PATH + 常见位置兜底
  //（nvmBins 排在 ~/.local/bin 前，兜底时也优先 nvm 装的较新 claude）。
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', ...nvmBins(), `${homedir()}/.local/bin`, `${homedir()}/.opencode/bin`]
  return [shellPath(), process.env.PATH ?? '', ...extra].filter(Boolean).join(':')
}

async function enrichedPathAsync(): Promise<string> {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', ...nvmBins(), `${homedir()}/.local/bin`, `${homedir()}/.opencode/bin`]
  return [await shellPathAsync(), process.env.PATH ?? '', ...extra].filter(Boolean).join(':')
}

function which(bin: string): string {
  return resolveCommandOnPath(bin, enrichedPath()) ?? ''
}

async function whichAsync(bin: string): Promise<string> {
  return resolveCommandOnPath(bin, await enrichedPathAsync()) ?? ''
}

export function normalizeAgentVersion(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  return value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? value
}

export function appBundleRootForExecutable(path: string): string | undefined {
  return path.match(/^(.*\.app)\/Contents\//)?.[1]
}

async function appBundleVersionAsync(path: string): Promise<string | undefined> {
  const root = appBundleRootForExecutable(path)
  if (!root) return undefined
  const info = join(root, 'Contents', 'Info.plist')
  if (!existsSync(info)) return undefined
  const version = normalizeAgentVersion(
    await execFileText('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info], { timeout: 1500 })
  )
  return version ? `${version} (app)` : undefined
}

interface AgentVersionProbe {
  version?: string
  health: ProviderHealth
}

export const PI_VERSION_PROBE_TIMEOUT_MS = 15_000

export async function probeCliVersion(
  path: string,
  args: string[] = ['--version'],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<AgentVersionProbe> {
  const timeout = options.timeout ?? 5_000
  const outcome = await execFileOutcome(path, args, {
    env: options.env ?? runtimeCliEnv({ ...(process.env as Record<string, string>), PATH: versionProbePath() }),
    timeout
  })
  const transport = 'CLI version probe'
  if (outcome.error) {
    return { health: { state: 'unavailable', transport, lastError: `版本探测无法启动：${outcome.error}`, lastErrorAt: Date.now() } }
  }
  if (outcome.timedOut) {
    return { health: { state: 'unavailable', transport, lastError: `版本探测超时（${timeout / 1_000}s）`, lastErrorAt: Date.now() } }
  }
  if (outcome.signal) {
    return { health: { state: 'unavailable', transport, lastError: `版本探测被信号 ${outcome.signal} 终止`, lastErrorAt: Date.now() } }
  }
  if (outcome.exitCode !== 0) {
    return { health: { state: 'unavailable', transport, lastError: `版本探测退出码 ${outcome.exitCode ?? 'unknown'}`, lastErrorAt: Date.now() } }
  }
  return {
    version: normalizeAgentVersion(outcome.stdout),
    health: { state: 'ready', transport, lastOkAt: Date.now() }
  }
}

async function agentVersionAsync(
  id: string,
  path: string,
  env?: NodeJS.ProcessEnv
): Promise<AgentVersionProbe> {
  if (id === 'codex') {
    const bundled = await appBundleVersionAsync(path)
    if (bundled) return { version: bundled, health: { state: 'ready', transport: 'App bundle', lastOkAt: Date.now() } }
  }
  return probeCliVersion(
    path,
    id === 'qoder' ? ['-v'] : ['--version'],
    id.startsWith('pi:') ? { env, timeout: PI_VERSION_PROBE_TIMEOUT_MS } : env ? { env } : {}
  )
}

export interface DetectedAgent {
  id: string
  name: string
  bin: string
  path: string
  version?: string
  health?: ProviderHealth
}

// name 是 renderer 使用的 Provider 显示名，bin 才是本地可执行文件名。
// 快速探测和完整 Provider descriptor 必须保持同一显示名，避免冷启动闪变。
const KNOWN_AGENTS: Array<{ id: string; name: string; bin: string }> = [
  { id: 'claude', name: 'Claude Code', bin: 'claude' },
  { id: 'codex', name: 'Codex', bin: 'codex' },
  { id: 'qoder', name: 'Qoder', bin: 'qodercli' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode' },
  { id: 'pi:default', name: 'Pi', bin: 'pi' },
  { id: 'pi:rotom', name: 'Pi · Rotom', bin: 'rotom' }
]

function qoderPathFromEnv(): string {
  const configured = process.env.SCRY_QODERCLI_PATH?.trim()
  return configured && existsSync(configured) ? configured : ''
}

export function isAcceptedQoderPath(path: string): boolean {
  return !!path && path.endsWith('/qodercli')
}

export function selectQoderBinCandidate(args: {
  configured?: string
  onPath?: string
}): string | undefined {
  if (args.configured && isAcceptedQoderPath(args.configured)) return args.configured
  if (args.onPath && isAcceptedQoderPath(args.onPath)) return args.onPath
  return undefined
}

function resolveQoderBin(): string | undefined {
  const configured = qoderPathFromEnv()
  const onPath = which('qodercli')
  return selectQoderBinCandidate({ configured, onPath })
}

async function resolveQoderBinAsync(): Promise<string | undefined> {
  const configured = qoderPathFromEnv()
  const onPath = await whichAsync('qodercli')
  return selectQoderBinCandidate({ configured, onPath })
}

export function selectCodexBinCandidate(args: {
  configured?: string
  configuredExists?: boolean
  onPath?: string
  appBin?: string
  appBinExists?: boolean
}): string | undefined {
  if (args.configured && args.configuredExists) return args.configured
  if (args.onPath) return args.onPath
  return args.appBinExists ? (args.appBin ?? CODEX_APP_BIN) : undefined
}

function resolveCodexBin(): string | undefined {
  const configured = process.env.SCRY_CODEX_PATH?.trim()
  return selectCodexBinCandidate({
    configured,
    configuredExists: !!configured && existsSync(configured),
    onPath: which('codex'),
    appBinExists: existsSync(CODEX_APP_BIN)
  })
}

async function resolveCodexBinAsync(): Promise<string | undefined> {
  const configured = process.env.SCRY_CODEX_PATH?.trim()
  return selectCodexBinCandidate({
    configured,
    configuredExists: !!configured && existsSync(configured),
    onPath: await whichAsync('codex'),
    appBinExists: existsSync(CODEX_APP_BIN)
  })
}

export async function detectAgents(options: {
  versionProbeEnv?: (
    agent: { id: string; name: string; bin: string },
    path: string
  ) => NodeJS.ProcessEnv | undefined | Promise<NodeJS.ProcessEnv | undefined>
} = {}): Promise<DetectedAgent[]> {
  const found = await Promise.all(
    KNOWN_AGENTS.map(async (a): Promise<DetectedAgent | null> => {
      const path =
        fastAgentPath(a.id, a.bin) ??
        (a.id === 'qoder'
          ? await resolveQoderBinAsync()
          : a.id === 'claude'
            ? await resolveClaudeBinAsync()
            : a.id === 'codex'
              ? await resolveCodexBinAsync()
              : await whichAsync(a.bin))
      if (!path) return null
      const env = await options.versionProbeEnv?.(a, path)
      const probe = await agentVersionAsync(a.id, path, env)
      return { ...a, path, version: probe.version, health: probe.health }
    })
  )
  return found.filter((a): a is DetectedAgent => a !== null)
}

// 冷启动首屏只需要知道“可执行文件是否存在”。版本命令可能各耗时数秒，不能让四个
// Provider 互相等待后才一起变绿；完整 detectAgents() 会在后台继续补齐版本和 descriptor。
export function detectAgentsFast(): DetectedAgent[] {
  return KNOWN_AGENTS.flatMap((agent) => {
    const path = fastAgentPath(agent.id, agent.bin)
    return path ? [{ ...agent, path }] : []
  })
}

// 解析「驱动用」的 claude 二进制路径，交给 SDK 的 pathToClaudeCodeExecutable。
// 与 detectAgents 同源（都走 which）：驱动的必须是 app 检测/顶栏显示的那个 claude，
// 否则「显示 2.1.170、实际跑 2.1.150」就成了假状态（违反反假数据规则）。
// npm 全局 / 官方安装器装的 claude 都是原生 Mach-O 二进制（claude.exe 也是 Mach-O，不是脚本），
// 直接 spawn 不需要 node。找不到再回退官方安装器位置 ~/.local/bin/claude。
export function selectClaudeBinCandidate(args: {
  configured?: string
  configuredExists?: boolean
  native: string
  nativeExists: boolean
  onPath?: string
}): string | undefined {
  if (args.configured && args.configuredExists) return args.configured
  if (args.nativeExists) return args.native
  return args.onPath || undefined
}

export function resolveClaudeBin(): string | undefined {
  const configured = process.env.SCRY_CLAUDE_PATH?.trim()
  const native = `${homedir()}/.local/bin/claude`
  return selectClaudeBinCandidate({
    configured,
    configuredExists: !!configured && existsSync(configured),
    native,
    nativeExists: existsSync(native),
    onPath: which('claude')
  })
}

async function resolveClaudeBinAsync(): Promise<string | undefined> {
  const configured = process.env.SCRY_CLAUDE_PATH?.trim()
  const native = `${homedir()}/.local/bin/claude`
  const selected = selectClaudeBinCandidate({
    configured,
    configuredExists: !!configured && existsSync(configured),
    native,
    nativeExists: existsSync(native)
  })
  return selected ?? ((await whichAsync('claude')) || undefined)
}

export function resolveRuntimeCliBin(agentId: 'codex' | 'qoder' | 'opencode'): string | undefined {
  if (agentId === 'qoder') return resolveQoderBin()
  if (agentId === 'codex') return resolveCodexBin()
  const configured = process.env.SCRY_OPENCODE_PATH?.trim()
  if (configured && existsSync(configured)) return configured
  const onPath = which(agentId)
  return onPath || firstExisting([`${homedir()}/.opencode/bin/opencode`, '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'])
}

function recorderFallbackSearchPath(env: Record<string, string>): string {
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX
  const directories = process.platform === 'win32'
    ? [
        env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
        env.PNPM_HOME,
        npmPrefix
      ]
    : [
        env.PNPM_HOME,
        npmPrefix ? join(npmPrefix, 'bin') : undefined,
        join(homedir(), '.local', 'bin'),
        join(homedir(), '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin'
      ]
  return directories.filter((directory): directory is string => !!directory).join(delimiter)
}

export function packagedRecorderCliPath(resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath): string | undefined {
  if (!resourcesPath) return undefined
  const candidate = join(resourcesPath, 'bin', 'scry')
  return existsSync(candidate) ? candidate : undefined
}

export function resolveRecorderCliPath(
  env: Record<string, string>,
  trustedPath: string,
  fallbackPath: string = recorderFallbackSearchPath(env),
  bundledPath: string | undefined = packagedRecorderCliPath()
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, 'SCRY_CLI_PATH')) {
    return env.SCRY_CLI_PATH?.trim() ?? ''
  }
  if (bundledPath) return bundledPath
  return resolveCommandOnPath('scry', trustedPath) ?? resolveCommandOnPath('scry', fallbackPath)
}

function recorderCliVersionKey(path: string): string {
  const file = statSync(path)
  return `${path}\0${file.dev}\0${file.ino}\0${file.size}\0${file.mtimeMs}\0${RECORDER_VERSION}`
}

export function runtimeCliEnv(
  base?: Record<string, string>,
  options: { managedRecorder?: boolean; providerId?: ProviderId } = {}
): Record<string, string> {
  const runtimeBase = base ?? shellEnv()
  const originalPath = base
    ? runtimeBase.PATH ?? process.env.PATH ?? ''
    : shellPath() || process.env.PATH || ''
  const bundledCliPath = packagedRecorderCliPath()
  const scryCliPath = resolveRecorderCliPath(
    runtimeBase,
    originalPath,
    recorderFallbackSearchPath(runtimeBase),
    bundledCliPath
  )
  if (options.managedRecorder) {
    if (!scryCliPath) {
      throw new Error(`Scry managed recorder requires scry CLI ${RECORDER_VERSION}`)
    }
    if (scryCliPath !== bundledCliPath) {
      let verificationKey = ''
      let cached = false
      let actualVersion = ''
      try {
        verificationKey = recorderCliVersionKey(scryCliPath)
        cached = verifiedRecorderCliVersions.has(verificationKey)
        if (!cached) {
          actualVersion = execFileSync(scryCliPath, ['--version'], {
            encoding: 'utf8',
            timeout: 5_000,
            env: sanitizeProviderEnv(runtimeBase, options.providerId)
          }).trim()
        }
      } catch {
        throw new Error(`Scry managed recorder could not verify ${scryCliPath}`)
      }
      if (!cached && actualVersion !== RECORDER_VERSION) {
        // 版本不匹配最常见的原因是“运行中的 Scry 是旧构建，全局 CLI 已升级”，
        // 所以把可执行的下一步写进错误本身，Provider 日志里看不出这个因果。
        throw new Error(
          `Scry managed recorder requires CLI ${RECORDER_VERSION}; ${scryCliPath} reports ${actualVersion || 'unknown'}` +
          `；重启/重建当前 Scry 构建，或把该 scry CLI 对齐到 ${RECORDER_VERSION}`
        )
      }
      if (!cached) verifiedRecorderCliVersions.add(verificationKey)
    }
  }
  return sanitizeProviderEnv({
    ...runtimeBase,
    SCRY_CLI_PATH: scryCliPath ?? '',
    ...(options.managedRecorder ? {
      SCRY_RECORDER_MANAGED: '1',
      SCRY_RECORDER_REQUIRED_VERSION: RECORDER_VERSION,
      SCRY_RECORDER_VERIFIED_VERSION: RECORDER_VERSION
    } : {}),
    PATH: runtimeBase.PATH ?? process.env.PATH ?? ''
  }, options.providerId)
}
