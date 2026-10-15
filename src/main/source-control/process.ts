import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { shellEnv, resolveCommandOnPath, sanitizeProviderEnv } from '../claude-locate'

export function scMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .slice(0, 3000)
}

export class ScCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly interrupted = false
  ) {
    super(message)
  }
}

export class ScProcess {
  private readonly children = new Map<ChildProcess, (reason: string) => void>()
  private closed = false

  constructor(private readonly environment: () => NodeJS.ProcessEnv = shellEnv) {}

  async run(
    command: 'git' | 'gh',
    args: string[],
    cwd: string,
    options: {
      timeout?: number
      maxBytes?: number
      input?: string
    } = {}
  ): Promise<string> {
    if (this.closed) throw new Error('源代码管理已关闭')
    const inherited = this.environment()
    const env = sanitizeProviderEnv(
      Object.fromEntries(
        Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined)
      )
    )
    // The caller cannot inject a repository, executable, pager, auth token or config through GIT_*.
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('GIT_') ||
        key.startsWith('GH_') ||
        key === 'GITHUB_TOKEN' ||
        key === 'GITHUB_ENTERPRISE_TOKEN' ||
        key === 'NODE_OPTIONS' ||
        key.startsWith('DYLD_') ||
        key.startsWith('LD_')
      )
        delete env[key]
    }
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      LC_ALL: 'C',
      GH_PROMPT_DISABLED: '1',
      NO_COLOR: '1'
    })
    // Preserve an explicit opt-out of machine configuration, but no injected config paths/values.
    if (inherited.GIT_CONFIG_NOSYSTEM === '1') env.GIT_CONFIG_NOSYSTEM = '1'
    const executable = resolveCommandOnPath(command, env.PATH ?? '')
    if (!executable) throw new Error(`${command} 未安装或不在可信 PATH；不会自动安装`)
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      let interruption: string | undefined
      let spawnError: Error | undefined
      const stop = (reason: string): void => {
        interruption = reason
        // Only the live, registered child's own group; never a name-based process search.
        if (child.exitCode === null && child.signalCode === null) {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        } else {
          // A reaped leader cannot prove ownership of a later PID/group. Stop waiting on
          // inherited pipes, keep the outcome unknown, and never kill by an unverified PID.
          child.stdout.destroy()
          child.stderr.destroy()
          child.stdin.destroy()
        }
      }
      this.children.set(child, stop)
      const timer = setTimeout(() => stop('命令超时，执行结果需要核查'), options.timeout ?? 15_000)
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length > (options.maxBytes ?? 8 * 1024 * 1024))
          stop('命令输出超过上限，不能将部分数据视为完整结果')
        else stdout = Buffer.concat([stdout, chunk])
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(-16 * 1024)
      })
      child.on('error', (error) => {
        spawnError = error
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        this.children.delete(child)
        if (spawnError) reject(spawnError)
        else if (interruption || code !== 0)
          reject(
            new ScCommandError(
              interruption ?? (scMessage(stderr.toString('utf8').trim()) || `${command} 退出码 ${code}`),
              code,
              Boolean(interruption)
            )
          )
        else {
          try {
            resolve(new TextDecoder('utf-8', { fatal: true }).decode(stdout))
          } catch {
            reject(new Error('Git/CLI 输出不是有效 UTF-8；拒绝将损坏的路径或文本用于后续写入'))
          }
        }
      })
      child.stdin.on('error', () => {
        /* EPIPE is settled by the child's authoritative close result. */
      })
      child.stdin.end(options.input)
    })
  }

  credential(): Promise<string> {
    // Never run credential discovery inside the repository. Token never leaves main.
    return this.run('gh', ['auth', 'token', '--hostname', 'github.com'], homedir(), { maxBytes: 16_384 })
  }

  dispose(): void {
    this.closed = true
    for (const stop of this.children.values()) stop('应用正在退出，命令已中止；未确认的写入保留为 unknown')
  }
}
