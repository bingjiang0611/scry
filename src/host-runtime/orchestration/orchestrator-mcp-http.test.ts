import { describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRepoBaselineStore } from './agent-repo-baseline'
import { canonicalJson, sha256Hex } from './canonical-json'
import { DelegationCredentialStore } from './delegation-credentials'
import { DelegationService } from './delegation-service'
import { EventSink } from './event-sink'
import { OrchestratorMcpHttpServer } from './orchestrator-mcp-http'

const PEER_A = `peer:${'a'.repeat(64)}`

function postMcp(
  port: number,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body, 'utf8')),
          ...headers
        }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

describe('P6-2 OrchestratorMcpHttpServer (Codex loopback endpoint security & JSON-RPC)', () => {
  it('enforces Host, Origin, 32 KiB body cap, bearer auth, revocation, and serves MCP JSON-RPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-p6-http-'))
    const sink = EventSink.open({ userDataDir: dir, authorizedActors: [PEER_A], fullfsync: false })
    const creds = new DelegationCredentialStore()
    const baseline = new AgentRepoBaselineStore()
    const service = new DelegationService({
      sink,
      credentials: creds,
      baselineStore: baseline,
      currentTrustFingerprint: () => 'fp-1'
    })
    const server = new OrchestratorMcpHttpServer(service)
    try {
      const { port } = await server.start()
      const submitPayload = {
        runId: 'run-codex-1', sessionKey: 'sess-1', provider: 'codex', profile: null, cwd: dir,
        claimMode: 'immediate' as const, dispatchImmediately: true, leaseOwner: 'daemon:test', origin: 'local' as const
      }
      sink.execute({
        type: 'run.submit', commandId: 'sub-c1', actor: PEER_A, scope: 'local', at: 1_000,
        payload: submitPayload, payloadSha256: sha256Hex(canonicalJson(submitPayload))
      })
      const cred = creds.issue({
        runId: 'run-codex-1', sessionKey: 'sess-1', bindingId: 'b1', principal: PEER_A,
        provider: 'codex', profile: null, cwd: dir, permissionMode: 'default'
      })

      const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

      // Missing token -> 401
      expect((await postMcp(port, initBody)).status).toBe(401)
      // Wrong token -> 401
      expect((await postMcp(port, initBody, { authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401)
      // Origin header present -> 403
      expect((await postMcp(port, initBody, { authorization: `Bearer ${cred.token}`, origin: 'http://evil.example' })).status).toBe(403)
      // Wrong Host header -> 403
      expect((await postMcp(port, initBody, { authorization: `Bearer ${cred.token}`, host: 'evil.example' })).status).toBe(403)
      // Body > 32 KiB -> 413
      const huge = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scry_task_delegate', arguments: { task: 'x'.repeat(33_000) } } })
      expect((await postMcp(port, huge, { authorization: `Bearer ${cred.token}` })).status).toBe(413)

      // Valid initialize + tools/list + tools/call (scry_capabilities)
      const initRes = await postMcp(port, initBody, { authorization: `Bearer ${cred.token}` })
      expect(initRes.status).toBe(200)
      expect(JSON.parse(initRes.body).result.serverInfo.name).toBe('scry_orchestrator')

      const listRes = await postMcp(port, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }), {
        authorization: `Bearer ${cred.token}`
      })
      expect(listRes.status).toBe(200)
      const tools = JSON.parse(listRes.body).result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
      expect(tools.map((t) => t.name)).toEqual([
        'scry_capabilities', 'scry_task_status', 'scry_task_result_read', 'scry_task_delegate', 'scry_task_cancel'
      ])
      expect(tools.find((t) => t.name === 'scry_capabilities')?.annotations?.readOnlyHint).toBe(true)
      expect(tools.find((t) => t.name === 'scry_task_delegate')?.annotations?.readOnlyHint).toBe(false)

      const capRes = await postMcp(port, JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'scry_capabilities', arguments: {} }
      }), { authorization: `Bearer ${cred.token}` })
      expect(capRes.status).toBe(200)
      const capPayload = JSON.parse(JSON.parse(capRes.body).result.content[0].text)
      expect(capPayload.ok).toBe(true)
      expect(capPayload.data.provider).toBe('codex')

      // After revoking run -> 401 and 0 new events
      const eventsBefore = sink.listEvents().length
      creds.revokeRun('run-codex-1')
      const revokedRes = await postMcp(port, JSON.stringify({
        jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'scry_capabilities', arguments: {} }
      }), { authorization: `Bearer ${cred.token}` })
      expect(revokedRes.status).toBe(401)
      expect(sink.listEvents().length).toBe(eventsBefore)
    } finally {
      await server.close()
      service.dispose()
      sink.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
