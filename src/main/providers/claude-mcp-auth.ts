import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpAuthResult } from '../../shared/provider'
import { sanitizeMcpAuthError } from './mcp-auth-security'

const MCP_LOGIN_TIMEOUT_MS = 180_000

export type ClaudeMcpLogin = (
  executable: string,
  serverName: string,
  config: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv
) => Promise<McpAuthResult>

export function claudeMcpLoginArgs(serverName: string, configPath: string): string[] {
  if (!serverName || /[\u0000-\u001f\u007f]/.test(serverName)) {
    throw new Error('Claude MCP 名称包含无效字符')
  }
  return ['--mcp-config', configPath, '--strict-mcp-config', 'mcp', 'login', '--', serverName]
}

function executeClaudeMcpLogin(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<McpAuthResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { cwd, env, shell: false, timeout: MCP_LOGIN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error) => resolve(error
        ? { ok: false, status: 'failed', error: error.killed ? '等待 Claude MCP 浏览器认证超时' : sanitizeMcpAuthError(error) }
        : { ok: true, status: 'authenticated' })
    )
  })
}

export const runClaudeMcpLogin: ClaudeMcpLogin = async (executable, serverName, config, cwd, env) => {
  let authDirectory: string | undefined
  let result: McpAuthResult
  let cleanupError: unknown
  try {
    // Validate before writing a credential-bearing config to disk.
    claudeMcpLoginArgs(serverName, '')
    authDirectory = await mkdtemp(join(tmpdir(), 'scry-claude-mcp-auth-'))
    await chmod(authDirectory, 0o700)
    const configPath = join(authDirectory, 'mcp.json')
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { [serverName]: config } }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    result = await executeClaudeMcpLogin(
      executable,
      claudeMcpLoginArgs(serverName, configPath),
      cwd,
      env
    )
  } catch (error) {
    result = { ok: false, status: 'failed', error: sanitizeMcpAuthError(error) }
  } finally {
    if (authDirectory) {
      try {
        await rm(authDirectory, { recursive: true, force: true })
      } catch (error) {
        cleanupError = error
      }
    }
  }
  if (cleanupError) {
    return { ok: false, status: 'failed', error: `Claude MCP 临时认证配置清理失败：${sanitizeMcpAuthError(cleanupError)}` }
  }
  return result
}
