import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { frozenHashOf, readFrozenHistory } from './smoke-history-reader'

const servers: Server[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * One loopback reader that serves a frozen manifest of three bodies.
 *
 * `bodyFor` decides what the transport actually returns, so a reader that only compares
 * lengths can be shown serving the wrong text.
 */
async function reader(bodyFor: (index: number) => string): Promise<{ connection: { url: string; token: string; snapshotId: string }; readsFile: string }> {
  const bodies = ['first body ✓', 'middle body', 'last body 🚀']
  const items = bodies.map((text, index) => ({ id: JSON.stringify([`run-${index}`, 'user', hash(text)]), bytes: Buffer.byteLength(text, 'utf8') }))
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string; params?: { name?: string; arguments?: { offset?: number, itemId?: string } } }
      const reply = (result: unknown): void => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
      }
      if (call.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'smoke' } })
      const args = call.params?.arguments ?? {}
      if (args.itemId === undefined) {
        return reply({ content: [{ type: 'text', text: JSON.stringify({
          kind: 'page', totalItems: items.length, items, nextOffset: null, text: '', complete: true
        }) }] })
      }
      const index = items.findIndex(item => item.id === args.itemId)
      reply({ content: [{ type: 'text', text: JSON.stringify({
        kind: 'item', totalItems: items.length, items: [], nextOffset: null, text: bodyFor(index), complete: true
      }) }] })
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('reader test server has no port')
  const directory = await mkdtemp(join(tmpdir(), 'scry-reader-hash-'))
  directories.push(directory)
  return { connection: { url: `http://127.0.0.1:${address.port}`, token: 'token', snapshotId: 'snapshot-1' },
    readsFile: join(directory, 'reads.jsonl') }
}

describe('smoke history reader', () => {
  it('records the hash it served and the hash the frozen id demands', async () => {
    const { connection, readsFile } = await reader(index => ['first body ✓', 'middle body', 'last body 🚀'][index])
    await readFrozenHistory(connection, 'run-1', readsFile)
    const logged = JSON.parse((await readFile(readsFile, 'utf8')).trim()) as {
      reads: Array<{ id: string; characters: number; hash: string; expectedHash: string }>
    }
    expect(logged.reads).toHaveLength(3)
    for (const read of logged.reads) {
      expect(read.expectedHash).toBe(frozenHashOf(read.id))
      expect(read.hash).toBe(read.expectedHash)
    }
    expect(logged.reads.map(read => read.characters)).toEqual(['first body ✓'.length, 'middle body'.length, 'last body 🚀'.length])
  })

  it('fails when the served text has the right length but the wrong bytes', async () => {
    const correct = ['first body ✓', 'middle body', 'last body 🚀']
    // Same character count, different content: a length-only check would pass this.
    const { connection, readsFile } = await reader(index => correct[index].replace(/./gsu, 'x'))
    await expect(readFrozenHistory(connection, 'run-1', readsFile))
      .rejects.toThrow('does not match the frozen hash')
    const logged = JSON.parse((await readFile(readsFile, 'utf8')).trim()) as { error: string }
    expect(logged.error).toMatch(/does not match the frozen hash/)
  })

  it('refuses an item id that is not a frozen tuple', () => {
    expect(() => frozenHashOf('plain-id')).toThrow('is not a frozen tuple')
    expect(frozenHashOf(JSON.stringify(['run', 'item', 'abc']))).toBe('abc')
  })
})
