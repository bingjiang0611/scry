import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

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
  concurrency: { group: string; 'cancel-in-progress': string }
  jobs: Record<string, Job>
}
const root = resolve(import.meta.dirname, '..')
const workflow = (file: string) => load(readFileSync(join(root, '.github/workflows', file), 'utf8')) as Workflow
const source = (job: Job, name: string) => {
  const step = job.steps.find(step => step.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
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

// Preserve all smoke invocations and their historical order across shards.
const SERIAL_RENDERER_UI_ORDER = [
  'node scripts/desktop-remote-ui-smoke.mjs --session-opening-only',
  'node scripts/desktop-remote-ui-smoke.mjs --structure-only',
  'node scripts/desktop-remote-ui-smoke.mjs --conversation-navigation-only',
  'node scripts/desktop-remote-ui-smoke.mjs --unknown-receipt-only',
  'node scripts/desktop-remote-ui-smoke.mjs --unknown-receipt-only --negative-unknown-receipt-control',
  'node scripts/session-capability-ui-smoke.mjs',
  'node scripts/session-capability-ui-smoke.mjs --structure-only',
  'node scripts/session-capability-ui-smoke.mjs --overlays-only',
  'node scripts/session-capability-ui-smoke.mjs --lists-only',
  'node scripts/session-capability-ui-smoke.mjs --loading-only',
  'node scripts/session-capability-ui-smoke.mjs --turn-refs-only',
  'node scripts/session-capability-ui-smoke.mjs --sidebar-activity-only',
  'node scripts/model-picker-ui-smoke.mjs',
  'node scripts/analytics-credits-ui-smoke.mjs',
  'node scripts/chat-preview-ui-smoke.mjs',
  'node scripts/session-performance-ui-smoke.mjs',
  'npm run test:background-ui',
  'npm run test:steer-ui',
  'npm run test:remote-queue-ui',
  'node scripts/desktop-remote-ui-smoke.mjs',
  'node scripts/desktop-remote-ui-smoke.mjs --session-parity-only',
  'node scripts/desktop-remote-ui-smoke.mjs --composer-history-only',
  'node scripts/desktop-remote-ui-smoke.mjs --remote-settings-only',
  'node scripts/desktop-remote-ui-smoke.mjs --session-lifecycle-only',
  'npm run test:pierre:ui',
  'npm run test:source-control:ui',
  'npm run test:workspace:ui',
  'npm run test:side-chat:ui',
  'npm run test:conversation:ipc',
  'node scripts/electron-security-smoke.mjs --dev-pi-history-only',
]

describe('required PR checks', () => {
  for (const [file, dependencies] of [
    ['ci.yml', ['changes', 'node', 'unit', 'unit-coverage', 'cli-compat', 'packaged-electron', 'packaged-macos', 'packaged-linux']],
    ['performance.yml', ['changes', 'compare', 'native']]
  ] as const) {
    const success = Object.fromEntries(dependencies.map(key => [key, key === 'changes' ? { result: 'success', outputs: { required: 'true' } } : { result: 'success' }]))
    const skipped = Object.fromEntries(dependencies.map(key => [key, key === 'changes' ? { result: 'success', outputs: { required: 'false' } } : { result: 'skipped' }]))
    it(`${file} includes every validation and accepts only proven pass or doc skip`, () => {
      const jobs = workflow(file).jobs
      expect(jobs.check.needs).toEqual([...dependencies])
      expect(Object.keys(jobs).filter(key => key !== 'check' && key !== 'comment').sort()).toEqual([...dependencies].sort())
      expect(gate(file, success)).toBe(0)
      expect(gate(file, skipped)).toBe(0)
      expect(gate(file, {})).not.toBe(0)
      expect(gate(file, { ...success, changes: { result: 'success', outputs: {} } })).not.toBe(0)
      expect(gate(file, { ...success, changes: { result: 'success', outputs: { required: 'unknown' } } })).not.toBe(0)
    })
    it.each(dependencies)(`${file} rejects failed, missing or unexpectedly skipped %s`, key => {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(gate(file, { ...success, [key]: { result } }), result).not.toBe(0)
      }
      const missing = { ...success }
      delete missing[key]
      expect(gate(file, missing)).not.toBe(0)
      for (const result of key === 'changes' ? ['failure', 'cancelled', 'skipped'] : ['success', 'failure', 'cancelled']) {
        expect(gate(file, { ...skipped, [key]: { result } }), `unaffected: ${result}`).not.toBe(0)
      }
    })
  }

  it('exports the verified macOS app only on a manual dispatch', () => {
    expect(workflow('ci.yml').on).toHaveProperty('workflow_dispatch')
    const job = workflow('ci.yml').jobs['packaged-macos']
    const pack = source(job, 'Package and smoke the macOS app')
    const archive = source(job, 'Archive the verified macOS app for manual installation')
    const upload = source(job, 'Upload the verified macOS app')
    const manualDispatch = "${{ github.event_name == 'workflow_dispatch' }}"
    expect(pack.run).toBe('npm run pack:artifact')
    expect(pack.if).toBeUndefined()
    expect(archive.if).toBe(manualDispatch)
    expect(upload.if).toBe(manualDispatch)
    expect(job.steps.indexOf(archive)).toBeGreaterThan(job.steps.indexOf(pack))
    expect(job.steps.indexOf(upload)).toBeGreaterThan(job.steps.indexOf(archive))
    expect(upload.with?.['if-no-files-found']).toBe('error')
    expect(upload.with?.path).toBe('release-artifacts/')
    expect(archive.run).toContain('sourceCommit: process.env.GITHUB_SHA')
    expect(spawnSync('bash', ['-n'], { input: archive.run, encoding: 'utf8' }).status).toBe(0)
    const module = archive.run!.split("node --input-type=module <<'NODE'\n")[1].split('\nNODE')[0]
    expect(spawnSync(process.execPath, ['--check', '--input-type=module'], { input: module, encoding: 'utf8' }).status).toBe(0)
  })

  it('does not install or launch an unused Electron runtime in the build-only job', () => {
    const job = workflow('ci.yml').jobs.node
    expect(job.steps.filter(step => step.run).map(step => step.run)).toEqual([
      'npm ci --ignore-scripts', 'npm run typecheck', 'npm run check:harness-bindings',
      'npm run test:shell', 'npm run build', 'npm run build:cli',
      source(job, 'Package unpublished recorder with source provenance').run
    ])
    // Actual runtime jobs still prepare Electron and its Linux sandbox.
    expect(source(workflow('ci.yml').jobs.unit, 'Prepare Electron executable').run).toContain('sudo chmod 4755')
  })

  it('retains an unpublished recorder with its exact source commit and archive digest', () => {
    const job = workflow('ci.yml').jobs.node
    const pack = source(job, 'Package unpublished recorder with source provenance')
    expect(pack.if).toBeUndefined()
    expect(pack['continue-on-error']).toBeUndefined()
    expect(pack.run).toContain('npm pack ./packages/turn-recorder-cli --ignore-scripts --json --pack-destination "$ARTIFACT_DIR"')
    expect(pack.run).toContain("['rev-parse', 'HEAD']")
    expect(pack.run).toContain("createHash('sha256')")
    expect(pack.run).toContain('JSON.stringify({ commit, filename, sha256 }')
    expect(pack.run).not.toMatch(/npm (publish|install|ci|rebuild)\b|electron-builder|chmod 4755/)
    const upload = source(job, 'Retain recorder for exact-commit validation without publishing')
    expect(upload.uses).toBe('actions/upload-artifact@v4')
    expect(upload.with).toEqual({
      name: 'recorder-cli-${{ github.sha }}',
      path: '${{ runner.temp }}/recorder-artifact/',
      'if-no-files-found': 'error',
      'retention-days': 7
    })
  })

  it('pins the packaged macOS gates to a supported standard runner image', () => {
    expect(workflow('ci.yml').jobs['packaged-electron']['runs-on']).toBe('macos-15')
    expect(workflow('ci.yml').jobs['packaged-macos']['runs-on']).toBe('macos-15')
  })

  it('requires whole-program harness binding checks as an unconditional gate', () => {
    const job = workflow('ci.yml').jobs.node
    const bindings = source(job, 'Harness binding checks')
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(scripts['check:harness-bindings']).toBe('node scripts/check-harness-bindings.mjs')
    expect(bindings.run).toBe('npm run check:harness-bindings')
    expect(bindings.if).toBeUndefined()
    expect(bindings['continue-on-error']).toBeUndefined()
  })

  it('shards hosted coverage without filtering tests or overriding their timeouts', () => {
    const ci = workflow('ci.yml')
    const unit = ci.jobs.unit as Job & { strategy: { 'fail-fast': boolean; matrix: { shard: number[] } } }
    expect(unit.strategy.matrix.shard).toEqual([1, 2, 3, 4])
    expect(unit.strategy['fail-fast']).toBe(false)
    const coverage = source(unit, 'Unit, contract tests and coverage shard')
    expect(coverage.if).toBeUndefined()
    expect(coverage.run).toBe("xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24' npm run test:coverage -- --maxWorkers=1 --shard=${{ matrix.shard }}/4 --reporter=default --reporter=blob --outputFile.blob=.vitest-reports/blob-${{ matrix.shard }}.json")
    expect(ci.jobs['unit-coverage'].needs).toEqual(['changes', 'unit'])
    expect(ci.jobs['unit-coverage'].if).toBe("${{ !cancelled() && needs.changes.outputs.required == 'true' }}")
    expect(source(ci.jobs['unit-coverage'], 'Merge shard results and coverage').run).toBe('npx vitest run --merge-reports --coverage')
  })

  it('runs every renderer UI smoke exactly once across the macOS shards', () => {
    const job = workflow('ci.yml').jobs['packaged-electron'] as Job & { strategy: { 'fail-fast': boolean; matrix: { shard: number[] } } }
    expect(job.needs).toBe('changes')
    expect(job.strategy.matrix.shard).toEqual([1, 2, 3])
    expect(job.strategy['fail-fast']).toBe(false)
    expect(source(job, 'Isolated renderer DOM smoke tests').run).toBe('npm run test:renderer:ui:${{ matrix.shard }}')
    // Packaging owns its own slot; a shard that also packed was the slowest job.
    expect(job.steps.some(step => step.run === 'npm run pack:artifact')).toBe(false)
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const shards = [1, 2, 3].map(shard => `npm run test:renderer:ui:${shard}`)
    expect(scripts['test:renderer:ui']).toBe(shards.join(' && '))
    const shardCommands = [1, 2, 3].flatMap(shard => scripts[`test:renderer:ui:${shard}`].split(' && '))
    expect(shardCommands.filter(command => command === 'npm run build')).toHaveLength(1)
    const commands = shardCommands.filter(command => command !== 'npm run build').map(command => command.replace(/:prebuilt$/, ''))
    // Shards are contiguous slices of the historical serial order: several fixtures are
    // sensitive to what ran before them on the same runner, so never reorder across shards.
    expect(commands).toEqual(SERIAL_RENDERER_UI_ORDER)
    expect(new Set(commands).size).toBe(commands.length)
    for (const required of ['npm run test:side-chat:ui', 'npm run test:conversation:ipc', 'npm run test:source-control:ui', 'npm run test:workspace:ui', 'node scripts/analytics-credits-ui-smoke.mjs', 'node scripts/desktop-remote-ui-smoke.mjs --session-parity-only']) {
      expect(commands).toContain(required)
    }
  })

  it('cancels obsolete PR runs but never coalesces main commits', () => {
    for (const file of ['ci.yml', 'performance.yml', 'remote-g0.yml']) {
      const ci = workflow(file)
      expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
      expect(ci.concurrency.group).toMatch(/github.event.pull_request.number \|\| github\.(sha|run_id)/)
    }
  })

  it('never filters the required workflows at the trigger level', () => {
    for (const file of ['ci.yml', 'performance.yml', 'remote-g0.yml']) {
      expect(workflow(file).on.pull_request).toBeNull()
    }
    for (const file of ['ci.yml', 'performance.yml']) {
      const jobs = workflow(file).jobs
      expect(jobs.changes).toEqual({ uses: './.github/workflows/validation-changes.yml' })
      for (const [name, job] of Object.entries(jobs)) {
        if (['changes', 'check', 'comment', 'unit-coverage'].includes(name)) continue
        expect(job.needs).toBe('changes')
        expect(job.if).toBe("${{ needs.changes.outputs.required == 'true' }}")
      }
    }
  })

  it('builds once for the production smoke block, while standalone commands remain fresh', () => {
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const production = ['test:source-control:ui', 'test:workspace:ui', 'test:side-chat:ui', 'test:conversation:ipc']
    expect(scripts['test:renderer:ui:3'].startsWith('npm run build && ')).toBe(true)
    for (const key of production) {
      expect(scripts[key]).toBe(`npm run build && npm run ${key}:prebuilt`)
      expect(scripts[`${key}:prebuilt`]).not.toContain('npm run build')
      expect(scripts['test:renderer:ui:3']).toContain(`npm run ${key}:prebuilt`)
    }
    expect(scripts['check:cli-release']).toBe('npm run typecheck && npm run check:cli-runtime')
    expect(scripts['check:cli-runtime']).toContain('vitest run src/cli src/core/turn-recorder')
    expect(scripts['check:cli-runtime']).toContain('&& npm run build:cli && npm run smoke:cli-package')
    expect(source(workflow('ci.yml').jobs['cli-compat'], 'CLI tests and clean tarball smoke').run).toBe('npm run check:cli-runtime')
  })
})
