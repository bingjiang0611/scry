import { readFile } from 'node:fs/promises'
import { WorkflowTemplateStore, type WorkflowTemplateDeletionRecord } from '../../src/main/workflow-template-store'
import type { WorkflowTemplateApi } from '../../src/shared/workflow-template'

const [mode, userData, project, requestPath, locks] = process.argv.slice(2)
class InterruptedDeletion extends WorkflowTemplateStore {
  protected override async saveDeletion(commandId: string, record: WorkflowTemplateDeletionRecord) {
    await super.saveDeletion(commandId, record)
    if (mode === 'after-intent' && record.phase === 'intent') process.exit(77)
  }
  protected override async removeDefinition(path: string) {
    await super.removeDefinition(path)
    if (mode === 'after-target') process.exit(78)
  }
}
const store = new InterruptedDeletion(userData, cwd => {
  if (cwd !== project) throw new Error('unauthorized fixture project')
  return cwd
}, locks)
const request = JSON.parse(await readFile(requestPath, 'utf8')) as Parameters<WorkflowTemplateApi['delete']>[0]
await store.delete(request)
throw new Error('fixture did not exit at the selected deletion boundary')
