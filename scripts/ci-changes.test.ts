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

const SKIP = 'required=false\ndesktop=false\n'
const FULL = 'required=true\ndesktop=true\n'
const NO_DESKTOP = 'required=true\ndesktop=false\n'

// Real Git pathspecs, including renames/deletions, not a second matcher.
// Separate cases keep subprocess-heavy fixtures under the ordinary test deadline.
describe('documentation-only validation skips', () => {
  it.each([
    'README.md', 'docs/guide.md', 'docs/nested/guide.md', 'apps/ios/README.md',
    'packages/turn-recorder-cli/README.md', 'experiments/remote-g0/README.md',
    'experiments/remote-g0/cf-relay/README.md'
  ])('skips only documentation: %s', path => {
    const { write, commit, detect } = fixture()
    write(path); commit()
    expect(detect()).toEqual({ status: 0, output: SKIP })
  })

  it.each([
    'src/main.ts', 'package.json', 'docs/build.mjs', 'docs/fixture.json', '.github/workflows/ci.yml',
    '.github/actions/cache-electron/action.yml', 'THIRD_PARTY_NOTICES.md', 'scripts/model-picker-ui-smoke.mjs',
    '.agents/skills/test/scripts/timing-run.mjs', '.claude/skills/test/run.mjs', 'src/core/recorder-tests/fixture.ts',
    'experiments/remote-g0/generated/wire.ts', 'fixtures/billing/response.json'
  ])('requires every gate for App, packaging or harness inputs mixed with docs: %s', path => {
    const { write, commit, detect } = fixture()
    write('README.md'); write(path); commit()
    expect(detect()).toEqual({ status: 0, output: FULL })
  })

  it.each([
    'src/main.test.ts', 'src/renderer/view.test.tsx', 'scripts/ci-workflow.test.ts', 'CLAUDE.md', 'CONTRIBUTING.md',
    'DESIGN.md', 'PRODUCT.md', '.agents/skills/test/SKILL.md', '.claude/skills/test/SKILL.md',
    '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/VOUCHED.td',
    '.github/TRIAGE_EXEMPTIONS.td', 'apps/ios/ScryRemote/App.swift'
  ])('validates on Ubuntu but skips macOS App gates for inputs that cannot reach the App: %s', path => {
    const { write, commit, detect } = fixture()
    write('README.md'); write(path); commit()
    expect(detect()).toEqual({ status: 0, output: NO_DESKTOP })
  })

  it('keeps macOS App gates when an App input is mixed with desktop-free changes', () => {
    const { write, commit, detect } = fixture()
    write('src/main.test.ts'); write('CLAUDE.md'); write('src/main.ts'); commit()
    expect(detect()).toEqual({ status: 0, output: FULL })
  })

  it('detects code renamed into documentation or a test file', () => {
    const { git, commit, detect } = fixture()
    git('mv', 'src/main.ts', 'docs/renamed.md'); commit()
    expect(detect()).toEqual({ status: 0, output: FULL })
    const renamed = fixture()
    renamed.git('mv', 'src/main.ts', 'src/main.test.ts'); renamed.commit()
    expect(renamed.detect()).toEqual({ status: 0, output: FULL })
  })

  it('skips documentation deletions', () => {
    const { git, commit, detect } = fixture()
    git('rm', 'docs/guide.md'); commit()
    expect(detect()).toEqual({ status: 0, output: SKIP })
  })

  it('always validates dispatch, coalesced main pushes and new branches, and fails closed on an unreadable base', () => {
    const { detect } = fixture()
    expect(detect()).toEqual({ status: 0, output: SKIP })
    expect(detect(undefined, 'workflow_dispatch')).toEqual({ status: 0, output: FULL })
    expect(detect(undefined, 'push')).toEqual({ status: 0, output: FULL })
    expect(detect('0'.repeat(40))).toEqual({ status: 0, output: FULL })
    expect(detect('f'.repeat(40)).status).not.toBe(0)
    expect(detect('f'.repeat(40)).output).toBe('')
  })
})
