import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlService } from '../../src/main/source-control/service'
import { ScProcess } from '../../src/main/source-control/process'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const workload = 'repository=1;unsettled-current-cwd=1;kind=branches;refs=1'
const source = 'production SourceControlService.workspaceChoices with a real temporary Git repository and pass-through Git method counters'

describe('workspace choice Git work', () => {
  it('counts identity and Git reads when the selected workspace is also unsettled', async () => {
    const runs = await repeatCounters(defaultRepeats, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-workspace-choice-counter-')))
      const cwd = join(root, 'repository')
      const home = join(root, 'home')
      await mkdir(cwd)
      await mkdir(home)
      const env = () => ({
        PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'
      })
      const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env: env(), encoding: 'utf8' })
      git('init', '-b', 'main')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      git('config', 'commit.gpgsign', 'false')
      await writeFile(join(cwd, 'file.txt'), 'initial\n')
      git('add', 'file.txt')
      git('commit', '-m', 'initial')
      const service = new SourceControlService({
        userData: join(root, 'userData'),
        authorizeDirectory: path => {
          if (path !== cwd) throw new Error('unexpected authorization path')
          return path
        },
        unsettledDirectories: () => [cwd],
        process: new ScProcess(env)
      })
      const identity = vi.spyOn(service.git, 'identity')
      const run = vi.spyOn(service.git, 'run')
      try {
        await expect(service.workspaceChoices({ cwd, kind: 'branches' }))
          .resolves.toMatchObject({ status: 'available', data: { commonDirBusy: true } })
        return { identities: identity.mock.calls.length, gitReads: run.mock.calls.length }
      } finally {
        await service.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
    writeCollector('workspace-choices', [
      measured({
        scenario: 'source-control.workspace-choices-current-run',
        metric: 'identity.calls',
        layer: 'main',
        unit: 'count',
        workload,
        source
      }, runs.identities),
      measured({
        scenario: 'source-control.workspace-choices-current-run',
        metric: 'git.run.calls',
        layer: 'main',
        unit: 'count',
        workload,
        source
      }, runs.gitReads)
    ])
  }, 120_000)
})
