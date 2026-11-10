import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRedactor, redactResults } from './verify/redact.mjs'

const room = '11111111-2222-4333-8444-555555555555'

test('removes identifiers but keeps timings, versions and route evidence', () => {
  const redact = createRedactor(Buffer.from('fixed-salt'))
  const line = `{"diagnostics":{"hostId":"${room}","directRoutes":[{"host":"192.168.1.5","port":47820}],"timings":[{"totalMs":1711.3}]},"history":{"session":"aaaabbbb-cccc-4ddd-8eee-ffff00001111"}}`
  const out = redact(line)
  assert.ok(!out.includes(room))
  assert.ok(!out.includes('aaaabbbb'))
  assert.match(out, /"hostId":"<id:[0-9a-f]{8}>"/)
  assert.ok(out.includes('"totalMs":1711.3'))
  assert.ok(out.includes('192.168.1.5'), 'private LAN addresses are route evidence')
  assert.equal(redact(`host=${room}`), redact(`host=${room}`), 'stable within one redactor')
  const text = [
    'device=00008110-0001112233445566',
    'Signing Identity: "Apple Development: someone@icloud.com (ABCDE12345)"',
    'identityHash=0123456789ABCDEF0123456789ABCDEF01234567',
    '/Users/someone/work/scry/src/a.ts',
    'en0 = 203.0.113.7/19, overlay 100.101.1.2',
    'swift=Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3)',
    'Co-Authored-By: x <307659028+bingjiang0611@users.noreply.github.com>'
  ].join('\n')
  const clean = redact(text)
  for (const secret of ['00008110-0001112233445566', 'someone', 'ABCDE12345', '01234567', '203.0.113.7']) {
    assert.ok(!clean.includes(secret), secret)
  }
  for (const kept of ['100.101.1.2', 'swiftlang-6.3.3.1.3', 'users.noreply.github.com', '/Users/<user>/work/scry']) {
    assert.ok(clean.includes(kept), kept)
  }
  assert.equal(redact(clean), clean, 'idempotent')
})

test('rewrites committed files only, never raw/ or full logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scry-redact-'))
  try {
    mkdirSync(join(dir, 'raw')); mkdirSync(join(dir, 'logs'))
    writeFileSync(join(dir, 'env.txt'), 'device=00008110-0001112233445566\n')
    writeFileSync(join(dir, 'logs', 'x.tail.txt'), `/Users/someone/x ${room}\n`)
    writeFileSync(join(dir, 'logs', 'x.log'), 'device=00008110-0001112233445566\n')
    writeFileSync(join(dir, 'raw', 'netbench.jsonl'), `{"hostId":"${room}"}\n`)
    assert.equal(redactResults(dir), 2)
    assert.equal(readFileSync(join(dir, 'env.txt'), 'utf8'), 'device=<device-udid>\n')
    assert.ok(readFileSync(join(dir, 'raw', 'netbench.jsonl'), 'utf8').includes(room))
    assert.ok(readFileSync(join(dir, 'logs', 'x.log'), 'utf8').includes('00008110'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
