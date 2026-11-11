import { mkdtemp, mkdir, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parsePiNativeHistory, readPiNativeHistory } from './pi-native-history'

const identity = { sessionId: '01a1338c-3d8b-775b-8645-fd964faa29a3', cwd: '/repo' }
const header = { type: 'session', version: 3, id: identity.sessionId, cwd: identity.cwd }
const time = '2026-10-13T04:36:31Z'
const user = { type: 'message', id: 'u', parentId: null, timestamp: time, message: { role: 'user', content: [{ type: 'text', text: 'phone message' }] } }
const assistant = { type: 'message', id: 'a', parentId: 'u', timestamp: time,
  message: { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'pwd' } }] } }
const result = { type: 'message', id: 't', parentId: 'a', timestamp: time,
  message: { role: 'toolResult', toolCallId: 'call1', toolName: 'bash', content: [{ type: 'text', text: '/repo' }] } }
const encode = (...entries: unknown[]): string => [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('streams histories larger than 64 MiB and keeps only the current branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-pi-native-large-'))
  roots.push(root)
  const sessionRoot = join(root, 'sessions')
  const dir = join(sessionRoot, '--repo--')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `large_${identity.sessionId}.jsonl`)
  const file = await open(path, 'w')
  try {
    await file.writeFile(`${encode(user)}\n`)
    const padding = 'x'.repeat(1024 * 1024)
    for (let index = 0; index < 65; index++) {
      await file.writeFile(`${JSON.stringify({ ...assistant, id: `abandoned-${index}`,
        message: { role: 'assistant', content: padding } })}\n`)
    }
    // Include a multi-chunk active record with UTF-8, CRLF and no final newline.
    const reply = { ...assistant, message: { role: 'assistant', content: '你好🙂'.repeat(16000) } }
    await file.writeFile(`${JSON.stringify(reply)}\r\n${JSON.stringify(result)}`)
    expect((await stat(path)).size).toBeGreaterThan(64 * 1024 * 1024)
    const turns = await readPiNativeHistory({ ...identity, sessionRoot })
    expect(turns).toEqual(parsePiNativeHistory(encode(user, reply, result), identity))
    expect(turns?.[0].items[1].output).toBe('/repo')
  } finally {
    await file.close()
  }
})
