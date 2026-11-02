import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { captureContent, contentRecord, validateContent, MAX_DECODED_RECORD_BYTES } from '../dist/content.js'
import { encodeRecordForWire } from '../dist/wire.js'

const hash = raw => createHash('sha256').update(raw).digest('hex')
const reference = (body, encoding = 'utf8') => ({ storage: 'recorder-content-v1', sha256: hash(body), bytes: Buffer.byteLength(body), encoding })
const blob = body => ({ sha256: hash(body), bytes: Buffer.byteLength(body), dataBase64: Buffer.from(body).toString('base64') })
const unpack = wire => {
  const value = JSON.parse(wire)
  return value.scryEncoding === 'gzip-base64' ? JSON.parse(gunzipSync(Buffer.from(value.payload, 'base64'))) : value
}

test('cross-language golden packet preserves canonical bytes and 230000 UTF-8 body bytes', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/content-v1.json', import.meta.url), 'utf8'))
  const packet = unpack(fixture.transport)
  validateContent(packet.recordJson, packet.contentJson)
  assert.equal(packet.recordJson, fixture.recordJson)
  assert.equal(hash(packet.contentJson), fixture.contentSha256)
  const raw = Buffer.from(JSON.parse(packet.contentJson)[0].dataBase64, 'base64')
  assert.equal(raw.length, fixture.bodyBytes)
  assert.equal(hash(raw), fixture.blobSha256)
  assert.equal(raw.toString('utf8'), '完整工具正文🌍\n'.repeat(10000))
  assert.deepEqual(unpack(encodeRecordForWire(contentRecord(packet.recordJson, packet.contentJson))), packet)
})

test('manifest must cover each reference exactly once with correct bytes, encoding and hash', () => {
  const canonical = JSON.stringify({ ref: reference('abc') })
  for (const list of [[], [blob('abc'), blob('abc')], [blob('xyz')], [blob('abc'), blob('xyz')],
    [{ ...blob('abc'), bytes: 2 }], [{ ...blob('abc'), dataBase64: 'YW Jj' }]])
    assert.throws(() => validateContent(canonical, JSON.stringify(list)))
  assert.throws(() => validateContent(JSON.stringify(reference('not json', 'json')), JSON.stringify([blob('not json')])))
  const invalidUtf8 = Buffer.from([0xff])
  assert.throws(() => validateContent(JSON.stringify(reference(invalidUtf8)), JSON.stringify([blob(invalidUtf8)])))
  assert.throws(() => contentRecord('{}', 'x'.repeat(MAX_DECODED_RECORD_BYTES)))
  for (const canonical of ['null', '[]', '{"scryEncoding":"gzip-base64","payload":"x"}'])
    assert.throws(() => validateContent(canonical, '[]'), { code: 'content_integrity' })
  assert.throws(() => validateContent(JSON.stringify({ ...reference('abc'), bytes: MAX_DECODED_RECORD_BYTES + 1 }), '[]'), { code: 'content_integrity' })
})

test('custody rejects missing, corrupt and escaping source blobs instead of accepting preview-only records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'scry-content-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = join(root, '.scry')
  const ref = reference('abc')
  const directory = join(data, 'content', 'sha256', ref.sha256.slice(0, 2))
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${ref.sha256}.bin`)
  const canonical = JSON.stringify({ ref })
  await assert.rejects(() => captureContent(data, canonical), { code: 'ENOENT' })
  await writeFile(path, 'abd')
  await assert.rejects(() => captureContent(data, canonical), { code: 'content_integrity' })
  await rm(path)
  const outside = join(root, 'outside')
  await writeFile(outside, 'abc')
  await symlink(outside, path)
  await assert.rejects(() => captureContent(data, canonical), { code: 'content_integrity' })
})
