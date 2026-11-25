import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { HISTORY_READER_SERVER, historyReaderEnvironment } from '../conversation-history-reader'
import type { ProviderRunRequest } from './types'

const MAX_PROXY_BODY_BYTES = 4 * 1024 * 1024

function tokenMatches(expected: string, headerValue: string | undefined): boolean {
  if (!headerValue) return false
  const expectedHeader = `Bearer ${expected}`
  const a = Buffer.from(headerValue, 'utf8')
  const b = Buffer.from(expectedHeader, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    total += buf.length
    if (total > MAX_PROXY_BODY_BYTES) throw new Error('history reader request too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total)
}

/**
 * Run-scoped ephemeral HTTP MCP bridge for `request.historyReader` (P7 §5.3).
 *
 * A0 testing (`06-mcp.json`) observed `agy 1.5.12` persisting `session/new.mcpServers`
 * bearer headers in its conversation database. The config given to `agy` uses the
 * loopback bridge's per-run credential, not the upstream bearer. When disposal
 * runs, it revokes that credential before closing the bridge.
 */
export async function prepareAntigravityHistoryMcp(
  request: ProviderRunRequest,
  baseEnv?: Record<string, string>
): Promise<{
  mcpServers: Array<Record<string, unknown>>
  extraEnv?: Record<string, string>
  dispose?: () => Promise<void>
}> {
  const reader = request.historyReader
  if (!reader) return { mcpServers: [] }

  const ephemeralToken = randomBytes(32).toString('hex')
  let revoked = false
  let expectedHost = ''

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Reject DNS rebinding / browser CSRF requests before touching upstream.
    if (req.headers.origin || (expectedHost && req.headers.host !== expectedHost)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    if (revoked || !tokenMatches(ephemeralToken, req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    void (async () => {
      const upstreamAbort = new AbortController()
      const abortUpstream = (): void => {
        if (!res.writableEnded) upstreamAbort.abort()
      }
      res.once('close', abortUpstream)
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
        const headers: Record<string, string> = {
          Authorization: `Bearer ${reader.token}`
        }
        if (typeof req.headers['content-type'] === 'string') headers['Content-Type'] = req.headers['content-type']
        if (typeof req.headers.accept === 'string') headers.Accept = req.headers.accept
        if (typeof req.headers['mcp-session-id'] === 'string') headers['mcp-session-id'] = req.headers['mcp-session-id']

        const upstream = await fetch(reader.url, {
          method: req.method ?? 'POST',
          headers,
          signal: upstreamAbort.signal,
          ...(body && body.length > 0 ? { body } : {})
        })
        const outHeaders: Record<string, string> = {}
        const ct = upstream.headers.get('content-type')
        if (ct) outHeaders['Content-Type'] = ct
        const sid = upstream.headers.get('mcp-session-id')
        if (sid) outHeaders['mcp-session-id'] = sid

        // Stream SSE responses chunk-by-chunk without buffering the full body.
        if (ct?.toLowerCase().includes('text/event-stream') && upstream.body) {
          outHeaders['Cache-Control'] = 'no-cache'
          res.writeHead(upstream.status, outHeaders)
          res.flushHeaders?.()
          const streamReader = upstream.body.getReader()
          try {
            while (true) {
              const { done, value } = await streamReader.read()
              if (done) break
              if (value && value.byteLength > 0 && !res.destroyed) {
                res.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
              }
            }
          } finally {
            streamReader.releaseLock()
          }
          if (!res.writableEnded) res.end()
          return
        }

        const responseBuf = Buffer.from(await upstream.arrayBuffer())
        res.writeHead(upstream.status, outHeaders)
        res.end(responseBuf)
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'proxy error' }))
        } else if (!res.writableEnded) {
          res.end()
        }
      } finally {
        res.off('close', abortUpstream)
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('无法分配 Antigravity 历史检索 MCP 本地端口')
  }
  expectedHost = `127.0.0.1:${address.port}`
  const url = `http://${expectedHost}/mcp`
  // Merge shell NO_PROXY / no_proxy from baseEnv so user exclusions are preserved alongside loopback.
  const proxyEnv = historyReaderEnvironment(baseEnv ?? (process.env as Record<string, string>))

  return {
    mcpServers: [{
      type: 'http',
      name: HISTORY_READER_SERVER,
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${ephemeralToken}` }]
    }],
    extraEnv: {
      NO_PROXY: proxyEnv.NO_PROXY,
      no_proxy: proxyEnv.no_proxy
    },
    dispose: async () => {
      revoked = true
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
