import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyOutcome, evaluateGuard, snapshotTree } from './real-home-guard'

// These cases never touch the user's real ~/.scry: the guard is exercised on a fixture directory
// that plays the part of the watched tree, with workspaces that are real project paths on one
// side and this run's temporary roots on the other.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { guardDir: string, temporaryRoot: string, projectWorkspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'scry-guard-test-'))
  roots.push(root)
  const guardDir = join(root, 'watched')
  const temporaryRoot = join(root, 'run')
  // Deliberately outside the system temporary directory: this is a user's own checkout.
  const projectWorkspace = '/Users/example/Projects/real-repo'
  for (const dir of [join(guardDir, 'grants'), temporaryRoot]) mkdirSync(dir, { recursive: true })
  return { guardDir, temporaryRoot, projectWorkspace }
}

function writeGrant(guardDir: string, name: string, workspace: string): void {
  writeFileSync(join(guardDir, 'grants', name), JSON.stringify({ schemaVersion: 1, workspace, entry: 'commit-hook.sh' }))
}

describe('real ~/.scry guard', () => {
  it('真实会话在测试期间写入真实目录的授权只告警，不让任何测试文件失败', () => {
    const f = fixture()
    const before = snapshotTree(f.guardDir)
    writeGrant(f.guardDir, 'real-session.json', f.projectWorkspace)

    const outcome = evaluateGuard({
      guardDir: f.guardDir, before, after: snapshotTree(f.guardDir),
      temporaryRoots: [f.temporaryRoot, tmpdir()], strict: false
    })
    expect(outcome.failures).toEqual([])
    expect(outcome.warnings).toEqual([{ status: 'added', path: 'grants/real-session.json' }])

    const warn = vi.fn()
    expect(() => applyOutcome(outcome, { guardDir: f.guardDir, testPath: 'src/unrelated.test.ts', warn })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('grants/real-session.json'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(f.projectWorkspace))
  })

  it('测试自己往真实目录写一个工作区在临时目录下的授权仍然失败', () => {
    const f = fixture()
    const before = snapshotTree(f.guardDir)
    writeGrant(f.guardDir, 'leak.json', join(f.temporaryRoot, 'home-1', 'workspace'))

    const outcome = evaluateGuard({
      guardDir: f.guardDir, before, after: snapshotTree(f.guardDir),
      temporaryRoots: [f.temporaryRoot, tmpdir()], strict: false
    })
    expect(outcome.failures).toEqual([{ status: 'added', path: 'grants/leak.json' }])
    expect(outcome.warnings).toEqual([])

    const warn = vi.fn()
    expect(() => applyOutcome(outcome, { guardDir: f.guardDir, testPath: 'src/leaky.test.ts', warn }))
      .toThrow(/src\/leaky\.test\.ts changed the real/)
    expect(warn).not.toHaveBeenCalled()
  })

  it('CI 里任何变动都失败，包括只读得出真实工作区的那种', () => {
    const f = fixture()
    const before = snapshotTree(f.guardDir)
    writeGrant(f.guardDir, 'real-session.json', f.projectWorkspace)

    const outcome = evaluateGuard({
      guardDir: f.guardDir, before, after: snapshotTree(f.guardDir),
      temporaryRoots: [f.temporaryRoot, tmpdir()], strict: true
    })
    expect(outcome.failures).toEqual([{ status: 'added', path: 'grants/real-session.json' }])
    expect(outcome.warnings).toEqual([])
  })

  it('删除的条目读不出工作区，本地只告警', () => {
    const f = fixture()
    writeGrant(f.guardDir, 'gone.json', join(f.temporaryRoot, 'workspace'))
    const before = snapshotTree(f.guardDir)
    rmSync(join(f.guardDir, 'grants', 'gone.json'))

    const outcome = evaluateGuard({
      guardDir: f.guardDir, before, after: snapshotTree(f.guardDir),
      temporaryRoots: [f.temporaryRoot, tmpdir()], strict: false
    })
    expect(outcome.warnings).toEqual([{ status: 'removed', path: 'grants/gone.json' }])
    expect(outcome.failures).toEqual([])
  })

  it('解析不出工作区的文件只告警，不猜成测试泄漏', () => {
    const f = fixture()
    const before = snapshotTree(f.guardDir)
    writeFileSync(join(f.guardDir, 'cli-update.json'), '{"checkedAt":"2026-11-24T00:00:00.000Z"}\n')
    writeFileSync(join(f.guardDir, 'grants', 'truncated.json'), '{not json')

    const outcome = evaluateGuard({
      guardDir: f.guardDir, before, after: snapshotTree(f.guardDir),
      temporaryRoots: [f.temporaryRoot, tmpdir()], strict: false
    })
    expect(outcome.warnings.map((change) => change.path).sort()).toEqual(['cli-update.json', 'grants/truncated.json'])
    expect(outcome.failures).toEqual([])
  })
})
