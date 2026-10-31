import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { encodeRecordForWire } from '../dist/wire.js'

test('encodeRecordForWire uses a transparent gzip envelope only when smaller', () => {
  const raw = JSON.stringify({ recordId: 'a'.repeat(32), text: 'repeat '.repeat(2_000) })
  const wire = JSON.parse(encodeRecordForWire(raw))
  assert.equal(wire.scryEncoding, 'gzip-base64')
  assert.equal(gunzipSync(Buffer.from(wire.payload, 'base64')).toString('utf8'), raw)
  assert.equal(encodeRecordForWire('{"x":1}'), '{"x":1}')
})
