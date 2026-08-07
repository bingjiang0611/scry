import { describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import { isSafeOAuthAuthorizationUrl, prepareOAuthLoopback } from './oauth-loopback'

describe('prepareOAuthLoopback', () => {
  it('只允许 HTTPS 或本机 loopback HTTP 授权页', () => {
    expect(isSafeOAuthAuthorizationUrl('https://auth.example.test/start')).toBe(true)
    expect(isSafeOAuthAuthorizationUrl('http://127.0.0.1:3456/start')).toBe(true)
    expect(isSafeOAuthAuthorizationUrl('http://localhost:3456/start')).toBe(true)
    expect(isSafeOAuthAuthorizationUrl('http://auth.example.test/start')).toBe(false)
    expect(isSafeOAuthAuthorizationUrl('https://user:password@auth.example.test/start')).toBe(false)
    expect(isSafeOAuthAuthorizationUrl('file:///tmp/token')).toBe(false)
  })

  it('只接收随机精确路径，并把完整回调 URL 交回 Provider', async () => {
    const loopback = await prepareOAuthLoopback(2_000)
    const wrong = await fetch(new URL('/oauth/callback/wrong', loopback.redirectUri))
    expect(wrong.status).toBe(404)

    const callbackUrl = `${loopback.redirectUri}?code=secret-code&state=provider-state`
    const response = await fetch(callbackUrl)
    expect(response.status).toBe(200)
    await expect(loopback.waitForCallback()).resolves.toBe(callbackUrl)
    loopback.close()
  })

  it('关闭时终止仍在等待的认证', async () => {
    const loopback = await prepareOAuthLoopback(2_000)
    const waiting = loopback.waitForCallback()
    loopback.close()
    await expect(waiting).rejects.toThrow('认证已取消')
  })

  it('畸形本机请求只返回 400，不会打断 OAuth loopback', async () => {
    const loopback = await prepareOAuthLoopback(2_000)
    const endpoint = new URL(loopback.redirectUri)
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(endpoint.port), '127.0.0.1')
      let data = ''
      socket.setEncoding('utf8')
      socket.once('error', reject)
      socket.on('data', (chunk) => { data += chunk })
      socket.once('connect', () => {
        socket.write('GET //% HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
      })
      socket.once('end', () => resolve(data))
    })

    expect(response).toMatch(/^HTTP\/1\.1 400 /)
    loopback.close()
  })
})
