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
  uses?: string
  with?: Record<string, string>
  concurrency?: { group: string; queue?: string }
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
  'npm run test:history-autoload:ui',
  'npm run test:provider-menu:ui',
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

describe('main correctness records and alerts', () => {
  const mainPush = "!cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main'"
  const alertPermissions = { issues: 'write', statuses: 'read' }
  for (const [file, id, context, alertCondition] of [
    ['ci.yml', 'record-full-suite', 'scry/full-suite', "(needs.check.result == 'failure' || needs.record-full-suite.result == 'success')"],
    ['remote-g0.yml', 'record-remote', 'scry/remote-g0', "needs.record-remote.result == 'success'"],
  ] as const) {
    it(`${file} writes only a successful status from a non-cancelled main push with no checkout`, () => {
      const flow = workflow(file)
      expect(flow.permissions).toEqual({ contents: 'read' })
      expect(flow.on.push).toEqual({ branches: ['main'] })
      const job = flow.jobs[id]
      expect(job.needs).toBe('check')
      expect(job.if).toBe(`\${{ ${mainPush} && needs.check.result == 'success' }}`)
      expect(job.permissions).toEqual({ statuses: 'write' })
      expect(job.steps).toHaveLength(1)
      expect(job.steps[0].uses).toBeUndefined()
      expect(job.steps[0].run).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA"')
      expect(job.steps[0].run).toContain(`-f context=${context} -f state=success`)
      const alert = flow.jobs['main-red']
      expect(alert.needs).toEqual(['check', id])
      expect(alert.if).toBe(`\${{ ${mainPush} && ${alertCondition} }}`)
      expect(alert.permissions).toEqual(alertPermissions)
      expect(alert.uses).toBe('./.github/workflows/main-red.yml')
    })
  }

  it('serializes issue writers and permits only non-cancelled failure or recovery, without checkout', () => {
    const flow = workflow('main-red.yml')
    expect(Object.keys(flow.on)).toEqual(['workflow_call'])
    expect(flow.permissions).toEqual({})
    const job = flow.jobs.alert
    expect(job.if).toBe(`\${{ ${mainPush} && (inputs.check-result == 'success' || inputs.check-result == 'failure') }}`)
    expect(job.permissions).toEqual(alertPermissions)
    expect(job.concurrency).toEqual({ group: 'main-red-issue', queue: 'max' })
    expect(job.steps).toHaveLength(1)
    expect(job.steps[0].uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/)
    expect(job.steps[0].with?.script).not.toContain('${{')
    expect(job.steps[0].with?.script).toContain("['scry/full-suite', 'scry/remote-g0']")
  })

  it('opens once, updates on another failure, and closes only on a full recovery', async () => {
    const script = source(workflow('main-red.yml').jobs.alert, 'Reconcile the main-red issue').with!.script!
    const run = new Function('github', 'context', 'core', 'process', `return (async () => {\n${script}\n})()`)
    const previous = 'a'.repeat(40)
    const first = 'b'.repeat(40)
    const second = 'c'.repeat(40)
    const recovery = 'd'.repeat(40)
    let main = first
    let hasRemote = false
    let issue: { number: number; body: string } | undefined
    const issues = {
      listForRepo: async () => issue ? [issue] : [],
      getLabel: async () => ({}),
      create: async ({ body }: { body: string }) => { issue = { number: 1, body } },
      update: async ({ body, state }: { body?: string; state?: string }) => {
        if (state === 'closed') issue = undefined
        else if (issue && body) issue.body = body
      },
      createComment: async () => ({}),
    }
    const history = [recovery, second, first, previous]
    const success = ['scry/full-suite', 'scry/remote-g0'].map(context => ({ context, state: 'success' }))
    class Api {
      rest = {
        issues,
        repos: {
          listCommitStatusesForRef: async ({ ref }: { ref: string }) => ref === previous ? success
            : ref === recovery ? (hasRemote ? success : success.slice(0, 1)) : [],
          listCommits: async ({ path }: { path?: string }) => (path ? [previous] : history.slice(history.indexOf(main))).map(sha => ({ sha })),
          compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
            const [base, head] = basehead.split('...')
            return { data: { status: history.indexOf(base) > history.indexOf(head) ? 'ahead' : 'behind' } }
          },
        },
        actions: { listJobsForWorkflowRunAttempt: async () => [
          { name: 'unit (2)', conclusion: 'failure' }, { name: 'packaged-linux', conclusion: 'cancelled' },
        ] },
      }
      paginate = Object.assign(async <T, P>(fn: (params: P) => Promise<T>, params: P) => fn(params), {
        iterator: async function* <T, P>(fn: (params: P) => Promise<T>, params: P) { yield { data: await fn(params) } },
      })
    }
    const dispatch = (checkResult: string, sha: string) => run(new Api(), {
      repo: { owner: 'owner', repo: 'repo' }, runId: 123, sha,
    }, { warning: (message: string) => { throw new Error(message) } }, { env: {
      CHECK_RESULT: checkResult, GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com',
    } })
    await dispatch('failure', first)
    const original = issue
    expect(original?.body).toContain(`Failed commit: \`${first}\``)
    expect(original?.body).toContain(`Latest commit with both success statuses: \`${previous}\``)
    expect(original?.body).toContain('/actions/runs/123/attempts/2')
    expect(original?.body).toContain('- unit (2)')
    expect(original?.body).not.toContain('packaged-linux')
    main = second
    await dispatch('failure', second)
    expect(issue).toBe(original)
    expect(issue?.body).toContain(second)
    await dispatch('failure', first)
    expect(issue?.body).toContain(second)
    main = recovery
    await dispatch('success', recovery)
    expect(issue).toBe(original)
    hasRemote = true
    await dispatch('success', recovery)
    expect(issue).toBeUndefined()
  })

  it('gates the real release entries, not offline testing, packaging or dev installation', () => {
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const cli = JSON.parse(readFileSync(join(root, 'packages/turn-recorder-cli/package.json'), 'utf8'))
    expect(scripts['publish:cli']).toBe('npm publish ./packages/turn-recorder-cli')
    expect(cli.scripts.prepublishOnly).toBe('node ../../scripts/check-release-commit.mjs --npm-publish && npm --prefix ../.. run check:cli-release')
    expect(scripts['publish:cli:internal']).toBe('node scripts/publish-cli-internal.mjs')
    expect(readFileSync(join(root, 'scripts/publish-cli-internal.mjs'), 'utf8')).toContain('await checkReleaseCommit({ dryRun: !options.publish })')
    expect(scripts['install:mac']).toBe('npm run check:release-commit && npm run pack:release && node scripts/install-macos.mjs --require-release')
    expect(readFileSync(join(root, 'scripts/install-macos.mjs'), 'utf8')).toContain('if (requireRelease) await checkReleaseCommit(')
    expect(scripts['check:release-commit']).toBe('node scripts/check-release-commit.mjs')
    for (const entry of ['pack:release', 'pack:artifact', 'check:cli-release', 'install:mac:dev']) {
      expect(scripts[entry]).not.toContain('check:release-commit')
    }
  })
})

describe('required PR checks', () => {
  // The fourth entry is the changes output that gates the macOS App jobs: CI keys them on desktop,
  // Performance keys native on native_performance, which implies desktop.
  for (const [file, dependencies, desktopJobs, desktopOutput] of [
    ['ci.yml', ['changes', 'node', 'unit', 'unit-coverage', 'cli-compat', 'daemon-orchestration', 'unit-in-process', 'packaged-electron', 'packaged-linux'], ['packaged-electron'], 'desktop'],
    ['performance.yml', ['changes', 'compare', 'native'], ['native'], 'native_performance']
  ] as const) {
    const changes = (required: string, desktop: string) => ({ result: 'success', outputs: { required, desktop, node_performance: required, native_performance: desktop } })
    const success = Object.fromEntries(dependencies.map(key => [key, key === 'changes' ? changes('true', 'true') : { result: 'success' }]))
    const skipped = Object.fromEntries(dependencies.map(key => [key, key === 'changes' ? changes('false', 'false') : { result: 'skipped' }]))
    const isDesktop = (key: string) => (desktopJobs as readonly string[]).includes(key)
    const noDesktop = Object.fromEntries(dependencies.map(key => [key, key === 'changes' ? changes('true', 'false') : { result: isDesktop(key) ? 'skipped' : 'success' }]))
    it(`${file} includes every validation and accepts only proven pass, doc skip or macOS App skip`, () => {
      const jobs = workflow(file).jobs
      expect(jobs.check.needs).toEqual([...dependencies])
      const auxiliaries = file === 'ci.yml' ? ['check', 'record-full-suite', 'main-red'] : ['check', 'comment']
      expect(Object.keys(jobs).filter(key => !auxiliaries.includes(key)).sort()).toEqual([...dependencies].sort())
      expect(gate(file, success)).toBe(0)
      expect(gate(file, skipped)).toBe(0)
      expect(gate(file, noDesktop)).toBe(0)
      expect(gate(file, {})).not.toBe(0)
      expect(gate(file, { ...success, changes: { result: 'success', outputs: {} } })).not.toBe(0)
      expect(gate(file, { ...success, changes: { result: 'success', outputs: { required: 'true' } } })).not.toBe(0)
      expect(gate(file, { ...success, changes: { result: 'success', outputs: { required: 'unknown' } } })).not.toBe(0)
      expect(gate(file, { ...noDesktop, changes: changes('true', 'unknown') })).not.toBe(0)
      // desktop=true without required=true is contradictory, never a skip.
      expect(gate(file, { ...skipped, changes: changes('false', 'true') })).not.toBe(0)
      for (const key of desktopJobs) expect(jobs[key].if).toBe(`\${{ needs.changes.outputs.${desktopOutput} == 'true' }}`)
    })
    it.each(dependencies.filter(key => key !== 'changes'))(`${file} with desktop=false requires the exact skip/pass for %s`, key => {
      const results = isDesktop(key) ? ['success', 'failure', 'cancelled'] : ['skipped', 'failure', 'cancelled']
      for (const result of results) expect(gate(file, { ...noDesktop, [key]: { result } }), result).not.toBe(0)
      const missing = { ...noDesktop }
      delete missing[key]
      expect(gate(file, missing)).not.toBe(0)
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

  it('exports the verified macOS app only on the manual packaging shard', () => {
    expect(workflow('ci.yml').on).toHaveProperty('workflow_dispatch')
    const job = workflow('ci.yml').jobs['packaged-electron']
    const archive = source(job, 'Archive the verified macOS app for manual installation')
    const upload = source(job, 'Upload the verified macOS app')
    const manualShard = "${{ github.event_name == 'workflow_dispatch' && matrix.shard == 2 }}"
    expect(archive.if).toBe(manualShard)
    expect(upload.if).toBe(manualShard)
    expect(job.steps.indexOf(archive)).toBeGreaterThan(job.steps.indexOf(source(job, 'Package and smoke the macOS app')))
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

  it('pins the packaged macOS gate to a supported standard runner image', () => {
    expect(workflow('ci.yml').jobs['packaged-electron']['runs-on']).toBe('macos-15')
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
    const pack = source(job, 'Package and smoke the macOS app')
    expect(pack.run).toBe('npm run pack:artifact')
    expect(pack.if).toBe('${{ matrix.shard == 2 }}')
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

  it('prefers the signed Ubuntu mirror without removing native fallbacks', () => {
    const install = source(workflow('ci.yml').jobs['packaged-linux'], 'Install archive tools').run!
    expect(install).toContain("printf 'https://mirrors.edge.kernel.org/ubuntu/\\tpriority:0\\n'")
    expect(install).toContain('sudo tee -a /etc/apt/apt-mirrors.txt')
    expect(install).toContain('sudo apt-get update && sudo apt-get install -y libarchive-tools')
    expect(install).not.toMatch(/allow-unauthenticated|trusted=yes/)
  })

  it('collects synthetic workspace failures only from the runner temporary directory', () => {
    const step = source(workflow('ci.yml').jobs['packaged-electron'], 'Preserve synthetic sidebar pixel diagnostics on failure')
    expect(step.if).toBe("${{ failure() && steps.renderer-ui.outcome == 'failure' }}")
    expect(step.with?.path).toContain('${{ runner.temp }}/scry-sidebar-*.png')
    expect(step.with?.path).toContain('${{ runner.temp }}/scry-workspace-session-ui-*/failure.json')
    expect(step.with?.path).not.toContain('/var/folders/')
    const fixture = readFileSync(join(root, 'scripts/workspace-session-ui-checks.mjs'), 'utf8')
    expect(fixture).toContain("join(process.env.RUNNER_TEMP ?? tmpdir(), 'scry-workspace-session-ui-')")
  })

  it('cancels obsolete PR runs and coalesces only fully validated main CI runs', () => {
    for (const file of ['performance.yml', 'remote-g0.yml']) {
      const ci = workflow(file)
      expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
      expect(ci.concurrency.group).toMatch(/github.event.pull_request.number \|\| github\.(sha|run_id)/)
    }
    // A coalesced main run validates everything, since its before..HEAD diff can omit
    // commits whose run was cancelled; manual dispatch keeps a unique group.
    const ci = workflow('ci.yml')
    expect(ci.concurrency.group).toBe("ci-${{ github.event_name == 'push' && github.ref || github.event.pull_request.number || github.run_id }}")
    expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'workflow_dispatch' }}")
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    const detect = load(readFileSync(join(root, '.github/workflows/validation-changes.yml'), 'utf8')) as { jobs: { changes: { steps: Step[] } } }
    // Main pushes validate every CI gate; scripts/ci-changes.test.ts runs this script for each event.
    const run = detect.jobs.changes.steps.find(step => step.name === 'Detect executable changes')!.run!
    expect(run).toContain(`if [ "$EVENT_NAME" = push ]; then\n  printf 'required=true\\ndesktop=true\\n`)
    expect(run).toContain('if [ "$EVENT_NAME" = workflow_dispatch ] || [[ "$BASE_SHA" =~ ^0+$ ]]; then')
  })

  it('never filters the required workflows at the trigger level', () => {
    for (const file of ['ci.yml', 'performance.yml', 'remote-g0.yml']) {
      expect(workflow(file).on.pull_request).toBeNull()
    }
    for (const file of ['ci.yml', 'performance.yml']) {
      const jobs = workflow(file).jobs
      expect(jobs.changes).toEqual({ uses: './.github/workflows/validation-changes.yml' })
      for (const [name, job] of Object.entries(jobs)) {
        if (['changes', 'check', 'comment', 'unit-coverage', 'record-full-suite', 'record-remote', 'main-red'].includes(name)) continue
        expect(job.needs).toBe('changes')
        const output = name === 'compare' ? 'node_performance'
          : name === 'native' ? 'native_performance'
            : name === 'packaged-electron' ? 'desktop' : 'required'
        expect(job.if).toBe(`\${{ needs.changes.outputs.${output} == 'true' }}`)
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

  it('retains an explicit SCRY_HOST_DAEMON=0 job for the in-process escape hatch', () => {
    const job = workflow('ci.yml').jobs['unit-in-process']
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1')
    const step = source(job, 'In-process escape-hatch tests (SCRY_HOST_DAEMON=0)') as Step & { env?: Record<string, string> }
    expect(step.env?.SCRY_HOST_DAEMON).toBe('0')
    expect(step.run).toBe('npm run test:in-process')
  })
})
