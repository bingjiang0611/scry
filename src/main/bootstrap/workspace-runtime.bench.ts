import { afterAll, beforeAll, bench, describe } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceRuntime } from './workspace-runtime'

let root = ''
let workspace = ''
let rememberProject: (cwd: string) => void

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'scry-workspace-runtime-bench-'))
  const userData = join(root, 'user-data')
  workspace = join(root, 'workspace')
  mkdirSync(userData)
  mkdirSync(workspace)
  workspace = realpathSync(workspace)
  const runtime = createWorkspaceRuntime({ appUserDataDir: userData, loadSessions: () => [] })
  rememberProject = runtime.rememberProject
  rememberProject(workspace)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('workspace project recency', () => {
  bench('remember the already-current project', () => {
    rememberProject(workspace)
  }, { iterations: 20, time: 0 })
})
