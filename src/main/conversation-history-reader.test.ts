import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createConversationHistoryReader, historyReaderEnvironment, HISTORY_READER_TOOL } from './conversation-history-reader'
import { conversationItemKey } from '../shared/conversation'

const opened: Awaited<ReturnType<typeof createConversationHistoryReader>>[] = []
afterEach(async () => { await Promise.all(opened.splice(0).map(reader => reader.close())) })
const item = (text: string, runId = 'source') => ({ ref: { runId, itemId: 'assistant', contentHash: createHash('sha256').update(text).digest('hex') }, text })
async function start(items = [item('history')]) {
  const reader = await createConversationHistoryReader(items)
  opened.push(reader)
  const call = (method: string, params?: unknown, headers?: Record<string, string>) => fetch(reader.connection.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reader.connection.token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  const read = async (args: unknown) => {
    const response = await call('tools/call', { name: HISTORY_READER_TOOL, arguments: args })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { content: Array<{ text: string }> } }
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(16 * 1024)
    return JSON.parse(body.result.content[0].text)
  }
  return { reader, call, read }
}

describe('run-scoped immutable history MCP reader', () => {
  it('adds loopback proxy exclusion without mutating the account environment or dropping configured exclusions', () => {
    const env = { HTTP_PROXY: 'http://proxy.invalid', NO_PROXY: 'upper.example', no_proxy: 'lower.example', API_KEY: 'fixture' }
    expect(historyReaderEnvironment(env)).toEqual({ ...env, NO_PROXY: 'upper.example,lower.example,127.0.0.1', no_proxy: 'upper.example,lower.example,127.0.0.1' })
    expect(env.NO_PROXY).toBe('upper.example')
    expect(env.no_proxy).toBe('lower.example')
    expect(historyReaderEnvironment({})).toEqual({ NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' })
  })
  it('supports initialize/list and reconstructs the entire hash-matching Unicode item through bounded pages', async () => {
    const source = item('字😀\n\u0000'.repeat(1000))
    const { call, read } = await start([source])
    const initialized = await (await call('initialize', { protocolVersion: '2025-03-26' })).json() as { result: { capabilities: { tools: object } } }
    expect(initialized.result.capabilities.tools).toEqual({})
    const listed = await (await call('tools/list')).json() as { result: { tools: Array<{ name: string }> } }
    const tools = listed.result.tools
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([HISTORY_READER_TOOL])
    const manifest = await read({})
    expect(manifest.items[0].id).toBe(conversationItemKey(source.ref))
    let offset: number | null = 0
    let text = ''
    let pages = 0
    do {
      const page = await read({ itemId: manifest.items[0].id, offset })
      expect(page.sourceCompleteness).toBe('complete')
      expect(page.complete).toBe(false)
      expect(page.offset).toBe(offset)
      expect(page.contentHash).toBe(source.ref.contentHash)
      text += page.text
      offset = page.nextOffset
      pages++
    } while (offset !== null)
    expect(pages).toBeGreaterThan(1)
    expect(text).toBe(source.text)
    expect(createHash('sha256').update(text).digest('hex')).toBe(source.ref.contentHash)
  })

  it('pages its exact frozen manifest without adopting later caller mutations', async () => {
    const source = Array.from({ length: 19 }, (_, index) => item(String(index), `source-${index}`))
    const ids = source.map(entry => conversationItemKey(entry.ref))
    const { read } = await start(source)
    source[0].text = 'changed'
    source[0].ref.runId = 'foreign'
    source.push(item('not captured', 'later'))
    const found: string[] = []
    let offset: number | null = 0
    do {
      const page = await read({ offset })
      expect(page.totalItems).toBe(19)
      found.push(...page.items.map((entry: { id: string }) => entry.id))
      offset = page.nextOffset
    } while (offset !== null)
    expect(found).toEqual(ids)
    expect((await read({ itemId: ids[0] })).text).toBe('0')
  })

  it('rejects foreign authority, arbitrary paths and identifiers, malformed/oversized requests, and partial surrogate offsets', async () => {
    const source = item('😀text')
    const { reader, call } = await start([source])
    const foreign = await start([item('private', 'other')])
    expect((await call('tools/list', {}, { Authorization: `Bearer ${foreign.reader.connection.token}` })).status).toBe(403)
    expect((await call('tools/list', {}, { Origin: 'https://attacker.invalid' })).status).toBe(403)
    for (const args of [{ path: '/etc/passwd' }, { cwd: '/' }, { conversationId: 'other' }, { itemId: 'foreign' },
      { offset: -1 }, { offset: 999 }, { itemId: conversationItemKey(source.ref), offset: 1 }]) {
      const response = await call('tools/call', { name: HISTORY_READER_TOOL, arguments: args })
      expect(response.status).toBe(400)
      expect((await response.json() as { error?: unknown }).error).toBeDefined()
    }
    expect((await call('tools/call', { name: 'read', arguments: {} })).status).toBe(400)
    expect((await call('tools/call', { name: HISTORY_READER_TOOL, arguments: { itemId: 'a'.repeat(5000) } })).status).toBe(400)
    await reader.close()
    await expect(call('tools/list')).rejects.toThrow()
  })

  it('refuses non-complete or mismatched snapshots instead of supplying fallback history', async () => {
    const source = item('original')
    source.text = 'changed'
    // The bounded in-memory source refuses before any server starts.
    expect(() => createConversationHistoryReader([source])).toThrow('hash-matching')
    expect(() => createConversationHistoryReader([item('x'.repeat(4 * 1024 * 1024 + 1))])).toThrow('bounded')
    expect(() => createConversationHistoryReader([item('same'), item('same')])).toThrow('Duplicate')
  })
})
