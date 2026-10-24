import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ScGit } from './source-control/git'
import { ScProcess } from './source-control/process'
import type { WorkflowRepositorySource } from '../shared/workflow-system'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'

/** Repository revision is an effective input even when checkout bytes match.
 * Reuse the read-only, environment-scrubbed git transport; no hooks/filters or
 * caller-provided argv. Non-repository fixtures do not require an installed CLI. */
export async function workflowAgentSource(workspace: string, environment: () => NodeJS.ProcessEnv): Promise<WorkflowRepositorySource> {
  let directory = await realpath(workspace)
  for (;;) {
    let repository = false
    try { await lstat(join(directory, '.git')); repository = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (repository) {
      const git = new ScGit(new ScProcess(environment), () => { throw new Error(copy.unsupported) })
      const output = (await git.run(workspace, ['rev-parse', '--show-toplevel', 'HEAD'])).trimEnd().split('\n')
      if (output.length !== 2 || !/^[a-f0-9]{40,64}$/.test(output[1])) throw new Error(copy.inputsUnavailable)
      return { kind: 'repository', root: await realpath(output[0]), head: output[1] }
    }
    const parent = dirname(directory)
    if (parent === directory) return { kind: 'non_repository' }
    directory = parent
  }
}
