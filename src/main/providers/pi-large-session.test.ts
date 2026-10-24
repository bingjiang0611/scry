import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, chmod, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPiAdapter } from './pi'
import { piProfileForExecutable } from '../pi-agent-profiles'
import * as locate from '../claude-locate'
import { providerRecordingPolicy } from '../provider-recording-policy'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(mode: 'large' | 'replace' | 'replace-failed' | 'mismatch') {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'scry-pi-entry-proof-')))
  directories.push(cwd)
  const sessionFile = join(cwd, 'session.jsonl')
  const header = JSON.stringify({ type: 'session', id: 'native-session' }) + '\n'
  await writeFile(sessionFile, header + '{"type":"custom","id":"history","parentId":null,"padding":"')
  const file = await open(sessionFile, 'a')
  try {
    // Valid JSONL larger than the old 128MiB cap, without a giant test allocation.
    const chunk = Buffer.alloc(1024 * 1024, 'x')
    for (let i = 0; i < (mode === 'large' ? 129 : 1); i++) await file.write(chunk)
  } finally { await file.close() }
  await appendFile(sessionFile, '"}\n')
  const executable = join(cwd, 'fixture-pi')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
const sessionFile = ${JSON.stringify(sessionFile)}
const entries = [{ type: 'custom', id: 'history', parentId: null }]
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line)
  let data = {}
  if (command.type === 'get_state') data = { sessionId: 'native-session', sessionFile, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
  if (command.type === 'get_available_models') data = { models: [] }
  if (command.type === 'get_commands') data = { commands: [] }
  if (command.type === 'get_entries') data = { entries: command.since ? entries.slice(entries.findIndex(row => row.id === command.since) + 1) : entries, leafId: entries.at(-1).id }
  if (command.type === 'prompt') {
    const entry = { type: 'message', id: 'user-new', parentId: 'history', message: { role: 'user', content: command.message } }
    entries.push(entry)
    if (${JSON.stringify(mode)}.startsWith('replace')) {
      fs.renameSync(sessionFile, sessionFile + '.old')
      fs.writeFileSync(sessionFile, ${JSON.stringify(header)})
    }
    const persisted = ${JSON.stringify(mode)} === 'mismatch' ? { ...entry, message: { role: 'user', content: 'different input' } } : entry
    fs.appendFileSync(sessionFile, JSON.stringify(persisted) + '\\n')
    send({ type: 'agent_start' })
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: ${JSON.stringify(mode === 'replace-failed' ? 'error' : 'stop')}, ${mode === 'replace-failed' ? "errorMessage: 'upstream failure'" : ''} } })
    send({ type: 'agent_end', messages: [] })
    send({ type: 'agent_settled' })
  }
  send({ type: 'response', id: command.id, command: command.type, success: true, data })
})
`)
  await chmod(executable, 0o755)
  vi.spyOn(locate, 'shellEnv').mockReturnValue({ PATH: dirname(process.execPath), HOME: cwd, PI_AGENT_NODE: process.execPath })
  const profile = piProfileForExecutable(executable)
  const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
  const handle = adapter.run({ runId: 'proof-run', prompt: '继续检查中文消息', cwd, resume: 'native-session', agentProfileId: profile.id,
    attachments: [], permissionMode: 'full_access', trackInputReceipt: true, emit: vi.fn() })
  return { adapter, handle }
}

describe('Pi persisted input proof through a real RPC child', () => {
  it('accepts an exact new user entry after more than 128MiB of valid history', async () => {
    const { adapter, handle } = await fixture('large')
    try {
      await expect(handle.promise).resolves.toMatchObject({ status: 'completed', externalSessionId: 'native-session', providerTurnId: 'user-new' })
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'accepted', source: 'pi_persisted_session_entry', providerTurnId: 'user-new' })
    } finally { await adapter.dispose?.() }
  })

  it('keeps a successful native outcome separate from unavailable proof and blocks canonical recording', async () => {
    const { adapter, handle } = await fixture('replace')
    try {
      const result = await handle.promise
      expect(result).toMatchObject({ status: 'completed', recordingFailure: { message: expect.stringContaining('被替换') } })
      expect(result.providerTurnId).toBeUndefined()
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'unknown', reason: expect.stringContaining('被替换') })
      expect(handle.getRecordingFailure?.()).toEqual(result.recordingFailure)
      expect(providerRecordingPolicy('completed', result.recordingFailure)).toMatchObject({ allowCanonicalCommit: false, blockSession: true })
    } finally { await adapter.dispose?.() }
  })

  it('does not hide a real provider failure behind an unavailable receipt', async () => {
    const { adapter, handle } = await fixture('replace-failed')
    try {
      await expect(handle.promise).rejects.toThrow('upstream failure')
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'unknown' })
      expect(providerRecordingPolicy('failed', handle.getRecordingFailure?.())).toMatchObject({ allowCanonicalCommit: false, blockSession: true })
    } finally { await adapter.dispose?.() }
  })

  it('still refuses a persisted message that differs from the dispatched input', async () => {
    const { adapter, handle } = await fixture('mismatch')
    try {
      await expect(handle.promise).rejects.toThrow('未出现 authoritative user session entry')
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'unknown' })
    } finally { await adapter.dispose?.() }
  })
})
