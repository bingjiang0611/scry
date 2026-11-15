import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { beginGitTurnDiff, cleanupCapture } from './git-capture.js'
import { computeGitTurnDiff } from './git-compute.js'
import { UNTRACKED_PATCH_FILE_LIMIT } from './git-turn-diff-policy.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
      }
    }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : resolve(stdout))
  })
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-untracked-policy-'))
  roots.push(root)
  const path = join(root, 'repo')
  await mkdir(path)
  await git(path, ['init', '-q', '-b', 'main'])
  await writeFile(join(path, 'tracked.txt'), 'v1\n')
  await git(path, ['add', 'tracked.txt'])
  await git(path, ['commit', '-q', '-m', 'base'])
  return path
}

describe('未跟踪文件清单策略接进真实 Git 采集', () => {
  it(`keeps every patch at the ${UNTRACKED_PATCH_FILE_LIMIT}-file limit and switches to the manifest above it`, async () => {
    const capturePath = await repo()
    const captureRoot = await mkdtemp(join(tmpdir(), 'scry-untracked-captures-'))
    roots.push(captureRoot)

    const atLimit = await beginGitTurnDiff(capturePath, 20_000, captureRoot, [])
    expect(atLimit.status).toBe('ready')
    try {
      await writeFile(join(capturePath, 'tracked.txt'), 'v2\n')
      for (let index = 0; index < UNTRACKED_PATCH_FILE_LIMIT; index++) {
        await writeFile(join(capturePath, `generated-${index}.txt`), `body ${index}\n`)
      }
      const snapshot = await computeGitTurnDiff(atLimit, 20_000, { completePatches: true }, false)
      expect(snapshot.status).toBe('captured')
      expect(snapshot.files).toHaveLength(UNTRACKED_PATCH_FILE_LIMIT + 1)
      // Everything is inside the limit, so each file keeps its own body.
      expect(snapshot.files.filter((file) => file.patchStatus === 'unavailable')).toEqual([])
    } finally {
      await cleanupCapture(atLimit)
    }

    const overLimit = await beginGitTurnDiff(capturePath, 20_000, captureRoot, [])
    expect(overLimit.status).toBe('ready')
    try {
      for (let index = 0; index < UNTRACKED_PATCH_FILE_LIMIT + 1; index++) {
        await writeFile(join(capturePath, `friday-88733196-extra-${index}.txt`), `extra ${index}\n`)
      }
      await writeFile(join(capturePath, 'tracked.txt'), 'v3\n')
      const snapshot = await computeGitTurnDiff(overLimit, 20_000, { completePatches: true }, false)
      expect(snapshot.status).toBe('captured')
      const omitted = snapshot.files.filter((file) => file.patchStatus === 'unavailable')
      // Manifest stays complete: 本轮新增的每一条未跟踪文件都还在，只是不带正文。
      // The 50 files created by the previous capture are part of this capture's baseline.
      expect(snapshot.files).toHaveLength(UNTRACKED_PATCH_FILE_LIMIT + 2)
      expect(omitted).toHaveLength(UNTRACKED_PATCH_FILE_LIMIT + 1)
      expect(omitted.every((file) => file.patchReason === 'policy' && !file.patchContent)).toBe(true)
      expect(omitted.every((file) => file.path.includes('friday-88733196-extra'))).toBe(true)
      // The tracked edit keeps its patch: policy only removes the new untracked bodies.
      const tracked = snapshot.files.find((file) => file.path.endsWith('/tracked.txt'))
      expect(tracked?.patchStatus).toBe('captured')
      expect(tracked?.patch).toContain('v3')
    } finally {
      await cleanupCapture(overLimit)
    }
  }, 60_000)

  it('leaves declared capture.diffExclude paths out of the diff', async () => {
    const path = await repo()
    const captureRoot = await mkdtemp(join(tmpdir(), 'scry-diff-exclude-'))
    roots.push(captureRoot)
    const capture = await beginGitTurnDiff(path, 20_000, captureRoot, [])
    expect(capture.status).toBe('ready')
    try {
      await mkdir(join(path, 'friday-workdir'))
      await writeFile(join(path, 'friday-workdir', 'artifact.json'), '{}\n')
      await writeFile(join(path, 'tracked.txt'), 'v2\n')
      const snapshot = await computeGitTurnDiff(
        capture, 20_000, { completePatches: true, diffExclude: ['friday-workdir'] }, false
      )
      expect(snapshot.files).toHaveLength(1)
      expect(snapshot.files[0].path).toContain('/repo/tracked.txt')
      expect(snapshot.files[0].patch).toContain('v2')
    } finally {
      await cleanupCapture(capture)
    }
  }, 60_000)
})
