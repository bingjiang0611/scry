import { useId } from 'react'
import type { WorkflowMessageOverride } from '@shared/workflow-mode'
import { WORKFLOW_MODE_COPY as copy } from '@shared/constants/workflow-mode-copy'

export function WorkflowMessageChoice({ value, disabled, onChange }: {
  value: WorkflowMessageOverride | undefined
  disabled: boolean
  onChange: (value: WorkflowMessageOverride | undefined) => void
}) {
  const name = useId()
  return <fieldset className="conversation-message-choice" disabled={disabled} title={copy.messageHint}>
    <legend>{copy.messageLabel}</legend>
    {(['default', 'direct', 'workflow'] as const).map(choice => <label key={choice}>
      <input type="radio" name={name} value={choice} checked={(value ?? 'default') === choice}
        onChange={() => onChange(choice === 'default' ? undefined : choice)} />
      <span>{copy.messageValues[choice]}</span>
    </label>)}
  </fieldset>
}
