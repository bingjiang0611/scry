import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
function gate(file: string, results: Record<string, unknown>) {
  const job = workflow(file).jobs.check
  expect(job.if).toBe('${{ always() }}')
  return shell(job.steps[0].run!, { RESULTS: JSON.stringify(results) }).status
}

// Execute GitHub's own gate scripts rather than a second implementation.
describe('required PR checks', () => {
  it('keeps the failed native comparison authoritative when collecting one diagnostic control', () => {
    const job = workflow('performance.yml').jobs.native
    const primary = source(job, 'Measure baseline then candidate, retaining failures')
    const comparison = source(job, 'Compare native evidence and budgets')
    const control = source(job, 'Measure one same-artifact diagnostic control')
    const directions = source(job, 'Compare diagnostic control in both directions')
    expect(primary.run?.match(/ bench /g)).toHaveLength(2)
    expect(primary.run).toContain('set -o pipefail')
    expect(primary.run?.match(/timing-run.mjs/g)).toHaveLength(2)
    expect(comparison['continue-on-error']).toBeUndefined()
    expect(comparison.run).toBe('node candidate/scripts/performance-native.mjs compare native-results/baseline.json native-results/candidate.json native-results/report.md')
    expect(control.if).toBe("failure() && steps.native_measurements.outcome == 'success' && steps.native_comparison.outcome == 'failure'")
    expect(control.run?.match(/ bench /g)).toHaveLength(1)
    expect(directions.if).toBe("failure() && steps.native_control.outcome == 'success'")
    expect(directions.run).toContain('assertSameNativeArtifact(original, control)')
    expect(directions.run).toContain("[['forward', original, control], ['reverse', control, original]]")
    expect(directions.run).toContain('compareNative(first, second)')
    expect(directions.run).toContain('Not a merge gate.')
    expect(directions.run).toContain('native-results/control-${name}.md')
    expect(directions.run).not.toContain('native-results/report.md')
  })

  it('remote skips only on an explicit unaffected diff', () => {
    const remote = workflow('remote-g0.yml')
    expect(remote.on.pull_request).toBeNull()
    expect(remote.jobs.check.needs).toEqual(['changes', 'transport', 'ios'])
    for (const name of ['transport', 'ios']) {
      const job = remote.jobs[name]
      expect(job.needs).toBe('changes')
      expect(job.if).toBe("${{ needs.changes.outputs.required == 'true' }}")
      expect(job['runs-on']).toBe('macos-15')
      expect(job['timeout-minutes']).toBe(name === 'ios' ? 30 : 20)
      expect(job['continue-on-error']).toBeUndefined()
      expect(job.env?.DEVELOPER_DIR).toBe('/Applications/Xcode_26.3.app/Contents/Developer')
      for (const step of job.steps) expect(step['continue-on-error']).toBeUndefined()
    }
    expect(remote.jobs.transport.steps.some(step => step.run?.includes('xcodebuild'))).toBe(false)
    const commands = remote.jobs.ios.steps.filter(step => step.run).map(step => step.run!.trim())
    expect(commands).toEqual([
      ['ScryRemoteG0', 'build-for-testing', 'scry-ios'],
      ['ScryRemote', 'build', 'scry-ios']
    ].map(([project, action, derived]) =>
      `xcodebuild -project apps/ios/${project}.xcodeproj -scheme ${project} -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$RUNNER_TEMP/${derived}" ARCHS=arm64 CODE_SIGNING_ALLOWED=NO ${action}`
    ))
    const caches = remote.jobs.ios.steps.filter(step => step.uses === 'actions/cache@v4')
    expect(caches).toHaveLength(1)
    expect(caches[0].with?.path).toBe('${{ runner.temp }}/scry-ios/SourcePackages')
    for (const project of ['ScryRemoteG0', 'ScryRemote']) {
      expect(caches[0].with?.key).toContain(`apps/ios/${project}.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`)
      const xcode = readFileSync(join(root, `apps/ios/${project}.xcodeproj/project.pbxproj`), 'utf8')
      expect(xcode).toContain('productName = ScryG0Transport')
      expect(xcode).toContain('relativePath = "../../experiments/remote-g0/swift"')
    }
    expect(remote.jobs.transport.steps.some(step => step.run === 'npm --prefix experiments/remote-g0 run smoke:g1')).toBe(true)
    const remotePackage = JSON.parse(readFileSync(join(root, 'experiments/remote-g0/package.json'), 'utf8')) as { scripts: Record<string, string>; engines: { node: string } }
    expect(remotePackage.engines.node).toBe('^22.7.0 || ^24.0.0')
    const remoteLock = JSON.parse(readFileSync(join(root, 'experiments/remote-g0/package-lock.json'), 'utf8')) as { packages: Record<string, { engines?: { node: string } }> }
    expect(remoteLock.packages[''].engines?.node).toBe(remotePackage.engines.node)
    expect(remotePackage.scripts['smoke:g1']).toContain('node --experimental-transform-types --import ./ts-relative-resolve.mjs g1-smoke.mjs')
  })

  it('remote requires each parallel validation result and rejects missing results', () => {
    const jobs = ['transport', 'ios']
    const results = (required: string, changes: string, result: string) => ({
      changes: { result: changes, outputs: { required } },
      ...Object.fromEntries(jobs.map(job => [job, { result }]))
    })
    const affected = results('true', 'success', 'success')
    const unaffected = results('false', 'success', 'skipped')
    for (const job of jobs) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        expect(gate('remote-g0.yml', { ...affected, [job]: { result } }), `${job}: ${result}`).not.toBe(0)
      }
      for (const result of ['failure', 'cancelled', 'success']) {
        expect(gate('remote-g0.yml', { ...unaffected, [job]: { result } }), `${job}: ${result}`).not.toBe(0)
      }
      const missing: Record<string, unknown> = { ...affected }
      delete missing[job]
      expect(gate('remote-g0.yml', missing), `missing ${job}`).not.toBe(0)
    }
    expect(gate('remote-g0.yml', results('true', 'success', 'success'))).toBe(0)
    expect(gate('remote-g0.yml', results('false', 'success', 'skipped'))).toBe(0)
    for (const state of ['failure', 'cancelled', 'skipped']) {
      expect(gate('remote-g0.yml', results('true', 'success', state))).not.toBe(0)
      expect(gate('remote-g0.yml', results('false', state, 'skipped'))).not.toBe(0)
    }
    expect(gate('remote-g0.yml', results('', 'success', 'skipped'))).not.toBe(0)
  })
})
