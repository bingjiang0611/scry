// 扫 PATH 检测本机已安装的 agent CLI（claude code / codex / cursor / …），
// 供 app 的 CLI 选择器（参考 open-design 的 Local CLI 下拉）。

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const QODER_NODE_BIN = `${homedir()}/.nvm/versions/node/v22.22.1/bin`
export const QODER_NPM_BIN = `${QODER_NODE_BIN}/qodercli`

// GUI app 从 Finder/Dock 启动走 launchd，PATH 极简（/usr/bin:/bin），不 source 用户的 .zshrc，
// nvm/cargo 等版本管理器装的工具全找不到（macOS 经典坑）。正解：spawn 用户的「登录+交互」shell
// 捞它的真实 PATH——nvm 在 .zshrc 里、只有交互 shell 才 source，这样 app 解析 claude 和用户终端
// 完全一致（优先用户日常那个版本）。sentinel 包裹，过滤 shell 启动打印的 banner 等杂项。缓存一次。
let shellPathCache: string | null = null
let shellPathPromise: Promise<string> | null = null
function shellPath(): string {
  if (shellPathCache !== null) return shellPathCache
  shellPathCache = ''
  // Finder/launchd 启动时 SHELL 可能为空 → 兜底 /bin/zsh（macOS 默认），否则拿不到登录 PATH
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const out = execFileSync(shell, ['-lic', 'echo __AS_PATH__=$PATH'], { encoding: 'utf8', timeout: 5000 })
    shellPathCache = out.match(/__AS_PATH__=(.+)/)?.[1]?.trim() ?? ''
  } catch {
    shellPathCache = '' // 捞不到就退回 nvmBins/常见位置兜底
  }
  return shellPathCache
}

function execFileText(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: opts.timeout ?? 1500, env: opts.env }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })
}

async function shellPathAsync(): Promise<string> {
  if (shellPathCache !== null) return shellPathCache
  if (shellPathPromise) return shellPathPromise
  const shell = process.env.SHELL || '/bin/zsh'
  shellPathPromise = execFileText(shell, ['-lic', 'echo __AS_PATH__=$PATH'], { timeout: 2500 }).then((out) => {
    shellPathCache = out.match(/__AS_PATH__=(.+)/)?.[1]?.trim() ?? ''
    shellPathPromise = null
    return shellPathCache
  })
  return shellPathPromise
}

// app 启动方式不同，进程环境差异巨大：从终端 `npm run dev` 继承完整环境；从 Finder/launchd 打开的
// 打包 app 只有极简环境（缺完整 PATH、缺 GUI 登录会话相关变量），导致 SDK spawn 的 claude 读不到
// Keychain 登录态 → "Not logged in"（实测：完整环境/launchd-osascript 都能认证，唯独 env-i 极简环境失败）。
// 解法：捞用户登录+交互 shell 的完整环境，spawn claude 时显式传入，让它拿到与终端等价的环境。
// 清掉嵌套会话污染（CLAUDECODE 等）。缓存一次。
let shellEnvCache: Record<string, string> | null = null
export function sanitizeNestedAgentEnv(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...input }
  for (const k of Object.keys(out)) {
    if (
      k === 'CLAUDECODE' ||
      k === 'AI_AGENT' ||
      k === 'CLAUDE_EFFORT' ||
      k === 'CODEX_CI' ||
      k === 'CODEX_THREAD_ID' ||
      k.startsWith('CLAUDE_CODE_') ||
      k.startsWith('CODEX_INTERNAL_')
    ) {
      delete out[k]
    }
  }
  return out
}

export function shellEnv(): Record<string, string> {
  if (shellEnvCache) return shellEnvCache
  const out: Record<string, string> = { ...(process.env as Record<string, string>) }
  // Finder/launchd 启动时 SHELL 常为空 → 兜底 /bin/zsh，否则拿不到登录环境 → claude "Not logged in"
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const raw = execFileSync(shell, ['-lic', 'echo __AS_ENV_S__; env; echo __AS_ENV_E__'], {
      encoding: 'utf8',
      timeout: 5000
    })
    const s = raw.indexOf('__AS_ENV_S__')
    const e = raw.indexOf('__AS_ENV_E__')
    if (s >= 0 && e > s) {
      for (const line of raw.slice(s + '__AS_ENV_S__'.length, e).split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
      }
    }
  } catch {
    /* 捞不到就退回 process.env */
  }
  shellEnvCache = sanitizeNestedAgentEnv(out)
  return shellEnvCache
}

// nvm 各版本 bin（shell 捞 PATH 失败时兜底）。claude 常 symlink 在这里；版本号动态，glob 所有版本。
function nvmBins(): string[] {
  try {
    const root = `${homedir()}/.nvm/versions/node`
    return readdirSync(root).map((v) => `${root}/${v}/bin`)
  } catch {
    return []
  }
}

function enrichedPath(): string {
  // shell 真实 PATH 放最前 → 解析顺序和用户终端一致；其后是进程 PATH + 常见位置兜底
  //（nvmBins 排在 ~/.local/bin 前，兜底时也优先 nvm 装的较新 claude）。
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', ...nvmBins(), `${homedir()}/.local/bin`]
  return [shellPath(), process.env.PATH ?? '', ...extra].filter(Boolean).join(':')
}

async function enrichedPathAsync(): Promise<string> {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', ...nvmBins(), `${homedir()}/.local/bin`]
  return [await shellPathAsync(), process.env.PATH ?? '', ...extra].filter(Boolean).join(':')
}

function which(bin: string): string {
  try {
    const p = execFileSync('/usr/bin/which', [bin], {
      encoding: 'utf8',
      env: { ...process.env, PATH: enrichedPath() }
    }).trim()
    return p && existsSync(p) ? p : ''
  } catch {
    return ''
  }
}

async function whichAsync(bin: string): Promise<string> {
  const p = (await execFileText('/usr/bin/which', [bin], {
    env: { ...process.env, PATH: await enrichedPathAsync() },
    timeout: 1200
  })).trim()
  return p && existsSync(p) ? p : ''
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

async function tryVersionAsync(path: string, args: string[] = ['--version']): Promise<string | undefined> {
  const out = (
    await execFileText(path, args, {
      env: runtimeCliEnv({ ...(process.env as Record<string, string>), PATH: await enrichedPathAsync() }),
      timeout: 5000
    })
  )
  return normalizeAgentVersion(out)
}

async function agentVersionAsync(id: string, path: string): Promise<string | undefined> {
  if (id === 'codex') {
    const bundled = await appBundleVersionAsync(path)
    if (bundled) return bundled
  }
  return tryVersionAsync(path, id === 'qoder' ? ['-v'] : ['--version'])
}

export interface DetectedAgent {
  id: string
  name: string
  bin: string
  path: string
  version?: string
}

// 已知 agent CLI 清单（命令名）。MVP 只有 claude 能真正驱动（用 Agent SDK），
// 其余检测到也列出，切换/驱动二期接各自 adapter。
const KNOWN_AGENTS: Array<{ id: string; name: string; bin: string }> = [
  { id: 'claude', name: 'Claude Code', bin: 'claude' },
  { id: 'codex', name: 'Codex', bin: 'codex' },
  { id: 'cursor', name: 'Cursor Agent', bin: 'cursor-agent' },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini' },
  { id: 'qoder', name: 'Qoder CLI', bin: 'qodercli' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode' }
]

function qoderPathFromEnv(): string {
  const configured = process.env.SCRY_QODERCLI_PATH?.trim()
  return configured && existsSync(configured) ? configured : ''
}

export function isAcceptedQoderPath(path: string, target: string = QODER_NPM_BIN): boolean {
  return !!path && (path === target || path.endsWith('/qodercli'))
}

export function selectQoderBinCandidate(args: {
  configured?: string
  onPath?: string
  npmBin?: string
  npmExists: boolean
}): string | undefined {
  const target = args.npmBin ?? QODER_NPM_BIN
  if (args.configured && isAcceptedQoderPath(args.configured, target)) return args.configured
  if (args.onPath && isAcceptedQoderPath(args.onPath, target)) return args.onPath
  return args.npmExists ? target : undefined
}

function resolveQoderBin(): string | undefined {
  const configured = qoderPathFromEnv()
  const onPath = which('qodercli')
  return selectQoderBinCandidate({ configured, onPath, npmExists: existsSync(QODER_NPM_BIN) })
}

async function resolveQoderBinAsync(): Promise<string | undefined> {
  const configured = qoderPathFromEnv()
  const onPath = await whichAsync('qodercli')
  return selectQoderBinCandidate({ configured, onPath, npmExists: existsSync(QODER_NPM_BIN) })
}

export async function detectAgents(): Promise<DetectedAgent[]> {
  const found = await Promise.all(
    KNOWN_AGENTS.map(async (a): Promise<DetectedAgent | null> => {
      const path =
        a.id === 'qoder' ? await resolveQoderBinAsync() : a.id === 'claude' ? await resolveClaudeBinAsync() : await whichAsync(a.bin)
      if (!path) return null
      return { ...a, path, version: await agentVersionAsync(a.id, path) }
    })
  )
  return found.filter((a): a is DetectedAgent => a !== null)
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
  const configured = agentId === 'opencode' ? process.env.SCRY_OPENCODE_PATH?.trim() : process.env.SCRY_CODEX_PATH?.trim()
  if (configured && existsSync(configured)) return configured
  const onPath = which(agentId)
  return onPath || undefined
}

export function runtimeCliEnv(base: Record<string, string> = shellEnv()): Record<string, string> {
  return sanitizeNestedAgentEnv({
    ...base,
    PATH: [QODER_NODE_BIN, base.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(':')
  })
}
