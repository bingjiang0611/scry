import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
const root = resolve(import.meta.dirname, '..')
interface Step {
  name?: string
  if?: string
  id?: string
  uses?: string
  run?: string
  with?: Record<string, string>
}
interface Workflow { jobs: Record<string, { steps?: Step[] }> }
const yaml = (path: string) => load(readFileSync(join(root, path), 'utf8'))
const action = yaml('.github/actions/cache-electron/action.yml') as {
  inputs: { lockfiles: { default: string } }
  outputs: { key: { value: string }; hit: { value: string } }
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
    expect(action.outputs.key.value).toBe('${{ steps.restore.outputs.cache-primary-key }}')
    expect(action.outputs.hit.value).toBe('${{ steps.restore.outputs.cache-hit }}')
    const cache = action.runs.steps.find(step => step.uses === 'actions/cache/restore@v4')!
    expect(cache.with).toEqual({
      path: '${{ runner.temp }}/electron-downloads',
      key: 'electron-downloads-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.versions.outputs.versions }}'
    })
    expect(script).not.toContain('ELECTRON_SKIP_BINARY_DOWNLOAD')
    expect(script).not.toContain('ELECTRON_MIRROR')
  })

  it('restores electron-builder toolset downloads for the Linux packaging gate', () => {
    const ci = yaml('.github/workflows/ci.yml') as { jobs: Record<string, { env?: Record<string, string>; steps: Step[] }> }
    const job = ci.jobs['packaged-linux']
    // electron-builder reads ELECTRON_BUILDER_CACHE for its own toolset root and
    // stores downloads under <root>/downloads; the cache must cover that root.
    expect(job.env?.ELECTRON_BUILDER_CACHE).toBe('${{ runner.temp }}/electron-builder-cache')
    const key = job.steps.find(step => step.id === 'builder-toolsets')!
    expect(key.run).toContain("require('./node_modules/electron-builder/package.json').version")
    const index = job.steps.findIndex(step => step.uses === 'actions/cache@v4')
    expect(job.steps[index].with).toEqual({
      path: '${{ runner.temp }}/electron-builder-cache',
      key: '${{ steps.builder-toolsets.outputs.key }}'
    })
    expect(index).toBeLessThan(job.steps.findIndex(step => step.name === 'Package Linux app directory and pacman package'))
  })

  it('prepares only jobs that actually launch Electron, before installation', () => {
    const ci = yaml('.github/workflows/ci.yml') as Workflow
    for (const [name, job] of Object.entries(ci.jobs)) {
      const steps = job.steps ?? []
      const caches = steps.filter(step => step.uses === './.github/actions/cache-electron')
      if (['unit', 'packaged-electron', 'packaged-macos', 'packaged-linux'].includes(name)) {
        expect(caches).toHaveLength(1)
        expect(caches[0].id).toBe('electron-cache')
        expect(steps.indexOf(caches[0])).toBeLessThan(steps.findIndex(step => step.run === 'npm ci'))
        const ready = steps.findIndex(step => step.name === 'Prepare Electron executable')
        const save = steps.find(step => step.uses === 'actions/cache/save@v4')!
        // Save only after the real installer checks, before a later test failure
        // can discard a valid download. Failed preparation must never save a key.
        expect(steps.indexOf(save)).toBe(ready + 1)
        expect(save.if).toBe("${{ steps.electron-cache.outputs.hit != 'true' }}")
        expect(save.with).toEqual({ path: '${{ runner.temp }}/electron-downloads', key: '${{ steps.electron-cache.outputs.key }}' })
      } else expect(caches).toHaveLength(0)
    }
    const performance = yaml('.github/workflows/performance.yml') as Workflow
    expect(performance.jobs.compare.steps?.some(step => step.uses?.includes('cache-electron'))).toBe(false)
    const native = performance.jobs.native.steps!
    const cache = native.find(step => step.uses === './candidate/.github/actions/cache-electron')!
    expect(cache.with?.lockfiles.trim().split(/\s+/)).toEqual(['candidate/package-lock.json', 'baseline/package-lock.json'])
    expect(native.indexOf(cache)).toBeLessThan(native.findIndex(step => step.run?.includes('(cd baseline && npm ci)')))
    const ready = native.findIndex(step => step.name === 'Prepare Electron executables')
    expect(native[ready].run).toContain("(cd baseline && node -e \"require('node:fs').accessSync(require('electron'))\")")
    expect(native[ready].run).toContain("(cd candidate && node -e \"require('node:fs').accessSync(require('electron'))\")")
    const save = native[ready + 1]
    expect(save.uses).toBe('actions/cache/save@v4')
    expect(save.if).toBe("${{ steps.electron-cache.outputs.hit != 'true' }}")
    expect(native[ready + 2].name).toBe('Prepare Electron ABI and build both source revisions')
  })
})
