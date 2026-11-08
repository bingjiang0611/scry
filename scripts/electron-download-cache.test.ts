import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
const root = resolve(import.meta.dirname, '..')
interface Step {
  id?: string
  uses?: string
  run?: string
  with?: Record<string, string>
}
interface Workflow { jobs: Record<string, { steps?: Step[] }> }
const yaml = (path: string) => load(readFileSync(join(root, path), 'utf8'))
const action = yaml('.github/actions/cache-electron/action.yml') as {
  inputs: { lockfiles: { default: string } }
  runs: { using: string; steps: Step[] }
}
const script = action.runs.steps.find(step => step.id === 'versions')!.run!
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(versions: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'scry-electron-cache-'))
  directories.push(directory)
  const locks = versions.map((version, index) => {
    const path = join(directory, `lock-${index}.json`)
    writeFileSync(path, JSON.stringify({ packages: { 'node_modules/electron': { version }, unrelated: { version: String(index) } } }))
    return path
  })
  const output = join(directory, 'output')
  const environment = join(directory, 'environment')
  const run = (files = locks) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    env: { PATH: process.env.PATH, LOCKFILES: files.join('\n'), RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_ENV: environment },
    encoding: 'utf8'
  })
  return { directory, output, environment, run }
}

describe('Electron download cache', () => {
  it.each([
    { versions: ['42.10.1'], key: '42.10.1' },
    { versions: ['42.10.1', '42.10.1'], key: '42.10.1' },
    { versions: ['43.0.0', '42.10.1'], key: '42.10.1+43.0.0' }
  ])('keys only the exact runtime versions: $key', ({ versions, key }) => {
    const { directory, output, environment, run } = fixture(versions)
    expect(run().status).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(`versions=${key}\n`)
    expect(readFileSync(environment, 'utf8')).toBe(`electron_config_cache=${directory}/electron-downloads\n`)
  })

  it('rejects an unreadable source lock rather than reusing an unrelated runtime', () => {
    const { directory, run } = fixture(['42.10.1'])
    expect(run([join(directory, 'missing.json')]).status).not.toBe(0)
  })

  it('persists only version/OS/architecture-specific downloads with no broad restore prefix', () => {
    expect(action.runs.using).toBe('composite')
    expect(action.inputs.lockfiles.default).toBe('package-lock.json')
    const cache = action.runs.steps.find(step => step.uses === 'actions/cache@v4')!
    expect(cache.with).toEqual({
      path: '${{ runner.temp }}/electron-downloads',
      key: 'electron-downloads-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.versions.outputs.versions }}'
    })
    expect(script).not.toContain('ELECTRON_SKIP_BINARY_DOWNLOAD')
    expect(script).not.toContain('ELECTRON_MIRROR')
  })

  it('prepares only jobs that actually launch Electron, before installation', () => {
    const ci = yaml('.github/workflows/ci.yml') as Workflow
    for (const [name, job] of Object.entries(ci.jobs)) {
      const steps = job.steps ?? []
      const caches = steps.filter(step => step.uses === './.github/actions/cache-electron')
      if (['unit', 'packaged-electron', 'packaged-linux'].includes(name)) {
        expect(caches).toHaveLength(1)
        expect(steps.indexOf(caches[0])).toBeLessThan(steps.findIndex(step => step.run === 'npm ci'))
      } else expect(caches).toHaveLength(0)
    }
    const performance = yaml('.github/workflows/performance.yml') as Workflow
    expect(performance.jobs.compare.steps?.some(step => step.uses?.includes('cache-electron'))).toBe(false)
    const native = performance.jobs.native.steps!
    const cache = native.find(step => step.uses === './candidate/.github/actions/cache-electron')!
    expect(cache.with?.lockfiles.trim().split(/\s+/)).toEqual(['candidate/package-lock.json', 'baseline/package-lock.json'])
    expect(native.indexOf(cache)).toBeLessThan(native.findIndex(step => step.run?.includes('(cd baseline && npm ci)')))
  })
})
