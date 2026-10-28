import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { sanitizeNestedAgentEnv } from './provider-env.js'

let shellPathCache: string | null = null
let shellEnvCache: Record<string, string> | null = null
let shellEnvPromise: Promise<Record<string, string>> | null = null
let shellEnvFailure: string | undefined

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

export function shellPath(): string {
  if (shellPathCache === null) void warmShellEnv()
  return shellPathCache ?? ''
}

export async function shellPathAsync(): Promise<string> {
  if (shellPathCache !== null) return shellPathCache
  const env = await warmShellEnv()
  shellPathCache = env.PATH ?? ''
  return shellPathCache
}

export function shellEnvError(): string | undefined {
  return shellEnvFailure
}

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
    const start = raw.indexOf('__AS_ENV_S__')
    const end = raw.indexOf('__AS_ENV_E__')
    const capturedLoginEnv = outcome.exitCode === 0 && start >= 0 && end > start
    if (!capturedLoginEnv) {
      const reason = outcome.timedOut ? `超时（${SHELL_ENV_TIMEOUT_MS / 1_000}s）`
        : outcome.error ? '无法启动'
          : outcome.signal ? `被信号 ${outcome.signal} 终止`
            : outcome.exitCode !== 0 ? `退出码 ${outcome.exitCode}`
              : '未返回完整环境标记'
      shellEnvFailure = `登录 shell 环境采集失败：${reason}；当前使用继承环境，代理和 PATH 可能缺失（尚不能确认是本次网络错误的原因）。请检查 shell 启动脚本，修复后重新发送将重试采集`
      console.warn(`[scry] ${shellEnvFailure}`)
    }
    if (capturedLoginEnv) {
      shellEnvFailure = undefined
      for (const line of raw.slice(start + '__AS_ENV_S__'.length, end).split('\n')) {
        const separator = line.indexOf('=')
        if (separator > 0) captured[line.slice(0, separator)] = line.slice(separator + 1)
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

export function nvmBins(): string[] {
  try {
    const root = `${homedir()}/.nvm/versions/node`
    return readdirSync(root).map((version) => `${root}/${version}/bin`)
  } catch {
    return []
  }
}

function runnableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const file = statSync(path)
    return file.isFile() && (platform === 'win32' || (file.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

export function resolveCommandOnPath(
  command: string,
  pathValue: string,
  options: {
    platform?: NodeJS.Platform
    pathExt?: string
    isRunnable?: (path: string) => boolean
  } = {}
): string | undefined {
  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? win32 : posix
  const extensions =
    platform === 'win32' && !pathApi.extname(command)
      ? (options.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  const names = platform === 'win32' ? [command, ...extensions.map((extension) => `${command}${extension}`)] : [command]
  const isRunnable = options.isRunnable ?? ((path: string) => runnableFile(path, platform))
  for (const rawDir of pathValue.split(pathApi.delimiter)) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1')
    if (!dir || !pathApi.isAbsolute(dir)) continue
    for (const name of names) {
      const path = pathApi.join(dir, name)
      if (isRunnable(path)) return path
    }
  }
  return undefined
}

export function versionProbePath(): string {
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
