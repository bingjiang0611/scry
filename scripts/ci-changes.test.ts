import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

// js-yaml is already installed by the build toolchain; no second YAML parser/config format.
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
interface Step {
  name?: string
  id?: string
  if?: string
  'continue-on-error'?: boolean
  uses?: string
  run?: string
  with?: { script?: string; [key: string]: unknown }
}
interface Job {
  'runs-on'?: string
  'timeout-minutes'?: number
  'continue-on-error'?: boolean
  env?: Record<string, string>
  name?: string
  if?: string
  needs?: string[] | string
  permissions?: Record<string, string>
  steps: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, Job>
}
const root = resolve(import.meta.dirname, '..')
const workflow = (file: string) => load(readFileSync(join(root, '.github/workflows', file), 'utf8')) as Workflow
const source = (job: Job, name: string) => {
  const step = job.steps.find(step => step.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
function temp() {
  const path = mkdtempSync(join(tmpdir(), 'scry-pr-workflow-'))
  temporary.push(path)
  return path
}
function shell(script: string, env: NodeJS.ProcessEnv, cwd = root) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8'
  })
}
// Exercise Git's pathspecs, including renames/deletions; do not mock a matcher.
describe('documentation-only validation skips', () => {
  it('skips only non-executable documentation and fails closed on unreadable diffs', () => {
    const cwd = temp()
    const env = { HOME: temp(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (...args: string[]) => execFileSync('git', args, { cwd, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' }).trim()
    git('init', '-b', 'main', '--template=')
    git('config', 'user.name', 'Scry test')
    git('config', 'user.email', 'scry@example.invalid')
    git('config', 'core.hooksPath', '/dev/null')
    writeFileSync(join(cwd, 'README.md'), 'base\n')
    git('add', '.'); git('commit', '-m', 'base')
    const output = join(temp(), 'output')
    const script = source(workflow('validation-changes.yml').jobs.changes, 'Detect executable changes').run!
    const detect = (base: string, event = 'pull_request') => {
      writeFileSync(output, '')
      const result = shell(script, { ...env, BASE_SHA: base, EVENT_NAME: event, GITHUB_OUTPUT: output }, cwd)
      return { status: result.status, output: readFileSync(output, 'utf8') }
    }
    const commit = (path: string) => {
      mkdirSync(join(cwd, path, '..'), { recursive: true })
      writeFileSync(join(cwd, path), 'changed\n')
      git('add', '.'); git('commit', '-m', path)
    }
    for (const path of ['README.md', 'docs/guide.md', 'docs/nested/guide.md']) {
      const base = git('rev-parse', 'HEAD')
      commit(path)
      expect(detect(base)).toEqual({ status: 0, output: 'required=false\n' })
      expect(detect(base, 'push')).toEqual({ status: 0, output: 'required=false\n' })
    }
    for (const path of ['src/main.ts', 'package.json', 'docs/build.mjs', 'docs/fixture.json', '.github/workflows/ci.yml', '.agents/skills/test/SKILL.md', 'CLAUDE.md']) {
      const base = git('rev-parse', 'HEAD')
      commit(path)
      expect(detect(base)).toEqual({ status: 0, output: 'required=true\n' })
    }
    let base = git('rev-parse', 'HEAD')
    git('mv', 'src/main.ts', 'docs/renamed.md'); git('commit', '-m', 'rename code to docs')
    expect(detect(base)).toEqual({ status: 0, output: 'required=true\n' })
    base = git('rev-parse', 'HEAD')
    git('rm', 'docs/guide.md'); git('commit', '-m', 'delete docs')
    expect(detect(base)).toEqual({ status: 0, output: 'required=false\n' })
    expect(detect(base, 'workflow_dispatch')).toEqual({ status: 0, output: 'required=true\n' })
    expect(detect('0'.repeat(40))).toEqual({ status: 0, output: 'required=true\n' })
    expect(detect('f'.repeat(40)).status).not.toBe(0)
    expect(detect('f'.repeat(40)).output).toBe('')
  })
})
