import { describe, expect, it } from 'vitest'
import { processIdentitiesComparable, processIdentityKey, readProcessIdentitySync } from './process-diagnostics'

function linuxFiles(starttime: string, bootId = '11111111-2222-3333-4444-555555555555') {
  const fields = Array.from({ length: 20 }, () => '0')
  fields[0] = 'S'
  fields[1] = '1'
  fields[19] = starttime
  const values: Record<string, string> = {
    '/proc/42/stat': `42 (Scry daemon) ${fields.join(' ')}`,
    '/proc/42/cmdline': '/opt/Scry\0out/main/daemon.js\0',
    '/proc/sys/kernel/random/boot_id': `${bootId}\n`
  }
  return (path: string): string => {
    if (!(path in values)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return values[path]
  }
}

describe('platform process identity', () => {
  it('uses Linux boot_id plus proc starttime, independent of wall-clock lstart', () => {
    const first = readProcessIdentitySync(42, { platform: 'linux', readFile: linuxFiles('123456') })!
    const same = readProcessIdentitySync(42, { platform: 'linux', readFile: linuxFiles('123456') })!
    expect(processIdentityKey(first)).toBe('42:linux:11111111-2222-3333-4444-555555555555:123456')
    expect(processIdentityKey(same)).toBe(processIdentityKey(first))
    expect(first.command).toBe('/opt/Scry out/main/daemon.js')
  })

  it('returns unavailable when a targeted ps lookup finds no process', () => {
    expect(readProcessIdentitySync(42, {
      platform: 'darwin',
      ps: () => { throw Object.assign(new Error('gone'), { status: 1 }) }
    })).toBeUndefined()
  })

  it('compares only identities written in a format it can interpret', () => {
    expect(processIdentitiesComparable('42:linux:boot:999', '42:linux:boot:999')).toBe(true)
    expect(processIdentitiesComparable('42:linux:boot:999', '42:Tue Feb  2 00:00:00 2026')).toBe(false)
    expect(processIdentitiesComparable('42:Tue Feb  2 00:00:00 2026', '42:Tue Feb  2 00:00:01 2026')).toBe(true)
    expect(processIdentitiesComparable('', '42:Tue Feb  2 00:00:00 2026')).toBe(false)
    expect(processIdentitiesComparable('42:legacy-identity', '42:Tue Feb  2 00:00:00 2026')).toBe(false)
  })

  it('changes identity when either Linux boot_id or proc starttime changes', () => {
    const original = readProcessIdentitySync(42, { platform: 'linux', readFile: linuxFiles('123456') })!
    const reused = readProcessIdentitySync(42, { platform: 'linux', readFile: linuxFiles('123457') })!
    const rebooted = readProcessIdentitySync(42, { platform: 'linux', readFile: linuxFiles('123456', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') })!
    expect(processIdentityKey(reused)).not.toBe(processIdentityKey(original))
    expect(processIdentityKey(rebooted)).not.toBe(processIdentityKey(original))
  })
})
