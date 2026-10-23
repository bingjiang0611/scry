import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const checker = resolve('scripts/check-staged-file-size.mjs')
const installer = resolve('scripts/install-git-hooks.mjs')
let directory: string
let cwd: string
let env: NodeJS.ProcessEnv

function run(command: string, args: string[]) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' })
}

function git(...args: string[]) {
  const result = run('git', args)
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

function file(path: string, content: string) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  writeFileSync(join(cwd, path), content)
}

function stage(path: string, content: string) {
  file(path, content)
  git('add', '--', path)
}

function check() {
  return run(process.execPath, [checker])
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'scry-file-budget-'))
  cwd = join(directory, 'repository with spaces')
  mkdirSync(cwd)
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig')
  writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  git('init', '--template=', '--initial-branch=main')
  git('config', 'user.name', 'Hook test')
  git('config', 'user.email', 'hook@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  file('.githooks/pre-commit', readFileSync(resolve('.githooks/pre-commit'), 'utf8'))
  chmodSync(join(cwd, '.githooks/pre-commit'), 0o755)
  mkdirSync(join(cwd, 'scripts'))
  copyFileSync(checker, join(cwd, 'scripts/check-staged-file-size.mjs'))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('staged file budget', () => {
  it('accepts an empty index and exactly 20,000 bytes, rejects one byte more', () => {
    expect(check().status).toBe(0)
    stage('boundary.ts', 'a'.repeat(20_000))
    expect(check().status).toBe(0)
    stage('boundary.ts', 'a'.repeat(20_001))
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('20001 bytes')
    expect(result.stderr).toContain('Split by responsibility')
    expect(result.stderr).toContain('Update imports and tests')
  })

  it('checks index contents in both partial-staging directions, not unstaged files', () => {
    stage('partial.ts', 'small')
    file('partial.ts', 'x'.repeat(20_001))
    file('untracked.ts', 'x'.repeat(20_001))
    expect(check().status).toBe(0)
    git('add', 'partial.ts')
    file('partial.ts', 'small')
    expect(check().status).toBe(1)
  })

  it('handles Unicode, spaces, newlines, leading dashes and byte rather than character counts', () => {
    const path = '-中文 space\nname.ts'
    stage(path, '中'.repeat(6_667))
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(JSON.stringify(path))
    expect(result.stderr).toContain('20001 bytes')
  })

  it('exempts explicit lockfiles, generated outputs and binary assets, not arbitrary generated folders', () => {
    for (const path of [
      'package-lock.json', 'nested/pnpm-lock.yaml', 'ios/Package.resolved',
      'experiments/remote-g0/generated/wire.mjs', 'experiments/remote-g0/generated/wire.ts',
      'experiments/remote-g0/swift/Sources/RemoteTransport/Wire.swift', 'assets/icon.png', 'assets/icon.icns'
    ]) stage(path, 'x'.repeat(20_001))
    expect(check().status).toBe(0)
    stage('generated/handwritten.ts', 'x'.repeat(20_001))
    expect(check().status).toBe(1)
  })

  it('checks modified legacy files but ignores unchanged and deleted large files', () => {
    stage('legacy.ts', 'x'.repeat(20_001))
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'legacy baseline')
    expect(check().status).toBe(0)
    stage('legacy.ts', 'x'.repeat(20_002))
    expect(check().status).toBe(1)
    git('rm', '-f', 'legacy.ts')
    expect(check().status).toBe(0)
  })

  it('checks renamed exempt files at their new path and ignores symlink targets', () => {
    stage('package-lock.json', 'x'.repeat(20_001))
    git('commit', '-m', 'lockfile')
    git('mv', 'package-lock.json', 'source.ts')
    expect(check().status).toBe(1)
    git('reset', '--hard', 'HEAD')
    symlinkSync('package-lock.json', join(cwd, 'link.ts'))
    git('add', 'link.ts')
    expect(check().status).toBe(0)
  })

  it('fails closed outside a Git repository', () => {
    cwd = directory
    expect(check().status).not.toBe(0)
  })
})

describe('hook installation and real commits', () => {
  it('installs idempotently and blocks a real commit until the staged file is split', () => {
    expect(run(process.execPath, [installer]).status).toBe(0)
    expect(run(process.execPath, [installer]).status).toBe(0)
    stage('large.ts', 'x'.repeat(20_001))
    const blocked = run('git', ['commit', '-m', 'must fail'])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('Commit blocked')
    expect(run('git', ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0)
    stage('large.ts', 'x'.repeat(10_000))
    stage('extracted.ts', 'x'.repeat(10_001))
    git('commit', '-m', 'split files')
    expect(git('log', '-1', '--format=%s')).toBe('split files')
  })

  it('preserves and executes existing global hooks without modifying global configuration', () => {
    const hooks = join(directory, 'global hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\nprintf preserved > hook-ran\n')
    chmodSync(join(hooks, 'post-commit'), 0o755)
    git('config', '--global', 'core.hooksPath', hooks)
    const originalConfig = readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')
    expect(run(process.execPath, [installer]).status).toBe(0)
    const installed = git('config', '--local', '--get', 'core.hooksPath')
    expect(realpathSync(join(installed, 'post-commit'))).toBe(realpathSync(join(hooks, 'post-commit')))
    stage('small.ts', 'small')
    git('commit', '-m', 'run preserved hook')
    expect(readFileSync(join(cwd, 'hook-ran'), 'utf8')).toBe('preserved')
    expect(readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')).toBe(originalConfig)
  })

  it('refuses to overwrite an existing pre-commit hook', () => {
    const previous = join(cwd, '.git/hooks/pre-commit')
    mkdirSync(dirname(previous), { recursive: true })
    writeFileSync(previous, '#!/bin/sh\nexit 0\n')
    const result = run(process.execPath, [installer])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Existing pre-commit hook')
    expect(readFileSync(previous, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect(existsSync(join(cwd, '.git/scry-hooks'))).toBe(false)
    expect(run('git', ['config', '--local', '--get', 'core.hooksPath']).status).toBe(1)
  })
})
