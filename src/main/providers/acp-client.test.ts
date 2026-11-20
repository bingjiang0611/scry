import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpClient, AcpRpcError, validateAcpInitializeResult } from './acp-client'

const FIXTURE = join(process.cwd(), 'src', 'main', 'providers', 'fixtures', 'fake-agy-acp.mjs')
const temps: string[] = []

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

function spawnFakeAgy(scenario: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-acp-test-'))
  temps.push(dir)
  const bin = join(dir, 'agy')
  copyFileSync(FIXTURE, bin)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))
  const child = spawn(process.execPath, [bin, 'acp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  return { dir, child, recordPath: join(dir, 'recorded.json') }
}

describe('A2: AcpClient JSON-RPC 2.0 over stdio', () => {
  it('按形状校验 initialize（同时兼容 protocolVersion 1 与 2）并声明 fs=false, terminal=false', async () => {
    for (const protocolVersion of [1, 2]) {
      const { child, recordPath } = spawnFakeAgy({ protocolVersion })
      const client = new AcpClient(child)
      const init = await client.initialize('0.2.250')
      expect(init.protocolVersion).toBe(protocolVersion)
      expect(validateAcpInitializeResult(init)).toBe(true)
      client.closeStdin()
      await new Promise((resolve) => child.once('exit', resolve))
      const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
      expect(rec.requests[0].params.clientCapabilities).toEqual({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      })
    }
    expect(validateAcpInitializeResult({ protocolVersion: 0, agentInfo: {} })).toBe(false)
    expect(validateAcpInitializeResult({ protocolVersion: 1, agentInfo: {}, agentCapabilities: {} })).toBe(false)
  })

  it('兼容 Agent 发来的字符串 id 请求，并对未知方法自动回复 -32601', async () => {
    const { child, recordPath } = spawnFakeAgy({
      promptSteps: [
        {
          type: 'request_permission',
          toolCall: { toolCallId: 'tc-1', title: 'Run cmd' },
          options: [
            { optionId: 'allow_1', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_1', name: 'Reject', kind: 'reject_once' }
          ]
        },
        { type: 'unknown_agent_request', method: 'agent/unsupported_ext' }
      ]
    })
    const seenIds: Array<string | number> = []
    const client = new AcpClient(child, {
      onRequest: async (method, _params, id) => {
        if (method === 'session/request_permission') {
          seenIds.push(id)
          return { outcome: { outcome: 'selected', optionId: 'allow_1' } }
        }
        return undefined
      }
    })
    await client.initialize('0.2.250')
    const session = await client.request<{ sessionId: string }>('session/new', { cwd: '/tmp', mcpServers: [] })
    await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    client.closeStdin()
    await new Promise((resolve) => child.once('exit', resolve))

    expect(seenIds).toEqual(['1'])
    const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(rec.permissionReplies[0].id).toBe('1')
    expect(rec.permissionReplies[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_1' } })
    expect(rec.clientErrorReplies[0].error.code).toBe(-32601)
  })

  it('非 JSON stdout 行只计数不进原生流，登录提示行整行丢弃且触发登录检测', async () => {
    const rawLines: string[] = []
    let loginPromptDetected = false
    const { child } = spawnFakeAgy({
      authMode: 'login_prompt_line',
      nonJsonBeforeInit: 'debug banner noise'
    })
    const client = new AcpClient(child, {
      onRawMessage: (_dir, line) => rawLines.push(line),
      onLoginPromptDetected: () => { loginPromptDetected = true }
    })
    await client.initialize('0.2.250')
    await expect(client.request('session/new', { cwd: '/tmp', mcpServers: [] })).rejects.toBeInstanceOf(AcpRpcError)
    client.closeStdin()
    await new Promise((resolve) => child.once('exit', resolve))

    expect(client.nonJsonLineCount).toBe(2)
    expect(loginPromptDetected).toBe(true)
    expect(rawLines.join('\n')).not.toContain('SECRET_OAUTH_STATE_12345')
    expect(rawLines.join('\n')).not.toContain('debug banner noise')
  })

  it('单行超过 16 MiB 时判协议错误并中止未决请求', async () => {
    const protocolErrors: Error[] = []
    const { child } = spawnFakeAgy({
      promptSteps: [{ type: 'oversize_line', bytes: 16 * 1024 * 1024 + 128 }]
    })
    const client = new AcpClient(child, {
      onProtocolError: (error) => protocolErrors.push(error)
    })
    await client.initialize('0.2.250')
    const session = await client.request<{ sessionId: string }>('session/new', { cwd: '/tmp', mcpServers: [] })
    await expect(
      client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'boom' }] })
    ).rejects.toThrow(/16 MiB|line limit|exceeded/i)
    expect(protocolErrors.length).toBeGreaterThan(0)
    child.kill('SIGKILL')
  })

  it('请求超时按设定毫秒拒绝', async () => {
    const { child } = spawnFakeAgy({ hangOnInitialize: true })
    const client = new AcpClient(child)
    await expect(client.request('initialize', {}, { timeoutMs: 80 })).rejects.toThrow(/timed out/i)
    child.kill('SIGKILL')
  })
})
