import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readDiffCommits, readDiffCommitSnapshot } from '../core/turn-recorder/git-diff-history'

const exec = promisify(execFile)
const roots: string[] = []
const git = async (cwd: string, ...args: string[]) => (await exec('git', [
  '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Scry Test', '-c', 'user.email=test@scry.local', ...args
], { cwd })).stdout.trim()
beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  vi.stubEnv('GIT_TEMPLATE_DIR', '')
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) vi.stubEnv(key, undefined)
})
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
afterAll(() => vi.unstubAllEnvs())
async function commit(root: string, subject: string) {
  await git(root, 'add', '.')
  await git(root, '-c', 'commit.gpgSign=false', 'commit', '-qm', subject)
  return git(root, 'rev-parse', 'HEAD')
}
async function importHistory(cwd: string, entries: string): Promise<void> {
  const operation = exec('git', ['-c', 'core.hooksPath=/dev/null', 'fast-import', '--quiet'], { cwd })
  operation.child.stdin!.end(entries + 'done\n')
  await operation
}
async function emptyHistory(cwd: string, parent: string, count: number): Promise<string> {
  // Build the same linear Git history in one native process; per-commit process startup
  // made fixture setup exceed the test deadline under the full two-worker suite.
  const entries = Array.from({ length: count }, (_, index) => {
    const subject = `empty ${index}`
    return `commit refs/heads/pagination\nmark :${index + 1}\ncommitter Scry Test <test@scry.local> 1760000000 +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\nfrom ${index ? `:${index}` : parent}\n\n`
  })
  await importHistory(cwd, entries.join(''))
  return git(cwd, 'rev-parse', 'refs/heads/pagination')
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-diff-history-')))
  roots.push(root)
  await git(root, 'init', '-qb', 'main')
  // Preserve all three commits and both checked-out files without fourteen process startups.
  const entries = [
    { branch: 'main', subject: 'base', path: 'file.ts', body: 'base\n' },
    { branch: 'feature', subject: 'first commit', path: 'file.ts', body: 'first immutable version\n' },
    { branch: 'feature', subject: 'second commit', path: 'second.ts', body: 'second immutable version\n' }
  ].map((entry, index) => `commit refs/heads/${entry.branch}\nmark :${index + 1}\ncommitter Scry Test <test@scry.local> 1760000000 +0000\ndata ${Buffer.byteLength(entry.subject)}\n${entry.subject}\n${index ? `from :${index}\n` : ''}M 100644 inline ${entry.path}\ndata ${Buffer.byteLength(entry.body)}\n${entry.body}\n`)
  await importHistory(root, entries.join(''))
  await git(root, 'checkout', '-q', 'feature')
  const [baseCommit, first, head] = (await git(root, 'rev-parse', 'main', 'feature~1', 'feature')).split('\n')
  return { cwd: root, baseCommit, first, head }
}

describe('local diff commit history', () => {
  it('returns anchored commits and their original bodies despite later working-file and HEAD changes', async () => {
    const request = await fixture()
    const list = await readDiffCommits({ ...request, offset: 0 })
    expect(list).toMatchObject({ status: 'available', nextOffset: null, truncated: false })
    if (list.status !== 'available') throw new Error('No history')
    expect(list.commits.map(item => item.hash)).toEqual([request.head, request.first])
    expect(list.commits[1]).toMatchObject({ subject: 'first commit', parents: [request.baseCommit], author: 'Scry Test' })
    await writeFile(join(request.cwd, 'file.ts'), 'TODAYS UNRELATED CONTENT\n')
    await commit(request.cwd, 'later HEAD')
    await writeFile(join(request.cwd, 'file.ts'), 'dirty again\n')
    const index = await readFile(join(request.cwd, '.git/index'))
    const objects = await readdir(join(request.cwd, '.git/objects'), { recursive: true })
    const result = await readDiffCommitSnapshot({ ...request, commit: request.first })
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') throw new Error('No snapshot')
    expect(result.commit.hash).toBe(request.first)
    expect(result.snapshot.files.map(file => basename(file.path))).toEqual(['file.ts'])
    expect(result.snapshot.files[0].patch).toContain('+first immutable version')
    expect(result.snapshot.files[0].patch).not.toContain('TODAYS')
    expect(result.snapshot.cleanup).toBe('ok')
    expect(await readFile(join(request.cwd, '.git/index'))).toEqual(index)
    expect(await readdir(join(request.cwd, '.git/objects'), { recursive: true })).toEqual(objects)
    expect(await readDiffCommits({ ...request, offset: 0 })).toEqual(list)
  })

  it('includes empty commits, pages without overlap and stays anchored to the requested head', async () => {
    const request = await fixture()
    const head = await emptyHistory(request.cwd, request.head, 49)
    const first = await readDiffCommits({ ...request, head, offset: 0 })
    const second = await readDiffCommits({ ...request, head, offset: 50 })
    expect(first).toMatchObject({ status: 'available', nextOffset: 50, truncated: false })
    expect(second).toMatchObject({ status: 'available', nextOffset: null, truncated: false })
    if (first.status !== 'available' || second.status !== 'available') throw new Error('No pages')
    expect(first.commits).toHaveLength(50)
    expect(second.commits).toHaveLength(1)
    expect(new Set([...first.commits, ...second.commits].map(item => item.hash)).size).toBe(51)
    const empty = await readDiffCommitSnapshot({ ...request, head, commit: head })
    expect(empty).toMatchObject({ status: 'captured', snapshot: { files: [] } })
  })

  it('reports the 1000-commit cap as truncated rather than a complete history', async () => {
    const request = await fixture()
    const head = await emptyHistory(request.cwd, request.head, 999)
    const page = await readDiffCommits({ ...request, head, offset: 950 })
    expect(page).toMatchObject({ status: 'available', nextOffset: null, truncated: true })
    if (page.status !== 'available') throw new Error('No capped page')
    expect(page.commits).toHaveLength(50)
  })

  it('captures expandable context from the immutable commit, not the changed working file', async () => {
    const request = await fixture()
    const lines = Array.from({ length: 60 }, (_, index) => `context-${String(index).padStart(2, '0')}\n`)
    await writeFile(join(request.cwd, 'file.ts'), lines.join(''))
    const baseCommit = await commit(request.cwd, 'context baseline')
    lines[20] = 'committed change\n'
    await writeFile(join(request.cwd, 'file.ts'), lines.join(''))
    const head = await commit(request.cwd, 'context change')
    lines[8] = 'dirty replacement must not enter immutable context\n'
    await writeFile(join(request.cwd, 'file.ts'), lines.join(''))
    const result = await readDiffCommitSnapshot({ ...request, baseCommit, head, commit: head })
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') throw new Error('No context snapshot')
    expect(result.snapshot.files[0].patch).toContain(' context-08')
    expect(result.snapshot.files[0].patch).not.toContain('dirty replacement')
  })

  it('rejects invalid ranges and commits outside the captured range, not successful empty patches', async () => {
    const request = await fixture()
    expect(await readDiffCommits({ ...request, baseCommit: request.head, head: request.baseCommit, offset: 0 })).toMatchObject({ status: 'unavailable', reason: 'invalid_range' })
    expect(await readDiffCommitSnapshot({ ...request, commit: request.baseCommit })).toMatchObject({ status: 'failed' })
    await writeFile(join(request.cwd, 'later'), 'later')
    const later = await commit(request.cwd, 'outside captured range')
    expect(await readDiffCommitSnapshot({ ...request, commit: later })).toMatchObject({ status: 'failed' })
  })

  it('contains a subdirectory selection and never invokes configured diff/textconv/signature executables', async () => {
    const request = await fixture()
    const folder = join(request.cwd, 'nested [scope]')
    await mkdir(folder)
    await writeFile(join(folder, 'inside.ts'), 'inside\n')
    await writeFile(join(request.cwd, 'outside.ts'), 'outside\n')
    await writeFile(join(request.cwd, '.gitattributes'), '*.ts diff=evil\n')
    const head = await commit(request.cwd, 'nested changes')
    const marker = join(request.cwd, 'executed')
    await git(request.cwd, 'config', 'diff.evil.command', `touch '${marker}'`)
    await git(request.cwd, 'config', 'diff.evil.textconv', `touch '${marker}'`)
    await git(request.cwd, 'config', 'log.showSignature', 'true')
    await git(request.cwd, 'config', 'gpg.program', marker)
    const result = await readDiffCommitSnapshot({ ...request, cwd: folder, head, commit: head })
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') throw new Error('No snapshot')
    expect(result.snapshot.files.map(file => basename(file.path))).toEqual(['inside.ts'])
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('handles a root commit reachable through an unrelated-history merge without writing real Git objects', async () => {
    const request = await fixture()
    await git(request.cwd, 'checkout', '--orphan', 'other')
    await git(request.cwd, 'rm', '-rf', '.')
    await writeFile(join(request.cwd, 'other.txt'), 'other root\n')
    const other = await commit(request.cwd, 'unrelated root')
    await git(request.cwd, 'checkout', '-q', 'feature')
    await git(request.cwd, '-c', 'commit.gpgSign=false', 'merge', '--allow-unrelated-histories', '--no-edit', 'other')
    const head = await git(request.cwd, 'rev-parse', 'HEAD')
    const objects = await readdir(join(request.cwd, '.git/objects'), { recursive: true })
    const result = await readDiffCommitSnapshot({ ...request, head, commit: other })
    expect(result).toMatchObject({ status: 'captured', commit: { parents: [] } })
    if (result.status !== 'captured') throw new Error('No root snapshot')
    expect(result.snapshot.files.map(file => basename(file.path))).toEqual(['other.txt'])
    expect(result.snapshot.files[0].patch).toContain('+other root')
    expect(await readdir(join(request.cwd, '.git/objects'), { recursive: true })).toEqual(objects)
    const merge = await readDiffCommitSnapshot({ ...request, head, commit: head })
    expect(merge).toMatchObject({ status: 'captured', commit: { parents: [request.head, other] } })
  })
})
