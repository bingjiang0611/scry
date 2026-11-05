import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, it } from 'vitest'
import { parseNameStatus, parseNumstat, parseRawNumstat } from './git-patches.js'

// `git diff --raw --numstat -z` is one process with two output sections. The combined parser must
// return exactly what the previous `--name-status` + `--numstat` pair returned, including for
// hostile path names, binaries, mode and type changes and gitlinks.

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TEMPLATE_DIR: ''
}
const roots: string[] = []
afterAll(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const git = async (args: string[], cwd: string) => (await exec('git', args, { cwd, env })).stdout

it('parses the raw section of the combined -z output', () => {
  const repoRoot = '/repo'
  const stdout = [
    ':100644 100644 1111111 2222222 M',
    'mod.txt',
    ':000000 100644 0000000 3333333 A',
    'sp ace\nnewline.txt',
    ':100644 000000 4444444 0000000 D',
    'gone.txt',
    ':100644 120000 5555555 6666666 T',
    'flip',
    ':160000 160000 7777777 8888888 M',
    'vendor/sub',
    ':100644 100644 9999999 aaaaaaa M',
    'bin.dat',
    '1\t0\tmod.txt',
    '1\t0\tsp ace\nnewline.txt',
    '0\t1\tgone.txt',
    '0\t0\tflip',
    '1\t0\tvendor/sub',
    '-\t-\tbin.dat',
    ''
  ].join('\0')

  const files = parseRawNumstat(stdout, repoRoot)
  expect(files).toEqual([
    { path: join(repoRoot, 'mod.txt'), added: 1, deleted: 0, change: 'modified' },
    { path: join(repoRoot, 'sp ace\nnewline.txt'), added: 1, deleted: 0, change: 'added' },
    { path: join(repoRoot, 'gone.txt'), added: 0, deleted: 1, change: 'deleted' },
    // A type change keeps the previous mapping: no `change` field.
    { path: join(repoRoot, 'flip'), added: 0, deleted: 0 },
    { path: join(repoRoot, 'vendor/sub'), added: 1, deleted: 0, change: 'modified' },
    { path: join(repoRoot, 'bin.dat'), added: 0, deleted: 0, binary: true, change: 'modified' }
  ])
})

it('combined parse matches the separate name-status and numstat calls on a real repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-raw-numstat-'))
  roots.push(root)
  await git(['init', '-q', '--initial-branch=main'], root)
  const commit = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@scry.local', 'commit', '-qm', 'fixture']
  await writeFile(join(root, 'mod.txt'), 'a\n')
  await writeFile(join(root, 'gone.txt'), 'b\n')
  await writeFile(join(root, 'tool.sh'), '#!/bin/sh\n')
  await writeFile(join(root, 'bin.dat'), 'text\n')
  await writeFile(join(root, 'flip'), 'plain\n')
  await writeFile(join(root, 'with space and "quotes".txt'), 'c\n')
  await writeFile(join(root, '中文.txt'), 'd\n')
  await mkdir(join(root, 'dir'), { recursive: true })
  await writeFile(join(root, 'dir', 'nested.txt'), 'e\n')
  await git(['add', '-A'], root)
  await git(commit, root)
  const base = (await git(['rev-parse', 'HEAD'], root)).trim()

  await writeFile(join(root, 'mod.txt'), 'a\nb\n')
  await rm(join(root, 'gone.txt'))
  await writeFile(join(root, 'added.txt'), 'f\n')
  await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(root, 'with space and "quotes".txt'), 'c2\n')
  await writeFile(join(root, '中文.txt'), 'd2\n')
  await writeFile(join(root, 'dir', 'nested.txt'), 'e2\n')
  await rm(join(root, 'flip'))
  await symlink('mod.txt', join(root, 'flip'))
  await git(['add', '-A'], root)
  await git(commit, root)
  const head = (await git(['rev-parse', 'HEAD'], root)).trim()

  const common = ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '-z']
  const scope = [base, head, '--', '.']
  const combined = await git([...common, '--raw', '--numstat', ...scope], root)
  const numstat = await git([...common, '--numstat', ...scope], root)
  const nameStatus = await git([...common, '--name-status', ...scope], root)

  const changes = parseNameStatus(nameStatus, root)
  const expected = parseNumstat(numstat, root).map((file) => {
    const change = changes.get(file.path)
    return { ...file, ...(change ? { change } : {}) }
  })
  const actual = parseRawNumstat(combined, root)
  expect(actual).toEqual(expected)
  expect(actual.length).toBe(8)
  expect(actual.filter((file) => file.change === 'added').length).toBe(1)
  expect(actual.filter((file) => file.change === 'deleted').length).toBe(1)
  expect(actual.filter((file) => file.binary === true).length).toBe(1)
  // File -> symlink is a type change, so it carries no `change` field in either parser.
  expect(actual.find((file) => file.path === join(root, 'flip'))?.change).toBeUndefined()
}, 60_000)
