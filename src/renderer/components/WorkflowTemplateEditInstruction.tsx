import type { WorkflowTemplateEditContext } from '@shared/workflow-template'
import { workflowTemplateEditCopy as copy } from '@shared/constants/workflow-template-edit-copy'

export function WorkflowTemplateEditInstruction({ edit, hasEditor }: { edit: WorkflowTemplateEditContext; hasEditor: boolean }) {
  return <section aria-label={copy.instruction}><h3>{copy.instruction}</h3><p className="workflow-edit-instruction">{edit.instruction}</p>
    {!hasEditor && <p>{copy.chooseTarget}</p>}
  </section>
}
