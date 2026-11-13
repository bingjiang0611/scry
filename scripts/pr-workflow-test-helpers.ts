import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach } from 'vitest'

// js-yaml is already installed by the build toolchain; no second YAML parser/config format.
export const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
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
export const root = resolve(import.meta.dirname, '..')
export const workflow = (file: string) => load(readFileSync(join(root, '.github/workflows', file), 'utf8')) as Workflow
export const source = (job: Job, name: string) => {
  const step = job.steps.find(step => step.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
export function temp() {
  const path = mkdtempSync(join(tmpdir(), 'scry-pr-workflow-'))
  temporary.push(path)
  return path
}
export function shell(script: string, env: NodeJS.ProcessEnv, cwd = root) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8'
  })
}
