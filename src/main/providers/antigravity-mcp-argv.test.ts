import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArgvRecorder, leakedSecrets, waitFor } from './argv-recorder.fixture'
import { createAntigravityAdapter } from './antigravity'
import { prepareAntigravityHistoryMcp } from './antigravity-history-mcp'

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

  it('S4: 历史检索代理校验 Host/Origin、合并 shell NO_PROXY 且流式透传 SSE 不整段缓冲', async () => {
    let releaseSecondChunk: (() => void) | undefined
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write('data: {"chunk":1}\n\n')
      releaseSecondChunk = () => {
        res.write('data: {"chunk":2}\n\n')
        res.end()
      }
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
    const port = (upstream.address() as { port: number }).port

    const prepared = await prepareAntigravityHistoryMcp({
      runId: 'run-s4-proxy',
      prompt: 'hi',
      cwd: tmpdir(),
      attachments: [],
      permissionMode: 'default',
      emit: () => {},
      historyReader: {
        url: `http://127.0.0.1:${port}/mcp`,
        token: 'upstream-secret',
        snapshotId: 'snap-s4'
      }
    }, { NO_PROXY: 'corp.internal', PATH: '/usr/bin' })

    try {
      // Merges shell baseEnv NO_PROXY instead of overwriting it with only process.env.
      expect(prepared.extraEnv?.NO_PROXY).toContain('corp.internal')
      expect(prepared.extraEnv?.NO_PROXY).toContain('127.0.0.1')

      const srv = prepared.mcpServers[0] as { url: string; headers: Array<{ name: string; value: string }> }
      const auth = srv.headers[0].value

      // Rejects any Origin header (DNS rebinding / browser CSRF defense).
      const originRes = await fetch(srv.url, {
        method: 'POST',
        headers: { Authorization: auth, Origin: 'http://evil.example' },
        body: '{}'
      })
      expect(originRes.status).toBe(403)

      // Rejects mismatched Host header via raw http request.
      const parsedUrl = new URL(srv.url)
      const { request: httpRequest } = await import('node:http')
      const badHostStatus = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port: Number(parsedUrl.port),
          path: '/mcp',
          method: 'POST',
          headers: { Host: 'evil.local:1234', Authorization: auth }
        }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end('{}')
      })
      expect(badHostStatus).toBe(403)

      // Streams SSE chunk 1 BEFORE upstream ends (would deadlock if proxy called upstream.arrayBuffer()).
      const sseRes = await fetch(srv.url, {
        method: 'POST',
        headers: { Authorization: auth, Accept: 'text/event-stream' },
        body: '{}'
      })
      expect(sseRes.status).toBe(200)
      const reader = sseRes.body!.getReader()
      const firstRead = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE chunk 1 was buffered')), 1500))
      ])
      expect(Buffer.from(firstRead.value!).toString('utf8')).toContain('"chunk":1')
      releaseSecondChunk?.()
      let rest = ''
      while (true) {
        const next = await reader.read()
        if (next.done) break
        rest += Buffer.from(next.value!).toString('utf8')
      }
      expect(rest).toContain('"chunk":2')
    } finally {
      await prepared.dispose?.()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})
