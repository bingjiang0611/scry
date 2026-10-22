import { readFile } from 'node:fs/promises'
import { WorkflowTemplateStore, type WorkflowTemplatePublicationRecord } from '../../src/main/workflow-template-store'
import type { WorkflowTemplateApi } from '../../src/shared/workflow-template'

const [mode, userData, project, requestPath, projectLocks] = process.argv.slice(2)
class InterruptedStore extends WorkflowTemplateStore {
  protected override async savePublication(commandId: string, record: WorkflowTemplatePublicationRecord): Promise<void> {
    if (mode === 'after-target' && record.phase === 'complete') process.exit(78)
    await super.savePublication(commandId, record)
    if (mode === 'after-intent' && record.phase === 'intent') process.exit(77)
  }
}
const store = new InterruptedStore(userData, cwd => {
  if (cwd !== project) throw new Error('fixture project is not authorized')
  return cwd
}, projectLocks)
const request = JSON.parse(await readFile(requestPath, 'utf8')) as Parameters<WorkflowTemplateApi['publish']>[0]
await store.publish(request)
throw new Error('fixture did not reach its selected process-exit boundary')
