import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextFixture } from './diff-workbench-ui.mjs'

export function prepareWorkspaceSessionFixture({ workspace, temp, git }) {
  if (!existsSync(join(workspace, '.git'))) git(workspace, 'init', '-b', 'main')
  writeFileSync(join(workspace, '.gitignore'), '.scry/\n')
  writeFileSync(join(workspace, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'workspace-ui-fixture' }))
  writeFileSync(join(workspace, 'workspace-baseline.txt'), 'baseline\n')
  writeFileSync(join(workspace, 'workbench-context.ts'), contextFixture())
  git(workspace, 'add', '--all')
  git(workspace, 'commit', '--allow-empty', '-m', 'workspace selection fixture')
  git(workspace, 'branch', '-M', 'main')
  git(workspace, 'branch', 'workspace-feature')
  const head = git(workspace, 'rev-parse', 'HEAD')
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', '--stdin'], {
    cwd: workspace,
    input: [
      `create refs/remotes/origin/main ${head}\n`,
      ...Array.from({ length: 150 }, (_, index) => `create refs/heads/fixture/ref-${String(index).padStart(3, '0')} ${head}\n`)
    ].join('')
  })
  const existing = join(temp, 'existing worktree with spaces')
  git(workspace, 'worktree', 'add', '-b', 'existing-feature', existing, 'main')
  return realpathSync(existing)
}
