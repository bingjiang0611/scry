import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  SessionPermissionRuleStore,
  permissionAllowEntries
} from './session-permission-rules'

function withStore(run: (store: SessionPermissionRuleStore, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-a2-'))
  try {
    run(SessionPermissionRuleStore.inUserData(dir), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('persists accepted session rules so a restarted Provider run still has them', () => {
  withStore((store, dir) => {
    store.record('session-1', [{ toolName: 'Bash', ruleContent: 'npm test' }])
    // A fresh store instance stands in for the next Provider process.
    const reopened = SessionPermissionRuleStore.inUserData(dir)
    expect(reopened.rules('session-1')).toEqual([{ toolName: 'Bash', ruleContent: 'npm test' }])
    expect(permissionAllowEntries(reopened.rules('session-1'))).toEqual(['Bash(npm test)'])
    expect(statSync(join(dir, 'session-permission-rules.json')).mode & 0o777).toBe(0o600)
  })
})

it('deduplicates rules, ignores wildcards and keeps sessions independent', () => {
  withStore((store) => {
    store.record('session-1', [
      { toolName: 'Bash', ruleContent: 'npm test' },
      { toolName: 'Bash', ruleContent: 'npm test' },
      { toolName: 'Bash', ruleContent: '*' },
      { toolName: '*', ruleContent: 'npm test' },
      { toolName: '', ruleContent: 'npm test' }
    ])
    store.record('session-2', [{ toolName: 'Edit', ruleContent: '/tmp/notes.md' }])
    expect(store.rules('session-1')).toEqual([{ toolName: 'Bash', ruleContent: 'npm test' }])
    expect(store.rules('session-2')).toEqual([{ toolName: 'Edit', ruleContent: '/tmp/notes.md' }])
    store.clear('session-1')
    expect(store.rules('session-1')).toEqual([])
    expect(store.rules('session-2')).toHaveLength(1)
  })
})

it('starts from an empty set when the file is corrupt instead of throwing', () => {
  withStore((store, dir) => {
    store.record('session-1', [{ toolName: 'Bash', ruleContent: 'npm test' }])
    const path = join(dir, 'session-permission-rules.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      'session-1': [{ toolName: 'Bash', ruleContent: 'npm test' }]
    })
    rmSync(path)
    const missing = SessionPermissionRuleStore.inUserData(dir)
    expect(missing.rules('session-1')).toEqual([])
  })
})
