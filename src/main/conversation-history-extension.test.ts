import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { createConversationHistoryReader } from './conversation-history-reader'

it('keeps the owned Pi reader off the environment proxy, rechecks active tools, and honors cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scry-history-extension-'))
  const text = 'history Ω 😀\n'.repeat(200)
  const contentHash = createHash('sha256').update(text).digest('hex')
  const reader = await createConversationHistoryReader([{ ref: { runId: 'source', itemId: 'assistant', contentHash }, text }])
  let proxyRequests = 0
  const proxy = createServer((_request, response) => { proxyRequests++; response.writeHead(403).end() })
  proxy.on('connect', (_request, socket) => { proxyRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n') })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture proxy address')
  const proxyUrl = `http://127.0.0.1:${address.port}`
  try {
    // Only the host's schema constructors are stubbed. The shipped extension,
    // HTTP client, proxy environment and reader server are executed unchanged.
    const executable = join(directory, 'probe.mjs')
    await build({
      stdin: { contents: `
        import extension from ${JSON.stringify(resolve('resources/scry-history/pi-history-reader.mjs'))}
        import { createHash } from 'node:crypto'
        const commands = new Map(), tools = new Map(), notices = []
        let active = true
        extension({ registerCommand: (name, command) => commands.set(name, command),
          registerTool: tool => tools.set(tool.name, tool),
          getAllTools: () => [...tools.values()], getActiveTools: () => active ? [...tools.keys()] : [] })
        const context = { ui: { notify: text => notices.push(text) } }
        const ready = commands.get(${JSON.stringify(`scry_history_ready_${reader.connection.snapshotId.replaceAll('-', '')}`)}).handler
        await ready('', context)
        await ready('', context)
        const tool = tools.get('scry_thread_read')
        const read = async args => JSON.parse((await tool.execute('call', args)).content[0].text)
        const manifest = await read({})
        let offset = 0, text = '', pages = 0
        do {
          const page = await read({ itemId: manifest.items[0].id, offset })
          text += page.text; pages++; offset = page.nextOffset
        } while (offset !== null)
        active = false
        let inactiveError, abortError
        try { await ready('', context) } catch (error) { inactiveError = error.message }
        const abort = new AbortController(); abort.abort()
        try { await tool.execute('abort', {}, abort.signal) } catch (error) { abortError = error.name }
        console.log(JSON.stringify({ notices, pages, hash: createHash('sha256').update(text).digest('hex'), inactiveError, abortError,
          authorityRemoved: !process.env.SCRY_HISTORY_READER_TOKEN && !process.env.SCRY_HISTORY_READER_URL && !process.env.SCRY_HISTORY_READER_SNAPSHOT }))
      `, resolveDir: process.cwd(), loader: 'js' },
      outfile: executable, bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'host-schema-fixture', setup(builder) {
        builder.onResolve({ filter: /^@sinclair\/typebox$/ }, () => ({ path: 'schema', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const Type = {
          String: () => ({ type: 'string' }), Integer: options => ({ type: 'integer', ...options }),
          Optional: schema => schema, Object: (properties, options) => ({ type: 'object', properties, ...options })
        }` }))
      } }]
    })
    const { stdout } = await promisify(execFile)(process.execPath, [executable], {
      env: { PATH: process.env.PATH, HOME: directory, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl,
        NODE_USE_ENV_PROXY: '1', NO_PROXY: '', no_proxy: '', SCRY_HISTORY_READER_URL: reader.connection.url,
        SCRY_HISTORY_READER_TOKEN: reader.connection.token, SCRY_HISTORY_READER_SNAPSHOT: reader.connection.snapshotId },
      timeout: 10_000, maxBuffer: 64 * 1024
    })
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({
      hash: contentHash, notices: Array(2).fill(`scry_history_ready:${reader.connection.snapshotId}`),
      inactiveError: 'Scry history reader is not active', abortError: 'AbortError', authorityRemoved: true
    })
    expect(result.pages).toBeGreaterThan(1)
    expect(proxyRequests).toBe(0)
  } finally {
    await reader.close()
    proxy.closeAllConnections()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
