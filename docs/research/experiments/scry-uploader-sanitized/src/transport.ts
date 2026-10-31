import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { TRANSPORT_TIMEOUT_SECONDS, MCP_SERVER, MCP_SKILL, MCP_TOOL } from './constants.js'
import { executable, object, run } from './util.js'

export interface Actor {
  userId: string
  nick: string
}

export type ArgumentStyle = 'named' | 'field_name' | 'positional'

export const TRANSPORT_INSTALL_URL = 'https://installer.invalid/install.sh'

function executableSync(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const ARGUMENT_ORDER = [
  'actorUserId',
  'actorNick',
  'repo',
  'installationId',
  'uploaderVersion',
  'redactionVersion',
  'records'
] as const

export function transportExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TRANSPORT_CLI_PATH?.trim()
  if (configured) return configured
  const defaultPath = join(env.HOME?.trim() || homedir(), '.local', 'bin', 'transport')
  if (executableSync(defaultPath)) return defaultPath
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'transport')
    if (executableSync(candidate)) return candidate
  }
  return defaultPath
}

async function verifyTransportExecutable(path: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!(await executable(path))) return false
  const result = await run(path, ['--no-update-check', 'version'], { env, timeoutMs: 15_000 })
  if (result.exitCode !== 0)
    throw new Error(`transport 安装无效：${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return true
}

export async function ensureTransportInstalled(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch } = {}
): Promise<string> {
  const target = transportExecutable(env)
  if (await verifyTransportExecutable(target, env)) return target

  const installDirectory = dirname(target)
  if (basename(target) !== 'transport') throw new Error(`TRANSPORT_CLI_PATH 必须指向名为 transport 的可执行文件：${target}`)

  const temporary = await mkdtemp(join(tmpdir(), 'scry-uploader-transport-'))
  const scriptPath = join(temporary, 'install.sh')
  try {
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(TRANSPORT_INSTALL_URL, { signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new Error(`下载 transport 安装脚本失败：${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      })
    }
    if (!response.ok) throw new Error(`下载 transport 安装脚本失败：HTTP ${response.status}`)
    const script = await response.text()
    if (Buffer.byteLength(script, 'utf8') > 1024 * 1024)
      throw new Error('下载 transport 安装脚本失败：脚本超过 1 MiB')
    await writeFile(scriptPath, script, { mode: 0o700 })

    const installEnv = {
      ...env,
      TRANSPORT_INSTALL_DIR: installDirectory,
      TRANSPORT_INSTALL_AUX_CLI: '0',
      TRANSPORT_SKIP_OPTIONAL_COMPONENT: '1',
      TRANSPORT_SKIP_PATH: '1'
    }
    const installed = await run('/bin/sh', [scriptPath], {
      cwd: temporary,
      env: installEnv,
      timeoutMs: 180_000
    })
    if (installed.exitCode !== 0) {
      throw new Error(
        `自动安装 transport 失败：${installed.stderr.trim() || installed.stdout.trim() || `exit ${installed.exitCode}`}`
      )
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }

  if (!(await verifyTransportExecutable(target, env))) throw new Error(`transport 安装完成但未找到可执行文件：${target}`)
  env.TRANSPORT_CLI_PATH = target
  return target
}

async function runTransport(
  args: string[],
  options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
) {
  let result
  try {
    result = await run(transportExecutable(options.env), ['--no-update-check', ...args], {
      input: options.input,
      timeoutMs: options.timeoutMs ?? 30_000,
      env: options.env
    })
  } catch (error) {
    throw new Error(`transport 不可用：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (result.exitCode !== 0)
    throw new Error(`transport 调用失败：${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return result.stdout
}

export async function actorIdentity(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000
): Promise<Actor> {
  let stdout: string
  try {
    stdout = await runTransport(['auth', 'whoami', '-f', 'json'], { timeoutMs, env })
  } catch (error) {
    throw new Error('transport 已安装但未登录；请先执行 transport auth login --sso', { cause: error })
  }
  const raw = JSON.parse(stdout) as unknown
  const value = object(raw)
  if (!value) throw new Error('transport auth whoami 返回格式无效')
  const userId = String(value.subject_id ?? value.account ?? '').trim()
  const nick = String(value.nickname ?? value.name ?? '').trim()
  if (!userId || !nick) throw new Error('transport 登录身份缺少 subject_id 或 nickname')
  return { userId: userId.slice(0, 64), nick: nick.slice(0, 64) }
}

export async function toolArgumentStyle(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000
): Promise<ArgumentStyle> {
  const raw = JSON.parse(
    await runTransport(['mcp', 'list-tools', MCP_SERVER, '--json'], { timeoutMs, env })
  ) as unknown
  if (!Array.isArray(raw)) throw new Error('transport mcp list-tools 返回格式无效')
  const tool = raw.map(object).find((item) => item?.name === MCP_TOOL)
  if (!tool) throw new Error(`${MCP_SERVER} 未提供 ${MCP_TOOL}`)
  const schema = object(tool.inputSchema)
  const properties = object(schema?.properties)
  if (!properties) throw new Error(`${MCP_TOOL} inputSchema 无效`)
  const keys = new Set(Object.keys(properties))
  if (ARGUMENT_ORDER.every((key) => keys.has(key))) return 'named'
  if (ARGUMENT_ORDER.every((_, index) => keys.has(`fieldName_${index}`))) return 'field_name'
  if (ARGUMENT_ORDER.every((_, index) => keys.has(`arg${index}`))) return 'positional'
  throw new Error(`${MCP_TOOL} 参数契约不兼容`)
}

export function reportArguments(
  values: Record<string, unknown>,
  style: ArgumentStyle
): Record<string, unknown> {
  if (style === 'named') return values
  if (style === 'field_name') {
    return Object.fromEntries(ARGUMENT_ORDER.map((key, index) => [`fieldName_${index}`, values[key]]))
  }
  return Object.fromEntries(ARGUMENT_ORDER.map((key, index) => [`arg${index}`, values[key]]))
}

export async function callSubmitTurns(
  argumentsValue: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = (TRANSPORT_TIMEOUT_SECONDS + 5) * 1_000
): Promise<unknown> {
  const stdout = await runTransport(
    [
      'mcp',
      'call-tool',
      `${MCP_SERVER}::${MCP_TOOL}`,
      '-',
      '--skill-name',
      MCP_SKILL,
      '--timeout',
      `${Math.min(TRANSPORT_TIMEOUT_SECONDS, Math.max(1, Math.floor(timeoutMs / 1_000)))}s`,
      '-f',
      'json'
    ],
    {
      input: `${JSON.stringify(argumentsValue)}\n`,
      timeoutMs,
      env
    }
  )
  const response = JSON.parse(stdout) as unknown
  const root = object(response)
  if (!root) throw new Error('submitTurns 返回格式无效')
  if (root.success === false)
    throw new Error(`submitTurns 失败：${String(root.error ?? root.message ?? 'unknown')}`)
  return root.success === true && 'data' in root ? root.data : response
}

export async function repositoryName(workspace: string, timeoutMs = 5_000): Promise<string> {
  const remote = await run('git', ['-C', workspace, 'remote', 'get-url', 'origin'], { timeoutMs })
  if (remote.exitCode === 0 && remote.stdout.trim()) {
    const value = remote.stdout.trim().replace(/\/$/, '').split('/').at(-1) ?? ''
    return (value.endsWith('.git') ? value.slice(0, -4) : value).slice(0, 128)
  }
  return basename(workspace).slice(0, 128)
}
