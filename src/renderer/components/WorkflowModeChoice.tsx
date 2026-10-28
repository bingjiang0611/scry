import { useState } from 'react'
import type { ConversationMetadataChange, ConversationSummary } from '@shared/conversation-api'
import { WORKFLOW_CONVERSATION_MODES, type WorkflowConversationMode, type WorkflowRoutingMode } from '@shared/workflow-mode'
import { WORKFLOW_MODE_COPY as copy } from '@shared/constants/workflow-mode-copy'

/**
 * Per-conversation workflow mode. Recognition spends one call per new message,
 * so enabling it shows the stored scope first and needs a second, explicit
 * confirmation; Main then writes the grant itself.
 */
export function WorkflowModeChoice({ summary, disabled, onChange }: {
  summary?: ConversationSummary
  disabled: boolean
  onChange: (change: ConversationMetadataChange) => Promise<void>
}) {
  const [confirming, setConfirming] = useState<WorkflowRoutingMode>()
  const current = summary?.workflowMode ?? 'off'
  const apply = (mode: WorkflowConversationMode) => {
    setConfirming(undefined)
    if (mode === current && (mode === 'off' || summary?.workflowRoutingConsent)) return
    void onChange({ kind: 'workflow_mode', mode }).catch(() => undefined)
  }
  return <div className="workflow-mode-choice">
    <label>{copy.label}
      <select data-workflow-mode="conversation" disabled={disabled} value={current}
        onChange={event => {
          const mode = event.target.value as WorkflowConversationMode
          if (mode !== 'off' && !summary?.workflowRoutingConsent) { setConfirming(mode); return }
          apply(mode)
        }}>
        {WORKFLOW_CONVERSATION_MODES.map(mode => <option key={mode} value={mode}>{copy.values[mode]}</option>)}
      </select>
    </label>
    {confirming && <div className="workflow-mode-consent" role="group" aria-label={copy.consentRequired}>
      <p>{copy.consentScope}</p>
      <button type="button" className="btn" data-workflow-mode="confirm" disabled={disabled}
        onClick={() => apply(confirming)}>{copy.confirmMode(confirming)}</button>
      <button type="button" className="btn" data-workflow-mode="cancel" disabled={disabled}
        onClick={() => setConfirming(undefined)}>{copy.cancel}</button>
    </div>}
    {current !== 'off' && !summary?.workflowRoutingConsent && !confirming && <button type="button"
      className="btn" disabled={disabled} onClick={() => setConfirming(current)}>{copy.confirmMode(current)}</button>}
    {current !== 'off' && summary?.workflowRoutingConsent && <p className="workflow-mode-note">{copy.granted(summary.workflowRoutingConsent.scope)}</p>}
    {current === 'manual' && <p className="workflow-mode-note">{copy.manualLimit}</p>}
  </div>
}
