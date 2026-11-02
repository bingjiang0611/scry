import assert from 'node:assert/strict'
import test from 'node:test'
import { redactDiagnostic } from '../dist/util.js'

test('diagnostics drop bearer credentials and quoted token values', () => {
  const cases = [
    ['Authorization: Bearer abc123', 'abc123'],
    ['authorization=Bearer abc123', 'abc123'],
    ['{"token":"abc"}', '"abc"'],
    ['password=hunter2', 'hunter2'],
    ['x-api-key: k-1', 'k-1'],
    ['Cookie: sid=deadbeef', 'deadbeef']
  ]
  for (const [input, secret] of cases) {
    const redacted = redactDiagnostic(input)
    assert.ok(!redacted.includes(secret), `${input} -> ${redacted}`)
    assert.ok(redacted.includes('<redacted>'), `${input} -> ${redacted}`)
  }
})

test('diagnostics keep the auth scheme and unrelated text', () => {
  assert.equal(redactDiagnostic('Authorization: Bearer abc123'), 'Authorization: Bearer <redacted>')
  assert.equal(redactDiagnostic('transport 调用失败：transport timeout after 20s'), 'transport 调用失败：transport timeout after 20s')
  // No separator means no value, so an ordinary sentence keeps its wording.
  assert.equal(redactDiagnostic('the token was rejected'), 'the token was rejected')
  assert.equal(redactDiagnostic('x'.repeat(600)).length, 512)
})
