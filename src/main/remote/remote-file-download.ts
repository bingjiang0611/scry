import { randomUUID } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline, type Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { HomeFileAccess } from '../home-file-access'
import type { WorkspaceAuthorizer } from './remote-run-policy'

const CHUNK_BYTES = 256 * 1024
const IDLE_MS = 120_000
const READ_MS = 8_000
const MAX_DOWNLOADS = 8
const MAX_PEER_DOWNLOADS = 2

export type RemoteFileDownloadQuery =
  | { action: 'open'; cwd: string; target: string }
  | { action: 'read'; cwd: string; id: string; offset: number }
  | { action: 'close'; cwd: string; id: string }
export type RemoteFileDownloadResult =
  | { kind: 'page'; id: string; name: string; mimeType?: string; totalBytes: number | null; offset: number; nextOffset: number; data: string; hasMore: boolean }
  | { kind: 'closed' }

type LocalFile = { kind: 'file'; path: string; stamp: string; check(): Promise<string> }
type HTTPFile = { kind: 'http'; response: IncomingMessage; body: Readable; iterator: AsyncIterator<Buffer>; pending: Buffer; ended: boolean }
type OpenedFile = { name: string; mimeType?: string; totalBytes: number | null; source: LocalFile | HTTPFile }
type Download = OpenedFile & { peer: string; cwd: string; offset: number; timer: ReturnType<typeof setTimeout>; busy: boolean }

export function parseRemoteFileDownloadQuery(value: unknown): RemoteFileDownloadQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request')
  const query = value as Record<string, unknown>
  const text = (key: string): string => {
    const field = query[key]
    if (typeof field !== 'string' || !field || field.length > 4096 || /[\0\r\n]/.test(field)) throw new Error('invalid_request')
    return field
  }
  const cwd = text('cwd')
  const keys = query.action === 'open' ? ['action', 'cwd', 'target'] : query.action === 'read' ? ['action', 'cwd', 'id', 'offset'] : ['action', 'cwd', 'id']
  if (Object.keys(query).some(key => !keys.includes(key))) throw new Error('invalid_request')
  if (query.action === 'open') {
    const target = text('target')
    if (/^https?:/i.test(target)) loopbackURL(target)
    return { action: 'open', cwd, target }
  }
  const id = text('id')
  if (query.action === 'close') return { action: 'close', cwd, id }
  if (query.action !== 'read' || !Number.isSafeInteger(query.offset) || Number(query.offset) < 0) throw new Error('invalid_request')
  return { action: 'read', cwd, id, offset: Number(query.offset) }
}

function loopbackURL(target: string): URL {
  const url = new URL(target)
  decodeURIComponent(url.pathname)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !(host === 'localhost' || host.endsWith('.localhost') || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127'))) {
    throw new Error('invalid_local_url')
  }
  return url
}

// No ambient cookies/auth, DNS resolution, proxy environment, or off-origin
// redirects. Only the explicitly clicked Mac loopback URL is requested (GET).
async function localResponse(url: URL, signal: AbortSignal, redirects = 0): Promise<{ response: IncomingMessage; url: URL }> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', signal, agent: false, headers: { 'Accept-Encoding': 'identity' }, maxHeaderSize: 16 * 1024,
      lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4)
    }, resolve)
    req.setTimeout(READ_MS, () => req.destroy(new Error('file_download_timeout')))
    req.on('error', reject)
    req.end()
  })
  if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.destroy()
    const next = loopbackURL(new URL(response.headers.location, url).href)
    if (next.origin !== url.origin || redirects >= 5) throw new Error('local_url_redirect_rejected')
    return localResponse(next, signal, redirects + 1)
  }
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy()
    throw new Error(`local_http_${response.statusCode ?? 'unavailable'}`)
  }
  // Idle/close errors must not escape while the phone is between chunks. The
  // async iterator still rejects them when the next explicit read arrives.
  response.on('error', () => {})
  return { response, url }
}

function httpFileName(url: URL, response: IncomingMessage): string {
  const disposition = response.headers['content-disposition'] ?? ''
  const extended = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)
  const plain = /(?:^|;)\s*filename=(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(disposition)
  const supplied = extended ? decodeURIComponent(extended[1]) : plain ? (plain[1] ?? plain[2]).replace(/\\(.)/g, '$1').trim() : undefined
  let name = basename(supplied ?? decodeURIComponent(url.pathname)) || 'download'
  if (!supplied && (response.headers['content-type'] ?? '').startsWith('text/html') && !/\.html?$/i.test(name)) name += '.html'
  if (name === '.' || name === '..' || name.includes('\0') || Buffer.byteLength(name) > 255) throw new Error('invalid_download_filename')
  return name
}

async function openHTTP(target: string, signal: AbortSignal): Promise<OpenedFile> {
  const { response, url } = await localResponse(loopbackURL(target), signal)
  try {
    const name = httpFileName(url, response)
    const encoding = response.headers['content-encoding']?.toLowerCase()
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined
    if (encoding && encoding !== 'identity' && !decoder) throw new Error('local_http_encoded_response')
    const body = decoder ?? response
    if (decoder) pipeline(response, decoder, () => {}) // pipeline propagates errors and closes both streams.
    body.on('error', () => {})
    const length = response.headers['content-length']
    const totalBytes = !decoder && length !== undefined && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null
    const mimeType = response.headers['content-type']?.split(';')[0].trim().toLowerCase()
    return { name, mimeType, totalBytes,
      source: { kind: 'http', response, body, iterator: body[Symbol.asyncIterator](), pending: Buffer.alloc(0), ended: false } }
  } catch (error) { response.destroy(); throw error }
}

function stamp(info: Awaited<ReturnType<typeof stat>>): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
}

async function openFile(cwd: string, target: string, home: string): Promise<OpenedFile> {
  const access = new HomeFileAccess(home)
  const pathText = /^file:/i.test(target) ? fileURLToPath(target) : target
  if (/^[a-z][a-z\d+.-]*:/i.test(pathText)) throw new Error('invalid_file_target')
  const resolved = await access.resolveFile({ cwd, path: pathText })
  const check = async (): Promise<string> => {
    const approved = access.isReadOnlyTarget(resolved.cwd) ? await access.authorize(resolved) : resolved
    return realpath(join(approved.cwd, approved.path))
  }
  const path = await check()
  const info = await stat(path)
  if (!info.isFile()) throw new Error('not_a_regular_file')
  return { name: basename(path), totalBytes: info.size, source: { kind: 'file', path, stamp: stamp(info), check } }
}

function closeSource(source: LocalFile | HTTPFile, error?: Error): void {
  if (source.kind !== 'http') return
  source.response.destroy(error)
  source.body.destroy(error)
}

async function readChunk(download: Download): Promise<{ bytes: Buffer; hasMore: boolean }> {
  const { source, offset } = download
  if (source.kind === 'file') {
    if (await source.check() !== source.path) throw new Error('file_download_changed')
    const file = await open(source.path, 'r')
    try {
      if (stamp(await file.stat()) !== source.stamp) throw new Error('file_download_changed')
      const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, download.totalBytes! - offset))
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read)
        if (bytesRead === 0) throw new Error('file_download_changed')
        read += bytesRead
      }
      if (stamp(await file.stat()) !== source.stamp || await source.check() !== source.path) throw new Error('file_download_changed')
      return { bytes, hasMore: offset + bytes.length < download.totalBytes! }
    } finally { await file.close() }
  }
  const parts: Buffer[] = []
  let length = 0
  while (length < CHUNK_BYTES && !source.ended) {
    if (!source.pending.length) {
      const next = await source.iterator.next()
      if (next.done) { source.ended = true; break }
      source.pending = Buffer.from(next.value)
    }
    const take = Math.min(CHUNK_BYTES - length, source.pending.length)
    parts.push(source.pending.subarray(0, take))
    length += take
    source.pending = source.pending.subarray(take)
  }
  if (source.ended) {
    if (download.totalBytes !== null && offset + length !== download.totalBytes) throw new Error('file_download_changed')
    download.totalBytes = offset + length
  }
  return { bytes: Buffer.concat(parts, length), hasMore: !source.ended }
}

// Dedicated single-file capability, not a directory grant or a broader workspace
// browser. Eight streams/two per peer, 256 KiB chunks, 120s idle expiry, 8s per HTTP
// open/read. No file-type filter or whole-file memory/size allocation is needed.
export class RemoteFileDownloads {
  #downloads = new Map<string, Download>()
  #openings = new Map<string, { peer: string; abort: AbortController }>()
  private readonly workspace: WorkspaceAuthorizer
  private readonly home: string
  constructor(workspace: WorkspaceAuthorizer, home = homedir()) {
    this.workspace = workspace
    this.home = home
  }

  #drop(id: string, error?: Error): void {
    const download = this.#downloads.get(id)
    if (!download) return
    clearTimeout(download.timer)
    closeSource(download.source, error)
    this.#downloads.delete(id)
  }
  dispose(): void {
    for (const opening of this.#openings.values()) opening.abort.abort()
    this.#openings.clear()
    for (const id of this.#downloads.keys()) this.#drop(id)
  }

  async read(peer: string, query: RemoteFileDownloadQuery, authorize: () => void): Promise<RemoteFileDownloadResult> {
    authorize()
    const cwd = this.workspace.authorize(query.cwd)
    const id = query.action === 'open' ? randomUUID() : query.id
    let download = this.#downloads.get(id)
    if (query.action === 'open') {
      const peers = [...this.#downloads.values(), ...this.#openings.values()]
      if (peers.length >= MAX_DOWNLOADS || peers.filter(entry => entry.peer === peer).length >= MAX_PEER_DOWNLOADS) throw new Error('file_download_capacity')
      const abort = new AbortController()
      const deadline = setTimeout(() => abort.abort(new Error('file_download_timeout')), READ_MS).unref()
      this.#openings.set(id, { peer, abort })
      let opened: OpenedFile | undefined
      try {
        opened = /^https?:/i.test(query.target) ? await openHTTP(query.target, abort.signal) : await openFile(cwd, query.target, this.home)
        abort.signal.throwIfAborted()
        authorize()
        if (this.workspace.authorize(query.cwd) !== cwd || !this.#openings.has(id)) throw new Error('file_download_expired')
        download = { ...opened, peer, cwd, offset: 0, busy: false,
          timer: setTimeout(() => this.#drop(id), IDLE_MS).unref() }
        this.#downloads.set(id, download)
      } catch (error) {
        if (opened) closeSource(opened.source)
        throw error
      } finally {
        clearTimeout(deadline)
        this.#openings.delete(id)
      }
    }
    if (!download) {
      if (query.action === 'close') return { kind: 'closed' }
      throw new Error('file_download_expired')
    }
    if (download.peer !== peer || download.cwd !== cwd) throw new Error('file_download_context_mismatch')
    if (query.action === 'close') { this.#drop(id); return { kind: 'closed' } }
    if (download.busy) throw new Error('file_download_busy')
    if (query.action === 'read' && query.offset !== download.offset) throw new Error('invalid_file_offset')
    download.busy = true
    const deadline = setTimeout(() => this.#drop(id, new Error('file_download_timeout')), READ_MS).unref()
    try {
      const offset = download.offset
      const { bytes, hasMore } = await readChunk(download)
      authorize()
      if (this.workspace.authorize(query.cwd) !== cwd || !this.#downloads.has(id)) throw new Error('file_download_expired')
      download.offset += bytes.length
      download.timer.refresh()
      const result: RemoteFileDownloadResult = { kind: 'page', id, name: download.name,
        ...(download.mimeType ? { mimeType: download.mimeType } : {}), totalBytes: download.totalBytes,
        offset, nextOffset: download.offset, data: bytes.toString('base64'), hasMore }
      if (!hasMore) this.#drop(id)
      return result
    } catch (error) {
      this.#drop(id)
      throw error
    } finally {
      clearTimeout(deadline)
      download.busy = false
    }
  }
}
