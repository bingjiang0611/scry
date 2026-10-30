import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

// js-yaml is already installed by the build toolchain; no second YAML parser/config format.
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
interface Step {
  name?: string
  id?: string
  uses?: string
  run?: string
  with?: { script?: string; [key: string]: unknown }
}
interface Job {
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
function gate(file: string, results: Record<string, unknown>) {
  const job = workflow(file).jobs.check
  expect(job.if).toBe('${{ always() }}')
  return shell(job.steps[0].run!, { RESULTS: JSON.stringify(results) }).status
}

// Execute the scripts used by GitHub rather than a second implementation of the gate.
describe('required PR checks', () => {
  for (const [file, dependencies] of [
    ['ci.yml', ['node', 'cli-compat', 'packaged-electron']],
    ['performance.yml', ['compare', 'native']]
  ] as const) {
    it(`${file} includes all validation jobs, not the optional comment publisher`, () => {
      const jobs = workflow(file).jobs
      expect(jobs.check.needs).toEqual([...dependencies])
      expect(Object.keys(jobs).filter(key => key !== 'check' && key !== 'comment').sort()).toEqual([...dependencies].sort())
      const success = Object.fromEntries(dependencies.map(key => [key, { result: 'success' }]))
      expect(gate(file, success)).toBe(0)
      for (const key of dependencies) {
        for (const result of ['failure', 'cancelled', 'skipped']) {
          expect(gate(file, { ...success, [key]: { result } }), `${key}: ${result}`).not.toBe(0)
        }
      }
      expect(gate(file, {})).not.toBe(0)
    })
  }

  it('remote skips only on an explicit unaffected diff', () => {
    const remote = workflow('remote-g0.yml')
    expect(remote.on.pull_request).toBeNull()
    expect(remote.jobs.check.needs).toEqual(['changes', 'transport'])
    expect(remote.jobs.transport.if).toBe("${{ needs.changes.outputs.required == 'true' }}")
    expect(remote.jobs.transport.steps.some(step => step.run === 'npm --prefix experiments/remote-g0 run smoke:g1')).toBe(true)
    const remotePackage = JSON.parse(readFileSync(join(root, 'experiments/remote-g0/package.json'), 'utf8')) as { scripts: Record<string, string>; engines: { node: string } }
    expect(remotePackage.engines.node).toBe('^22.7.0 || ^24.0.0')
    const remoteLock = JSON.parse(readFileSync(join(root, 'experiments/remote-g0/package-lock.json'), 'utf8')) as { packages: Record<string, { engines?: { node: string } }> }
    expect(remoteLock.packages[''].engines?.node).toBe(remotePackage.engines.node)
    expect(remotePackage.scripts['smoke:g1']).toContain('node --experimental-transform-types --import ./ts-relative-resolve.mjs g1-smoke.mjs')
    const results = (required: string, changes: string, transport: string) => ({
      changes: { result: changes, outputs: { required } }, transport: { result: transport }
    })
    expect(gate('remote-g0.yml', results('true', 'success', 'success'))).toBe(0)
    expect(gate('remote-g0.yml', results('false', 'success', 'skipped'))).toBe(0)
    for (const state of ['failure', 'cancelled', 'skipped']) {
      expect(gate('remote-g0.yml', results('true', 'success', state))).not.toBe(0)
      expect(gate('remote-g0.yml', results('false', state, 'skipped'))).not.toBe(0)
    }
    expect(gate('remote-g0.yml', results('', 'success', 'skipped'))).not.toBe(0)
  })
})

function gitFixture() {
  const cwd = temp()
  const home = temp()
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main', '--template=')
  git('config', 'user.name', 'Scry test')
  git('config', 'user.email', 'scry@example.invalid')
  git('config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(cwd, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'base')
  return { cwd, env, git, base: git('rev-parse', 'HEAD') }
}

describe('remote change detection', () => {
  it('uses real git diffs for ordinary, remote, iOS and workflow changes; rejects unreadable bases', () => {
    const { cwd, env, git, base } = gitFixture()
    const script = source(workflow('remote-g0.yml').jobs.changes, 'Detect remote changes').run!
    const output = join(temp(), 'outputs')
    const detect = (baseSha: string) => {
      writeFileSync(output, '')
      const result = shell(script, { ...env, BASE_SHA: baseSha, GITHUB_OUTPUT: output }, cwd)
      return { status: result.status, output: readFileSync(output, 'utf8') }
    }
    expect(detect(base)).toEqual({ status: 0, output: 'required=false\n' })
    writeFileSync(join(cwd, 'README.md'), 'docs only\n')
    git('add', '.'); git('commit', '-m', 'docs')
    expect(detect(base)).toEqual({ status: 0, output: 'required=false\n' })
    for (const directory of ['experiments/remote-g0', 'apps/ios', '.github/workflows']) {
      const previous = git('rev-parse', 'HEAD')
      mkdirSync(join(cwd, directory), { recursive: true })
      writeFileSync(join(cwd, directory, 'changed.txt'), 'change\n')
      git('add', '.'); git('commit', '-m', 'remote change')
      expect(detect(previous)).toEqual({ status: 0, output: 'required=true\n' })
    }
    expect(detect('0'.repeat(40))).toEqual({ status: 0, output: 'required=true\n' })
    expect(detect('f'.repeat(40)).status).not.toBe(0)
    expect(detect('f'.repeat(40)).output).toBe('')
  })
})

function labelApi(initial: string[]) {
  const labels = new Set(initial)
  const definitions = new Set<string>()
  const issues = {
    getLabel: async ({ name }: { name: string }) => {
      if (!definitions.has(name)) throw Object.assign(new Error('not found'), { status: 404 })
      return { data: { name } }
    },
    createLabel: async ({ name }: { name: string }) => { definitions.add(name) },
    updateLabel: async () => {},
    listLabelsOnIssue: async ({ per_page = 30, page = 1 }: { per_page?: number; page?: number }) => ({
      data: [...labels].slice((page - 1) * per_page, page * per_page).map(name => ({ name }))
    }),
    removeLabel: async ({ name }: { name: string }) => { labels.delete(name) },
    addLabels: async ({ labels: additions }: { labels: string[] }) => { additions.forEach(name => labels.add(name)) }
  }
  const paginate = async (method: typeof issues.listLabelsOnIssue, options: { per_page: number }) => {
    const labels: { name: string }[] = []
    for (let page = 1; ; page++) {
      const { data } = await method({ ...options, page })
      labels.push(...data)
      if (data.length < options.per_page) return labels
    }
  }
  return { labels, definitions, github: { rest: { issues }, paginate } }
}
const context = { repo: { owner: 'test', repo: 'fixture' } }
const core = { info: () => {}, warning: () => {} }
async function runScript(script: string, bindings: Record<string, unknown>) {
  await runInNewContext(`(async () => { ${script}\n })()`, bindings) as unknown
}

describe('ported label workflows', () => {
  it('limits vouch write permissions to the label job', () => {
    const vouch = workflow('pr-vouch.yml')
    const readOnly = { contents: 'read', 'pull-requests': 'read' }
    expect(vouch.permissions).toEqual(readOnly)
    expect(vouch.jobs['collect-targets'].permissions ?? vouch.permissions).toEqual(readOnly)
    expect(vouch.jobs.label.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'write' })
  })

  it('trusted write jobs never checkout PR head or run project code; size bootstrap is reachable', () => {
    for (const file of ['pr-size.yml', 'pr-vouch.yml']) {
      const config = workflow(file)
      expect(config.on.pull_request_target).toMatchObject({ branches: ['main'] })
      for (const job of Object.values(config.jobs)) {
        for (const step of job.steps) {
          expect(step.run).toBeUndefined()
          if (step.uses?.startsWith('actions/checkout@')) {
            expect(step.with?.ref).toBeUndefined() // pull_request_target defaults to trusted base
          }
          expect(step.with?.script ?? '').not.toMatch(/\$\{\{\s*github\.event/)
        }
      }
    }
    const vouch = workflow('pr-vouch.yml')
    expect(vouch.on.pull_request_target).toMatchObject({ branches: ['main'] })
    expect(source(vouch.jobs.label, 'Check PR author trust').uses).toBe('mitchellh/vouch/action/check-user@d66fa29a64600490892131ad87597c30c91fcac4')
    const size = workflow('pr-size.yml')
    expect(size.on.pull_request_target).toHaveProperty('types', expect.arrayContaining(['edited']))
    expect(size.on).toHaveProperty('workflow_dispatch')
    expect(size.on).toHaveProperty('push')
    expect(size.jobs['sync-label-definitions'].if).toBe("github.event_name != 'pull_request_target'")
  })

  it.each([
    ['bot', 'trusted'], ['collaborator', 'trusted'], ['vouched', 'trusted'],
    ['denounced', 'denounced'], ['unknown', 'unvouched']
  ])('vouch %s becomes %s without removing unrelated labels', async (status, expected) => {
    const unrelated = Array.from({ length: 101 }, (_, index) => `unrelated-${index}`)
    const api = labelApi([...unrelated, 'bug', 'vouch:trusted', 'vouch:unvouched'])
    const script = source(workflow('pr-vouch.yml').jobs.label, 'Sync PR labels').with!.script!
    await runScript(script, { ...api, context, core, process: { env: { PR_NUMBER: '7', VOUCH_STATUS: status } } })
    expect([...api.labels].sort()).toEqual([...unrelated, 'bug', `vouch:${expected}`].sort())
    expect(api.definitions.size).toBe(3)
  })

  it.each([false, true])('sizes actual git data with test-only=%s and keeps unrelated labels', async testOnly => {
    const { cwd, env, git, base } = gitFixture()
    writeFileSync(join(cwd, 'sample.test.ts'), Array.from({ length: 120 }, (_, i) => `test ${i}\n`).join(''))
    if (!testOnly) writeFileSync(join(cwd, 'sample.ts'), Array.from({ length: 15 }, (_, i) => `code ${i}\n`).join(''))
    git('add', '.'); git('commit', '-m', 'change')
    const head = git('rev-parse', 'HEAD')
    const remote = temp()
    git('init', '--bare', '--template=', remote)
    git('remote', 'add', 'origin', remote)
    git('push', 'origin', `${base}:refs/heads/main`, `${head}:refs/pull/7/head`)
    git('checkout', '--detach', base) // trusted base worktree; PR commits remain passive objects
    const config = workflow('pr-size.yml')
    let labelConfig = ''
    await runScript(config.jobs['prepare-config'].steps[0].with!.script!, {
      core: { setOutput: (_name: string, value: string) => { labelConfig = value } }
    })
    const unrelated = Array.from({ length: 101 }, (_, index) => `unrelated-${index}`)
    const api = labelApi([...unrelated, 'bug', 'size:XXL'])
    const commands: string[][] = []
    await runScript(source(config.jobs.label, 'Sync PR size label').with!.script!, {
      ...api, core,
      context: { ...context, payload: { pull_request: { number: 7, base: { sha: base }, head: { sha: head } } } },
      process: { env: { PR_SIZE_LABELS_JSON: labelConfig } },
      require: (name: string) => {
        expect(name).toBe('node:child_process')
        return { execFileSync: (command: string, args: string[]) => {
          expect(command).toBe('git')
          commands.push(args)
          return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        } }
      }
    })
    expect([...api.labels].sort()).toEqual([...unrelated, 'bug', testOnly ? 'size:L' : 'size:S'].sort())
    expect(git('rev-parse', 'HEAD')).toBe(base)
    for (const args of commands.filter(args => args[0] === 'diff')) {
      expect(args).toContain('--no-ext-diff')
      expect(args).toContain('--no-textconv')
    }
  })
})

it('Scry policy references, exemptions and review configuration remain aligned', () => {
  const skill = readFileSync(join(root, '.agents/skills/contribution-triage/SKILL.md'), 'utf8')
  expect(skill).toContain('`bingjiang0611/scry`')
  expect(skill).not.toContain('`pingdotgg/t3code`')
  expect(skill).toContain('triage:keep-open')
  expect(skill).toContain('macroscope-review')
  const lines = readFileSync(join(root, '.github/TRIAGE_EXEMPTIONS.td'), 'utf8').split('\n').filter(line => line && !line.startsWith('#'))
  for (const line of lines) expect(line).toMatch(/^github:(?=.{1,39}$)[a-z\d]+(?:-[a-z\d]+)*$/i)
  expect(new Set(lines.map(line => line.toLowerCase())).size).toBe(lines.length)
  const review = load(readFileSync(join(root, '.coderabbit.yaml'), 'utf8')) as { reviews: { request_changes_workflow: boolean } }
  expect(review.reviews.request_changes_workflow).toBe(false)
  const cases = JSON.parse(readFileSync(join(root, '.agents/skills/contribution-triage/evals/cases.json'), 'utf8')) as { cases: { id: string }[] }
  expect(new Set(cases.cases.map(item => item.id)).size).toBe(cases.cases.length)
})
