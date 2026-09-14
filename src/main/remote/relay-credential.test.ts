import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureRelayCredential } from './relay-credential'

describe('ensureRelayCredential', () => {
  it('creates one private stable credential scoped to the host identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-relay-credential-'))
    try {
      const hostId = randomUUID()
      const first = ensureRelayCredential(dir, hostId)
      const second = ensureRelayCredential(dir, hostId)
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(second).toBe(first)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, 'credential.json')).mode & 0o777).toBe(0o600)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails closed when the credential belongs to another host or is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-relay-credential-'))
    try {
      const hostId = randomUUID()
      ensureRelayCredential(dir, hostId)
      expect(() => ensureRelayCredential(dir, randomUUID())).toThrow('relay_credential_corrupt')
      writeFileSync(join(dir, 'credential.json'), JSON.stringify({ version: 1, hostId, token: 'short' }))
      expect(() => ensureRelayCredential(dir, hostId)).toThrow('relay_credential_corrupt')
      expect(readFileSync(join(dir, 'credential.json'), 'utf8')).toContain('short')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
