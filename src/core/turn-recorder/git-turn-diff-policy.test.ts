import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
  const path = join(await realpath(root), 'repo')
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
      expect(snapshot.files).toHaveLength(UNTRACKED_PATCH_FILE_LIMIT + 2)
      expect(omitted).toHaveLength(UNTRACKED_PATCH_FILE_LIMIT + 1)
      expect(omitted.every((file) => file.patchReason === 'policy' && !file.patchContent)).toBe(true)
      expect(omitted.every((file) => file.path.includes('friday-88733196-extra'))).toBe(true)
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

  it('a session claim excludes its absolute run directory and keeps the repository inside it', async () => {
    const outer = await repo()
    const captureRoot = await mkdtemp(join(tmpdir(), 'scry-session-exclude-'))
    roots.push(captureRoot)
    const run = join(outer, 'friday-88733196')
    const inner = join(run, 'stage3/backend/workspace/inner')
    await mkdir(inner, { recursive: true })
    await git(inner, ['init', '-q', '-b', 'main'])
    await writeFile(join(inner, 'code.py'), 'def f():\n    return 1\n')
    await git(inner, ['add', 'code.py'])
    await git(inner, ['commit', '-q', '-m', 'base'])
    const outerCapture = await beginGitTurnDiff(outer, 20_000, captureRoot, [])
    const innerCapture = await beginGitTurnDiff(inner, 20_000, captureRoot, [])
    expect(outerCapture.status).toBe('ready')
    expect(innerCapture.status).toBe('ready')
    try {
      for (let index = 0; index < 4; index++) {
        await writeFile(join(run, `mat-${index}.md`), `material ${index}\n`)
      }
      await writeFile(join(outer, 'tracked.txt'), 'v2\n')
      await writeFile(join(inner, 'code.py'), 'def f():\n    return 2\n')
      const outerSnapshot = await computeGitTurnDiff(
        outerCapture, 20_000, { completePatches: true, diffExclude: [run] }, false
      )
      expect(outerSnapshot.files.map((file) => file.path)).toEqual([join(outer, 'tracked.txt')])
      expect(outerSnapshot.diffExclude).toEqual({ paths: [run], files: 4 })
      const innerSnapshot = await computeGitTurnDiff(
        innerCapture, 20_000, { completePatches: true, diffExclude: [run] }, false
      )
      expect(innerSnapshot.files.map((file) => file.path)).toEqual([join(inner, 'code.py')])
      expect(innerSnapshot.diffExclude).toBeUndefined()
    } finally {
      await cleanupCapture(outerCapture)
      await cleanupCapture(innerCapture)
    }
  }, 60_000)

  it('a declared path that matches nothing costs nothing and is not reported as excluded', async () => {
    const path = await repo()
    const captureRoot = await mkdtemp(join(tmpdir(), 'scry-session-exclude-miss-'))
    roots.push(captureRoot)
    const capture = await beginGitTurnDiff(path, 20_000, captureRoot, [])
    expect(capture.status).toBe('ready')
    try {
      await writeFile(join(path, 'tracked.txt'), 'v2\n')
      const snapshot = await computeGitTurnDiff(
        capture, 20_000, { completePatches: true, diffExclude: [join(path, 'not-created-yet'), '/elsewhere/run'] }, false
      )
      expect(snapshot.files.map((file) => file.path)).toEqual([join(path, 'tracked.txt')])
      expect(snapshot.diffExclude).toBeUndefined()
    } finally {
      await cleanupCapture(capture)
    }
  }, 60_000)
})

it('excludes nested Scry data from both targeted and full git capture', async () => {
  const cwd = await repo()
  const privateFile = join(cwd, 'sub/.scry/record.json')
  const visibleFile = join(cwd, 'sub/ordinary.json')
  await mkdir(join(cwd, 'sub/.scry'), { recursive: true })
  await writeFile(privateFile, 'old private data\n')
  await writeFile(visibleFile, 'old visible data\n')
  await git(cwd, ['add', 'sub'])
  await git(cwd, ['commit', '-q', '-m', 'seed files'])

  const begin = () => beginGitTurnDiff(cwd, 20_000, undefined, [], false, undefined, { excludeScryData: true })
  const targeted = await begin()
  const full = await begin()
  try {
    expect(targeted.status).toBe('ready')
    expect(full.status).toBe('ready')
    await writeFile(privateFile, 'new private data\n')
    await writeFile(visibleFile, 'new visible data\n')
    const targetedDiff = await computeGitTurnDiff(targeted, 20_000, {
      structuredPaths: [visibleFile, privateFile], completePatches: true
    }, false)
    const fullDiff = await computeGitTurnDiff(full, 20_000, { forceFull: true, completePatches: true }, false)
    expect(targetedDiff.status).toBe('captured')
    expect(targetedDiff.collection).toMatchObject({ strategy: 'targeted', candidatePathCount: 1 })
    expect(fullDiff.status).toBe('captured')
    expect(fullDiff.files.map(file => file.path)).toEqual([visibleFile])
    expect(targetedDiff.files).toEqual(fullDiff.files)
    expect(JSON.stringify(targetedDiff.files)).toContain('+new visible data')
  } finally {
    await cleanupCapture(targeted)
    await cleanupCapture(full)
  }
}, 60_000)
