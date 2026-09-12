import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeWire } from './generated/wire.mjs'

const corpus = JSON.parse(await readFile(new URL('wire-corpus.json', import.meta.url), 'utf8'))
for (const fixture of corpus) {
  test('wire: ' + fixture.name, () => {
    if (fixture.valid) assert.deepEqual(decodeWire(fixture.type, fixture.packet), fixture.packet)
    else assert.throws(() => decodeWire(fixture.type, fixture.packet))
  })
}
test('wire bounds use Unicode scalars consistently with Swift', () => {
  const base = { protocolMajor: 1, requestId: 'request', operation: 'probe.echo', payload: '' }
  assert.doesNotThrow(() => decodeWire('ProbeRequest', { ...base, payload: '🧭'.repeat(4096) }))
  assert.throws(() => decodeWire('ProbeRequest', { ...base, payload: '🧭'.repeat(4097) }))
  assert.throws(() => decodeWire('ProbeRequest', { ...base, requestId: 'x'.repeat(65) }))
  assert.throws(() => decodeWire('ProbeRequest', { ...base, payload: '\ud800' }))
})
