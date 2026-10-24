import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workflowAgentSource } from './workflow-agent-source'

const execute = promisify(execFile)

describe('main-owned Agent repository input identity', () => {
  it('records HEAD changes even when all workspace file bytes stay identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-source-input-'))
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig') }
    const git = (args: string[]) => execute('git', args, { cwd: root, env })
    try {
      await writeFile(env.GIT_CONFIG_GLOBAL, '')
      await writeFile(join(root, 'input.txt'), 'unchanged')
      expect(await workflowAgentSource(root, () => env)).toEqual({ kind: 'non_repository' })
      await git(['init', '--template=', '--initial-branch=main'])
      const commit = (message: string) => git(['-c', 'user.name=bingjiang0611', '-c', 'user.email=307659028+bingjiang0611@users.noreply.github.com', 'commit', '--allow-empty', '-m', message])
      await commit('first')
      const before = await workflowAgentSource(root, () => env)
      await commit('second')
      const after = await workflowAgentSource(root, () => env)
      expect(before).toMatchObject({ kind: 'repository' })
      expect(after).toMatchObject({ kind: 'repository' })
      expect(after).not.toEqual(before)
      expect(await readFile(join(root, 'input.txt'), 'utf8')).toBe('unchanged')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
