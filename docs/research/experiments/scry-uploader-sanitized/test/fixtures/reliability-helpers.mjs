import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { custodyContentPath } from '../../dist/content.js'
import { takeCustody, uploadRoot } from '../../dist/uploader.js'

export const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export const filename = (sequence, recordId) => `${String(sequence).padStart(20, '0')}-${recordId}.json`

export async function custody(root, sequence = 1, extra = {}) {
  const recordId = sequence.toString(16).padStart(32, '0')
  const value = {
    schemaVersion: 1,
    sequence,
    recordId,
    workspace: { id: 'fixture', root },
    sessionId: 'session',
    provider: 'pi',
    ...extra
  }
  const raw = JSON.stringify(value, null, 2) + '\n'
  const name = filename(sequence, recordId)
  await writeFile(join(root, '.scry/records', name), raw)
  const event = {
    schemaVersion: 2,
    event: 'record-committed',
    workspace: root,
    provider: 'pi',
    sessionId: 'session',
    sequence,
    recordId,
    recordPath: `records/${name}`,
    sha256: hash(raw)
  }
  await takeCustody(root, event)
  return { value, raw, event, path: join(uploadRoot(root), 'outbox', name) }
}

export async function envelope(record, text = record.raw, version = 'none', extra = {}) {
  const value = {
    version: 1,
    sequence: record.value.sequence,
    recordId: record.value.recordId,
    workspaceId: 'fixture',
    redactionVersion: version,
    recordBytes: Buffer.byteLength(text),
    sha256: hash(text),
    record: text,
    ...extra
  }
  await writeFile(record.path, JSON.stringify(value))
  return value
}

export async function receipt(base, recordId) {
  return JSON.parse(await readFile(join(base, 'receipts', `${recordId}.json`), 'utf8'))
}
export async function calls(env) {
  return (await readFile(env.FAKE_TRANSPORT_LOG, 'utf8')).trim().split('\n').map(JSON.parse)
}

export async function contentCustody(root) {
  const body = '完整中文内容\n'.repeat(20_000)
  const sha256 = hash(body)
  const directory = join(root, '.scry/content/sha256', sha256.slice(0, 2))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${sha256}.bin`), body)
  const record = await custody(root, 1, { tools: { value: [{
    outputContent: { content: 'preview', truncated: true,
      contentRef: { storage: 'recorder-content-v1', sha256, bytes: Buffer.byteLength(body), encoding: 'utf8' } }
  }] } })
  return { record, body, sha256 }
}

