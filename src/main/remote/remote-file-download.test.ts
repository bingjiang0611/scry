import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, globalAgent, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { RemoteFileDownloads, parseRemoteFileDownloadQuery, type RemoteFileDownloadResult } from './remote-file-download'

const roots: string[] = []
const readers: RemoteFileDownloads[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  readers.splice(0).forEach(reader => reader.dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections()
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-file-download-')); roots.push(root)
  const cwd = join(root, 'project'), home = join(root, 'home')
  await Promise.all([mkdir(cwd), mkdir(home)])
  let allowed = true, peerAllowed = true
  const authorize = () => { if (!peerAllowed) throw new Error('device_not_authorized') }
  const reader = new RemoteFileDownloads({ authorize(value) {
    if (!allowed || value !== cwd) throw new Error('workspace_not_authorized')
    return cwd
  } }, home)
  readers.push(reader)
  return { root, cwd, home, reader, authorize, revokeWorkspace: () => { allowed = false }, revokePeer: () => { peerAllowed = false } }
}
async function collect(f: Awaited<ReturnType<typeof fixture>>, target: string) {
  const chunks: Buffer[] = []
  let page = await f.reader.read('peer', { action: 'open', cwd: f.cwd, target }, f.authorize)
  const first = page
  while (page.kind === 'page') {
    chunks.push(Buffer.from(page.data, 'base64'))
    if (!page.hasMore) break
    page = await f.reader.read('peer', { action: 'read', cwd: f.cwd, id: page.id, offset: page.nextOffset }, f.authorize)
  }
  return { bytes: Buffer.concat(chunks), first, last: page }
}
function page(result: RemoteFileDownloadResult) {
  if (result.kind !== 'page') throw new Error('expected page')
  return result
}
async function serve(handler: RequestListener) {
  const server = createServer(handler); servers.push(server)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

describe('explicit owner file download', () => {
  it('does not route a Mac-local read through the process-global HTTP agent', async () => {
    const f = await fixture()
    const url = await serve((_request, response) => response.end('direct local bytes'))
    const sharedAgent = vi.spyOn(globalAgent, 'createConnection').mockImplementation(() => { throw new Error('ambient proxy agent used') })
    expect((await collect(f, url)).bytes.toString()).toBe('direct local bytes')
    expect(sharedAgent).not.toHaveBeenCalled()
  })
  it('distinguishes explicitly selected scheme-like filenames from HTTP targets', async () => {
    const f = await fixture()
    for (const name of ['notes:2026.bin', 'http:report.txt']) {
      await writeFile(join(f.cwd, name), 'literal file bytes')
      expect((await collect(f, './' + name)).bytes.toString()).toBe('literal file bytes')
    }
  })
  it('downloads exact binary bytes across pages, including unknown extensions and executable files', async () => {
    const f = await fixture()
    const bytes = Buffer.alloc(700_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    await writeFile(join(f.cwd, 'anything.unknown'), bytes, { mode: 0o700 })
    const result = await collect(f, 'anything.unknown')
    expect(createHash('sha256').update(result.bytes).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(page(result.first)).toMatchObject({ offset: 0, nextOffset: 256 * 1024, hasMore: true, name: 'anything.unknown', totalBytes: bytes.length })
    expect(page(result.last)).toMatchObject({ hasMore: false, nextOffset: bytes.length })
    expect(Buffer.byteLength(JSON.stringify(result.first))).toBeLessThan(512 * 1024)
  })
  it('opens home, absolute outside-home and symlink targets without granting sibling or directory access', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside.pdf')
    await writeFile(outside, Buffer.from([0, 1, 2, 255]))
    await writeFile(join(f.home, 'a.txt'), 'home')
    await symlink(outside, join(f.cwd, 'link'))
    expect((await collect(f, '~/a.txt')).bytes.toString()).toBe('home')
    expect((await collect(f, outside)).bytes).toEqual(await readFile(outside))
    expect((await collect(f, 'link')).bytes).toEqual(await readFile(outside))
    expect((await collect(f, new URL(`file://${outside}`).href)).bytes).toEqual(await readFile(outside))
    await expect(collect(f, f.home)).rejects.toThrow('not_a_regular_file')
    await expect(collect(f, 'missing')).rejects.toThrow()
  })
  it('rejects cross-peer handles, altered offsets, replacement and workspace/peer revocation', async () => {
    const f = await fixture()
    const path = join(f.cwd, 'large.bin')
    await writeFile(path, Buffer.alloc(600_000))
    const first = page(await f.reader.read('peer', { action: 'open', cwd: f.cwd, target: path }, f.authorize))
    const query = { action: 'read' as const, cwd: f.cwd, id: first.id, offset: first.nextOffset }
    await expect(f.reader.read('other', query, f.authorize)).rejects.toThrow('file_download_context_mismatch')
    await expect(f.reader.read('peer', { ...query, offset: 1 }, f.authorize)).rejects.toThrow('invalid_file_offset')
    await writeFile(path, Buffer.alloc(600_001))
    await expect(f.reader.read('peer', query, f.authorize)).rejects.toThrow('file_download_changed')
    const next = page(await f.reader.read('peer', { action: 'open', cwd: f.cwd, target: path }, f.authorize))
    f.revokePeer()
    await expect(f.reader.read('peer', { ...query, id: next.id }, f.authorize)).rejects.toThrow('device_not_authorized')
    f.revokeWorkspace()
    await expect(f.reader.read('peer', query, () => {})).rejects.toThrow('workspace_not_authorized')
  })
  it('bounds simultaneous downloads and releases handles explicitly', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, 'large.bin'), Buffer.alloc(600_000))
    const first = page(await f.reader.read('peer', { action: 'open', cwd: f.cwd, target: 'large.bin' }, f.authorize))
    await f.reader.read('peer', { action: 'open', cwd: f.cwd, target: 'large.bin' }, f.authorize)
    await expect(f.reader.read('peer', { action: 'open', cwd: f.cwd, target: 'large.bin' }, f.authorize)).rejects.toThrow('file_download_capacity')
    await f.reader.read('peer', { action: 'close', cwd: f.cwd, id: first.id }, f.authorize)
    expect(page(await f.reader.read('peer', { action: 'open', cwd: f.cwd, target: 'large.bin' }, f.authorize)).offset).toBe(0)
  })
  it('fetches the actual loopback resource with query, not a same-named project file', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, 'bolder-v1.html'), 'WRONG ROOT')
    const requests: string[] = []
    const url = await serve((req, res) => {
      requests.push(req.url!)
      expect(req.headers.cookie).toBeUndefined(); expect(req.headers.authorization).toBeUndefined()
      res.setHeader('Content-Type', 'text/html'); res.end('<h1>ACTUAL SERVED SUBDIRECTORY</h1>')
    })
    const result = await collect(f, `${url}/bolder-v1.html?exact=1`)
    expect(result.bytes.toString()).toBe('<h1>ACTUAL SERVED SUBDIRECTORY</h1>')
    expect(requests).toEqual(['/bolder-v1.html?exact=1'])
  })
  it('streams chunked HTTP bytes and follows only same-origin redirects', async () => {
    const f = await fixture()
    const bytes = Buffer.alloc(700_000, 123)
    const url = await serve((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/data' }); res.end(); return }
      if (req.url === '/escape') { res.writeHead(302, { Location: 'http://example.com/' }); res.end(); return }
      res.write(bytes.subarray(0, 300_000)); res.end(bytes.subarray(300_000))
    })
    expect((await collect(f, `${url}/redirect`)).bytes).toEqual(bytes)
    await expect(collect(f, `${url}/escape`)).rejects.toThrow('invalid_local_url')
  })
  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const)('decodes %s HTTP bodies and preserves download names and MIME evidence', async (encoding, compress) => {
    const f = await fixture()
    const bytes = Buffer.alloc(600_000, 217)
    const url = await serve((_req, res) => {
      const encoded = compress(bytes)
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Encoding': encoding,
        'Content-Length': encoded.length, 'Content-Disposition': "attachment; filename*=UTF-8''example%20file.pdf" })
      res.end(encoded)
    })
    const result = await collect(f, `${url}/download`)
    expect(result.bytes).toEqual(bytes)
    expect(page(result.first)).toMatchObject({ name: 'example file.pdf', mimeType: 'application/pdf', totalBytes: null })
    expect(page(result.last).totalBytes).toBe(bytes.length)
  })

  it('rejects non-loopback, credentials, schemes and malformed query data before requesting', async () => {
    const f = await fixture()
    for (const target of ['http://example.com/', 'http://127.evil.com/', 'http://user:pass@127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://192.168.1.2/', 'data:text/plain,hi', 'file://remote/etc/passwd']) {
      await expect(collect(f, target)).rejects.toThrow()
    }
    expect(parseRemoteFileDownloadQuery({ action: 'open', cwd: f.cwd, target: '/tmp/a.pdf' })).toMatchObject({ target: '/tmp/a.pdf' })
    for (const query of [{ action: 'read', cwd: f.cwd, id: 'a', offset: -1 }, { action: 'open', cwd: f.cwd, target: 'a\0b' }, { action: 'open', cwd: f.cwd, target: 'a', write: true }]) {
      expect(() => parseRemoteFileDownloadQuery(query)).toThrow('invalid_request')
    }
  })
})
