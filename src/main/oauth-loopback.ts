import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpAuthLoopback } from './providers/types'

const CALLBACK_HTML = '<!doctype html><meta charset="utf-8"><title>Scry MCP</title><p>认证结果已返回 Scry，可以关闭此页面。</p>'

export function isSafeOAuthAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    return url.protocol === 'https:' || (
      url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

export async function prepareOAuthLoopback(timeoutMs = 120_000): Promise<McpAuthLoopback> {
  const callbackPath = `/oauth/callback/${randomBytes(24).toString('base64url')}`
  let settle: ((value: string) => void) | undefined
  let reject: ((error: Error) => void) | undefined
  let settled = false
  let timer: NodeJS.Timeout | undefined
  const callback = new Promise<string>((resolve, rejectPromise) => {
    settle = resolve
    reject = rejectPromise
  })
  void callback.catch(() => {})
  const server = createServer((request, response) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      response.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end('Bad request')
      return
    }
    if (request.method !== 'GET' || url.pathname !== callbackPath || settled) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    settled = true
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    })
    response.end(CALLBACK_HTML)
    const address = server.address() as AddressInfo
    settle?.(new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${address.port}`).toString())
    server.close()
  })
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  server.on('error', (error) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    reject?.(error)
    server.close()
  })
  timer = setTimeout(() => {
    if (settled) return
    settled = true
    reject?.(new Error('等待 MCP OAuth 浏览器回调超时'))
    server.close()
  }, timeoutMs)
  timer.unref()
  const close = (): void => {
    if (timer) clearTimeout(timer)
    if (!settled) {
      settled = true
      reject?.(new Error('MCP OAuth 认证已取消'))
    }
    server.close()
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
    waitForCallback: () => callback.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    close
  }
}
