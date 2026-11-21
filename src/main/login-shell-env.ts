import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ProviderId } from '../shared/provider.js'
import { sanitizeNestedAgentEnv } from './provider-environment'
import { buildRuntimeCliEnv } from './recorder-cli-runtime'

// GUI app 从 Finder/Dock 启动走 launchd，PATH 极简（/usr/bin:/bin），不 source 用户的 .zshrc，
// nvm/cargo 等版本管理器装的工具全找不到（macOS 经典坑）。正解：spawn 用户的「登录+交互」shell
// 捞它的真实 PATH——nvm 在 .zshrc 里、只有交互 shell 才 source，这样 app 解析 claude 和用户终端
// 完全一致（优先用户日常那个版本）。sentinel 包裹，过滤 shell 启动打印的 banner 等杂项。缓存一次。
let shellPathCache: string | null = null

export function shellPath(): string {
  if (shellPathCache === null) void warmShellEnv()
  return shellPathCache ?? ''
}

export interface ExecFileOutcome {
  stdout: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  error?: string
}

export function execFileOutcome(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<ExecFileOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stdout = ''
    const finish = (outcome: ExecFileOutcome): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(outcome)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        env: opts.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch (error) {
      finish({ stdout: '', exitCode: null, signal: null, timedOut: false, error: String((error as Error).message) })
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-64 * 1024)
    })
    child.once('error', (error) => finish({
      stdout,
      exitCode: null,
      signal: null,
      timedOut: false,
      error: String(error.message)
    }))
    child.once('close', (code, signal) => finish({ stdout, exitCode: code, signal, timedOut: false }))
    timer = setTimeout(() => {
      finish({ stdout, exitCode: null, signal: 'SIGKILL', timedOut: true })
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, opts.timeout ?? 1500)
  })
}

export async function execFileText(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<string> {
  const outcome = await execFileOutcome(file, args, opts)
  return outcome.exitCode === 0 ? outcome.stdout : ''
}

export async function shellPathAsync(): Promise<string> {
  if (shellPathCache !== null) return shellPathCache
  const env = await warmShellEnv()
  shellPathCache = env.PATH ?? ''
  return shellPathCache
}

// nvm 各版本 bin（shell 捞 PATH 失败时兜底）。claude 常 symlink 在这里；版本号动态，glob 所有版本。
export function nvmBins(): string[] {
  try {
    const root = `${homedir()}/.nvm/versions/node`
    return readdirSync(root).map((v) => `${root}/${v}/bin`)
  } catch {
    return []
  }
}

export function versionProbePath(): string {
  // version 探测拿到的是绝对 executable；这里只需保证 npm shim 的 node 可解析，不能再为 --version
  // 启动昂贵的登录 shell。非标准安装仍由完整 PATH fallback 负责发现。
  return [
    process.env.PATH ?? '',
    ...nvmBins(),
    `${homedir()}/.local/bin`,
    `${homedir()}/.opencode/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
    .filter(Boolean)
    .join(':')
}

// Finder/launchd 的 PATH 很短；只从登录 shell 补齐 CLI、桌面会话、代理和 Provider 自身变量。
// 不能把用户 shell 里的任意 secret 全量注入每一家 Provider 子进程。进程原本继承的环境保持不变。
let shellEnvCache: Record<string, string> | null = null
let shellEnvPromise: Promise<Record<string, string>> | null = null
let shellEnvFailure: string | undefined

export function shellEnvError(): string | undefined {
  return shellEnvFailure
}

// nvm initialization can take >5s on a healthy login shell. Keep acquisition bounded;
// after 15s report degradation and retry only on the next explicit send, not UI polling.
const SHELL_ENV_TIMEOUT_MS = 15_000

const LOGIN_SHELL_ENV_NAMES = new Set([
  'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'SSH_AUTH_SOCK', 'WAYLAND_DISPLAY',
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'PNPM_HOME',
  'CODEX_HOME'
])
const LOGIN_SHELL_ENV_PREFIXES = [
  'SCRY_', 'ANTHROPIC_', 'OPENAI_', 'CLAUDE_', 'CODEX_', 'QODER_', 'OPENCODE_',
  'AWS_', 'AZURE_', 'GOOGLE_', 'GCP_'
]

function loginShellEnvAllowed(name: string): boolean {
  return LOGIN_SHELL_ENV_NAMES.has(name) || LOGIN_SHELL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function mergeLoginShellEnv(
  inherited: Record<string, string>,
  captured: Record<string, string>
): Record<string, string> {
  const out = { ...inherited }
  const hasInheritedCodexHome = Object.prototype.hasOwnProperty.call(inherited, 'CODEX_HOME')
  for (const [name, value] of Object.entries(captured)) {
    if (loginShellEnvAllowed(name) && (name !== 'CODEX_HOME' || !hasInheritedCodexHome)) out[name] = value
  }
  return sanitizeNestedAgentEnv(out)
}

function fallbackShellEnv(): Record<string, string> {
  return sanitizeNestedAgentEnv({
    ...(process.env as Record<string, string>),
    PATH: versionProbePath()
  })
}

export function warmShellEnv(options: { retryFailed?: boolean } = {}): Promise<Record<string, string>> {
  if (shellEnvPromise) return shellEnvPromise
  if (shellEnvCache && !(options.retryFailed && shellEnvFailure)) return Promise.resolve(shellEnvCache)
  const shell = process.env.SHELL || '/bin/zsh'
  shellEnvPromise = execFileOutcome(shell, ['-lic', 'echo __AS_ENV_S__; env; echo __AS_ENV_E__'], { timeout: SHELL_ENV_TIMEOUT_MS }).then((outcome) => {
    const out = fallbackShellEnv()
    const captured: Record<string, string> = {}
    const raw = outcome.stdout
    const s = raw.indexOf('__AS_ENV_S__')
    const e = raw.indexOf('__AS_ENV_E__')
    const capturedLoginEnv = outcome.exitCode === 0 && s >= 0 && e > s
    if (!capturedLoginEnv) {
      const reason = outcome.timedOut ? `超时（${SHELL_ENV_TIMEOUT_MS / 1_000}s）`
        : outcome.error ? '无法启动'
          : outcome.signal ? `被信号 ${outcome.signal} 终止`
            : outcome.exitCode !== 0 ? `退出码 ${outcome.exitCode}`
              : '未返回完整环境标记'
      shellEnvFailure = `登录 shell 环境采集失败：${reason}；当前使用继承环境，代理和 PATH 可能缺失（尚不能确认是本次网络错误的原因）。请检查 shell 启动脚本，修复后重新发送将重试采集`
      // Discovery/polling keeps the fallback cached; only an explicit send retries failure.
      // Never log stdout/stderr: startup scripts and env output may contain credentials.
      console.warn(`[scry] ${shellEnvFailure}`)
    }
    if (capturedLoginEnv) {
      shellEnvFailure = undefined
      for (const line of raw.slice(s + '__AS_ENV_S__'.length, e).split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) captured[line.slice(0, i)] = line.slice(i + 1)
      }
    }
    shellEnvCache = mergeLoginShellEnv(out, captured)
    shellPathCache = capturedLoginEnv ? captured.PATH ?? '' : ''
    shellEnvPromise = null
    return shellEnvCache
  })
  return shellEnvPromise
}

export function shellEnv(): Record<string, string> {
  if (shellEnvCache) return shellEnvCache
  void warmShellEnv()
  return fallbackShellEnv()
}

export function runtimeCliEnv(
  base?: Record<string, string>,
  options: { managedRecorder?: boolean; providerId?: ProviderId } = {}
): Record<string, string> {
  const runtimeBase = base ?? shellEnv()
  const originalPath = base
    ? runtimeBase.PATH ?? process.env.PATH ?? ''
    : shellPathCache || process.env.PATH || ''
  return buildRuntimeCliEnv(runtimeBase, originalPath, options)
}
