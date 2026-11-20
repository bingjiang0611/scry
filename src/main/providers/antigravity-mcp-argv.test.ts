import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArgvRecorder, leakedSecrets, waitFor } from './argv-recorder.fixture'
import { createAntigravityAdapter } from './antigravity'

const FIXTURE = join(process.cwd(), 'src', 'main', 'providers', 'fixtures', 'fake-agy-acp.mjs')
const temps: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('A6: Antigravity MCP argv 零泄露与 run 级历史检索 token 撤销', () => {
  it('argv-recorder 断言启动参数不含任何 token/秘密', async () => {
    const recorder = createArgvRecorder()
    temps.push(recorder.root)
    const home = join(recorder.root, 'home')
    const ws = join(recorder.root, 'ws')
    mkdirSync(home, { recursive: true })
    mkdirSync(ws, { recursive: true })
    vi.stubEnv('SCRY_AGY_PATH', recorder.executable)

    const handle = createAntigravityAdapter(home).run({
      runId: 'run-argv-check',
      prompt: 'probe',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: () => {},
      historyReader: { url: 'http://127.0.0.1:9/mcp', token: 'bearer-secret-3', snapshotId: 'snap-1' }
    })
    await handle.promise.catch(() => {})
    await waitFor(recorder.recorded)
    const rec = recorder.record()
    expect(rec.argv).toEqual(['acp'])
    expect(leakedSecrets(rec.argv)).toEqual([])
  })

  it('run 级历史检索经 session/new.mcpServers 注入每轮随机 token + NO_PROXY，run 结束立刻撤销并关服', async () => {
    const upstreamTokens: string[] = []
    const upstream = createServer((req, res) => {
      upstreamTokens.push(String(req.headers.authorization ?? ''))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'scry_history_read' }] } }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
    const port = (upstream.address() as { port: number }).port

    const dir = mkdtempSync(join(tmpdir(), 'scry-agy-mcp-run-'))
    temps.push(dir)
    const home = join(dir, 'home')
    const ws = join(dir, 'ws')
    mkdirSync(home, { recursive: true })
    mkdirSync(ws, { recursive: true })
    const bin = join(dir, 'agy')
    writeFileSync(bin, readFileSync(FIXTURE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`), { mode: 0o755 })
    chmodSync(bin, 0o755)
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
      promptSteps: [{ type: 'call_mcp' }, { type: 'text', text: 'done' }]
    }))
    vi.stubEnv('SCRY_AGY_PATH', bin)

    try {
      const adapter = createAntigravityAdapter(home)
      expect(adapter.historyReader).toBe(true)
      const handle = adapter.run({
        runId: 'run-history-mcp',
        prompt: 'read history',
        cwd: ws,
        attachments: [],
        permissionMode: 'default',
        emit: () => {},
        historyReader: {
          url: `http://127.0.0.1:${port}/mcp`,
          token: 'bearer-secret-3',
          snapshotId: 'snap-live'
        }
      })
      const result = await handle.promise
      expect(result.status).toBe('completed')

      const rec = JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'))
      expect(rec.argv).toEqual(['acp'])
      expect(rec.hasNoProxy).toContain('127.0.0.1')
      expect(rec.mcpCallStatus).toBe(200)
      expect(upstreamTokens).toEqual(['Bearer bearer-secret-3'])

      const injected = rec.requests.find((r: { method: string }) => r.method === 'session/new')?.params?.mcpServers?.[0]
      expect(injected).toBeDefined()
      expect(injected.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
      const authHeader = injected.headers.find((h: { name: string }) => h.name === 'Authorization')?.value as string
      // Ephemeral per-run token must differ from upstream token so conversations/<id>.db never holds upstream secret.
      expect(authHeader).toMatch(/^Bearer [a-f0-9]{64}$/)
      expect(authHeader).not.toContain('bearer-secret-3')

      // After run settles, the ephemeral HTTP server is closed and its token is revoked immediately.
      await expect(
        fetch(injected.url, { method: 'POST', headers: { Authorization: authHeader }, body: '{}' })
      ).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})
