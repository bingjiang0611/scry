import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  codexHookFingerprint,
  createCodexHookGrantStore,
  hooksRequiringBypass,
  type CodexHookMetadata
} from './codex-hook-trust'

const hook = (overrides: Partial<CodexHookMetadata> = {}): CodexHookMetadata => ({
  key: '/repo/.codex/hooks.json:pre_tool_use:0:0',
  eventName: 'preToolUse',
  source: 'project',
  sourcePath: '/repo/.codex/hooks.json',
  enabled: true,
  currentHash: 'sha256:one',
  trustStatus: 'untrusted',
  ...overrides
})

describe('Codex Hook grant store', () => {
  it('只把启用的 untrusted/modified Hook 视为需要绕过', () => {
    expect(
      hooksRequiringBypass([
        hook(),
        hook({ key: 'modified', trustStatus: 'modified' }),
        hook({ key: 'trusted', trustStatus: 'trusted' }),
        hook({ key: 'disabled', enabled: false })
      ]).map((item) => item.key)
    ).toEqual(['/repo/.codex/hooks.json:pre_tool_use:0:0', 'modified'])
  })

  it('Hook 顺序不影响授权，任一 key/hash 变化都会要求重新确认', () => {
    const first = hook()
    const second = hook({ key: 'second', currentHash: 'sha256:two' })
    expect(codexHookFingerprint([first, second])).toBe(codexHookFingerprint([second, first]))
    expect(codexHookFingerprint([first, second])).not.toBe(
      codexHookFingerprint([first, { ...second, currentHash: 'sha256:changed' }])
    )
  })

  it('按 canonical cwd 永久保存当前 Hook 指纹，并在指纹变化后失效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-codex-hook-grant-'))
    try {
      const store = createCodexHookGrantStore(dir)
      store.grant(dir, 'fingerprint-a', 2)

      expect(store.isGranted(dir, 'fingerprint-a')).toBe(true)
      expect(store.isGranted(dir, 'fingerprint-b')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
