import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { SessionLedger } from './session-ledger'
import { RemoteGateway } from './remote-gateway'
import { CERT, MemoryLedgerStore, gateway, grantedAuthority } from './remote-gateway.fixtures'

describe('RemoteGateway transfer size (catalog confirmation, compressed history)', () => {
  it('confirms an unchanged catalog in one page and walks a changed one', async () => {
    const { authority } = await grantedAuthority()
    let entries = Array.from({ length: 150 }, (_, index) => ({
      sessionId: `s${index}`, providerId: 'codex', cwd: '/repo', label: `session ${index}`, ts: index
    }))
    const { gw } = gateway(authority, undefined, undefined, undefined, { list: () => entries })
    const first = gw.listSessionsPage(CERT, { cursor: 0, limit: 100 })
    expect(first.unchanged).toBeUndefined()
    const same = gw.listSessionsPage(CERT, { cursor: 0, limit: 100, known: first.snapshot })
    expect(same).toEqual({ sessions: [], cursor: 150, total: 150, hasMore: false, snapshot: first.snapshot, unchanged: true })
    entries = entries.slice(1)
    const changed = gw.listSessionsPage(CERT, { cursor: 0, limit: 100, known: first.snapshot })
    expect(changed.unchanged).toBeUndefined()
    expect(changed.snapshot).not.toBe(first.snapshot)
    expect(changed.sessions).toHaveLength(100)
    for (const invalid of [{ known: 'nothex' }, { known: first.snapshot, cursor: 100 }, { known: first.snapshot, snapshot: first.snapshot }]) {
      expect(() => gw.listSessionsPage(CERT, { cursor: 0, ...invalid })).toThrow('invalid_session_query')
    }
  })

  it('pages a compressed history walk that inflates to the snapshot bytes', async () => {
    const { authority } = await grantedAuthority()
    const expected = [{ userText: 'compress me', items: [{ kind: 'tool_result' as const, text: 'repeated tool output\n'.repeat(40_000) }] }]
    const read = vi.fn(async () => expected)
    const gw = new RemoteGateway({ authority, ledger: new SessionLedger({ store: new MemoryLedgerStore() }), history: { read } })
    const query = { providerId: 'qoder', cwd: '/w', externalSessionId: 'deflate', encoding: 'deflate' as const }
    const parts: Buffer[] = []
    let cursor = 0
    let snapshot: string | undefined
    let rawBytes = 0
    do {
      const page = await gw.readHistoryPage(CERT, { ...query, cursor, limit: 16 * 1024, ...(snapshot ? { snapshot } : {}) })
      expect(page.encoding).toBe('deflate')
      snapshot ??= page.snapshot
      rawBytes = page.rawBytes!
      parts.push(Buffer.from(page.dataBase64, 'base64'))
      cursor = page.cursor
      if (!page.hasMore) break
    } while (true)
    const compressed = Buffer.concat(parts)
    const raw = inflateRawSync(compressed)
    expect(raw).toHaveLength(rawBytes)
    expect(compressed.length * 10).toBeLessThan(raw.length)
    expect(createHash('sha256').update(raw).digest('hex')).toBe(snapshot)
    expect(JSON.parse(raw.toString('utf8'))).toEqual(expected)
    expect(read).toHaveBeenCalledTimes(1)
    await expect(gw.readHistoryPage(CERT, { ...query, encoding: 'gzip' as never })).rejects.toThrow('invalid_history_query')
  })
})
