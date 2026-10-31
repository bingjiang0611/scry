import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { takeCustody } from '../dist/custody/index.js'
import { runUpload } from '../dist/uploader.js'
import { fixture } from './fixtures/reliability-fixture.mjs'

async function bareOutbox(t) {
  const context = await fixture(t)
  const recordId = 'b'.repeat(32)
  const identity = { sequence: 1, recordId, workspaceId: 'fixture' }
  const raw = JSON.stringify({
    schemaVersion: 1, sequence: 1, recordId,
    workspace: { id: 'fixture', root: context.root }, provider: 'pi'
  }) + '\n'
  const envelope = {
    version: 1, ...identity, redactionVersion: 'none', record: raw,
    recordBytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex')
  }
  await writeFile(join(context.base, 'outbox', `${'1'.padStart(20, '0')}-${recordId}.json`), JSON.stringify(envelope))
  return { ...context, raw, recordId, envelope }
}

test('legacy unowned outbox retains the exact submitted bytes and durable remote ACK', async (t) => {
  const { root, env, base, raw, recordId } = await bareOutbox(t)
  assert.equal((await runUpload(root, { env })).uploaded, 1)
  const receipt = JSON.parse(await readFile(join(base, 'receipts', `${recordId}.json`)))
  assert.equal(receipt.status, 'uploaded')
  assert.equal(receipt.remoteStatus, 'inserted')
  assert.equal(receipt.sha256, createHash('sha256').update(raw).digest('hex'))
  assert.equal(await readFile(join(base, 'outbox/committed', `${'1'.padStart(20, '0')}-${recordId}.json`), 'utf8'), raw)
})

test('legacy ACK preserves both canonical custody and the submitted legacy variant', async (t) => {
  const { root, env, base, raw, recordId, envelope } = await bareOutbox(t)
  const name = `${'1'.padStart(20, '0')}-${recordId}.json`
  await writeFile(join(root, '.scry/records', name), raw)
  await takeCustody(root, { sequence: 1, recordId })
  const legacy = JSON.stringify({ ...JSON.parse(raw), workspace: { id: 'fixture', root: '<workspace>' } })
  await writeFile(join(base, 'outbox', name), JSON.stringify({
    ...envelope, redactionVersion: 'agent-turn-v1', record: legacy,
    recordBytes: Buffer.byteLength(legacy), sha256: createHash('sha256').update(legacy).digest('hex')
  }))
  assert.equal((await runUpload(root, { env })).uploaded, 1)
  assert.equal(await readFile(join(base, 'outbox/committed', name), 'utf8'), raw)
  assert.equal(await readFile(join(base, 'outbox/committed/legacy', name), 'utf8'), legacy)
})
