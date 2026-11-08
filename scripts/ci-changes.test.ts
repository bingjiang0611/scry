import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
const root = resolve(import.meta.dirname, '..')
const workflow = load(readFileSync(join(root, '.github/workflows/validation-changes.yml'), 'utf8')) as {
  jobs: { changes: { steps: { name?: string; run?: string }[] } }
}
const script = workflow.jobs.changes.steps.find(step => step.name === 'Detect executable changes')!.run!
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
function temp() {
  const path = mkdtempSync(join(tmpdir(), 'scry-ci-changes-'))
  temporary.push(path)
  return path
}
function fixture() {
  const cwd = temp()
  const output = join(temp(), 'output')
  const env = { PATH: process.env.PATH, HOME: temp(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  const write = (path: string, content = 'changed\n') => {
    mkdirSync(join(cwd, path, '..'), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  const commit = () => { git('add', '.'); git('commit', '-m', 'fixture') }
  git('init', '-b', 'main', '--template=')
  git('config', 'user.name', 'Scry test')
  git('config', 'user.email', 'scry@example.invalid')
  git('config', 'core.hooksPath', '/dev/null')
  write('README.md', 'base\n')
  write('docs/guide.md', 'base\n')
  write('src/main.ts', 'base\n')
  commit()
  const base = git('rev-parse', 'HEAD')
  const detect = (baseSha = base, event = 'pull_request') => {
    writeFileSync(output, '')
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd, env: { ...env, BASE_SHA: baseSha, EVENT_NAME: event, GITHUB_OUTPUT: output }, encoding: 'utf8'
    })
    return { status: result.status, output: readFileSync(output, 'utf8') }
  }
  return { git, write, commit, detect }
}

// Real Git pathspecs, including renames/deletions, not a second matcher.
// Separate cases keep subprocess-heavy fixtures under the ordinary test deadline.
describe('documentation-only validation skips', () => {
  it.each(['README.md', 'docs/guide.md', 'docs/nested/guide.md'])('skips only documentation: %s', path => {
    const { write, commit, detect } = fixture()
    write(path); commit()
    expect(detect()).toEqual({ status: 0, output: 'required=false\n' })
    expect(detect(undefined, 'push')).toEqual({ status: 0, output: 'required=false\n' })
  })

  it.each(['src/main.ts', 'package.json', 'docs/build.mjs', 'docs/fixture.json', '.github/workflows/ci.yml', '.agents/skills/test/SKILL.md', 'CLAUDE.md'])(
    'requires validation for executable/configuration inputs mixed with docs: %s', path => {
      const { write, commit, detect } = fixture()
      write('README.md'); write(path); commit()
      expect(detect()).toEqual({ status: 0, output: 'required=true\n' })
      expect(detect(undefined, 'push')).toEqual({ status: 0, output: 'required=true\n' })
    }
  )

  it('detects code renamed into documentation', () => {
    const { git, commit, detect } = fixture()
    git('mv', 'src/main.ts', 'docs/renamed.md'); commit()
    expect(detect()).toEqual({ status: 0, output: 'required=true\n' })
  })

  it('skips documentation deletions', () => {
    const { git, commit, detect } = fixture()
    git('rm', 'docs/guide.md'); commit()
    expect(detect()).toEqual({ status: 0, output: 'required=false\n' })
  })

  it('always validates dispatch/new branches and fails closed on an unreadable base', () => {
    const { detect } = fixture()
    expect(detect()).toEqual({ status: 0, output: 'required=false\n' })
    expect(detect(undefined, 'workflow_dispatch')).toEqual({ status: 0, output: 'required=true\n' })
    expect(detect('0'.repeat(40))).toEqual({ status: 0, output: 'required=true\n' })
    expect(detect('f'.repeat(40)).status).not.toBe(0)
    expect(detect('f'.repeat(40)).output).toBe('')
  })
})
