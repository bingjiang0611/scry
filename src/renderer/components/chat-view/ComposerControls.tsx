import type { AgentPermissionMode } from '@shared/runtime'
import type { ChatViewProps } from './types'
import { CliPicker, ModelEffortPicker, RunControlSelect } from '../Pickers'
import { Icon } from '../primitives/Icon'
import type { ModelPickerOption } from '../model-picker-options'
import type { RunControlSelectOption } from '../picker-state'

type ComposerControlsProps = Pick<ChatViewProps,
  'agents'
  | 'selectedAgentId'
  | 'onSelectAgent'
  | 'onOpenRunControls'
  | 'onAddPiAgent'
  | 'onRemovePiAgent'
  | 'onRescan'
  | 'unavailableAgentIds'
  | 'agentScopeLabel'
  | 'agentLocked'
  | 'runControls'
  | 'onRunModel'
  | 'onRunEffort'
  | 'onPermissionMode'
> & {
  composerMenu: 'workdir' | 'agent' | 'modelEffort' | null
  setComposerMenu: (menu: 'workdir' | 'agent' | 'modelEffort' | null) => void
  modelValue: string
  modelOptions: ModelPickerOption[]
  effortOptions: RunControlSelectOption[]
  permissionOptions: RunControlSelectOption[]
  loading: boolean
  composerStatus: string | null
  submitting: boolean
  sessionLoading: boolean
  input: string
  draftAttachments: ChatViewProps['draftAttachments']
  sendBlockedReason: string | null
  sendActionLabel: string
  queueing: boolean
  resetPromptHistory: () => void
  onSend: () => void
  runControlCatalog: ChatViewProps['runControlCatalog']
}

export function ComposerControls({
  agents,
  selectedAgentId,
  onSelectAgent,
  onOpenRunControls,
  onAddPiAgent,
  onRemovePiAgent,
  onRescan,
  unavailableAgentIds,
  agentScopeLabel,
  agentLocked,
  runControls,
  onRunModel,
  onRunEffort,
  onPermissionMode,
  composerMenu,
  setComposerMenu,
  modelValue,
  modelOptions,
  effortOptions,
  permissionOptions,
  loading,
  composerStatus,
  submitting,
  sessionLoading,
  input,
  draftAttachments,
  sendBlockedReason,
  sendActionLabel,
  queueing,
  resetPromptHistory,
  onSend,
  runControlCatalog
}: ComposerControlsProps) {
  return <div className="composer-bottom">
          <div className="composer-controls" role="group" aria-label="权限配置">
            <RunControlSelect
              ariaLabel="权限"
              prefix="权限"
              value={runControls.permissionMode}
              options={permissionOptions}
              tone={runControls.permissionMode === 'full_access' ? 'danger' : undefined}
              onChange={(value) => onPermissionMode(value as AgentPermissionMode)}
              onOpenChange={(open) => { if (open) onOpenRunControls?.('permission') }}
            />
          </div>
          <div className="spacer" />
          <div className="composer-action-controls" role="group" aria-label="Agent、Model 与 Effort">
            <CliPicker
              agents={agents}
              selectedId={selectedAgentId}
              onSelect={onSelectAgent}
              onAddPi={onAddPiAgent}
              onRemovePi={onRemovePiAgent}
              onRescan={onRescan}
              unavailableIds={unavailableAgentIds}
              scopeLabel={agentScopeLabel}
              disabled={agentLocked}
              open={composerMenu === 'agent'}
              onOpenChange={(open) => {
                setComposerMenu(open ? 'agent' : null)
                if (open) onOpenRunControls?.('agent')
              }}
            />
            <ModelEffortPicker
              modelValue={modelValue}
              modelOptions={modelOptions}
              effortValue={runControls.effort ?? ''}
              effortOptions={effortOptions}
              loading={loading}
              open={composerMenu === 'modelEffort'}
              onOpenChange={(open) => {
                setComposerMenu(open ? 'modelEffort' : null)
                if (open) onOpenRunControls?.('modelEffort')
              }}
              onModelChange={(value) => {
                const option = runControlCatalog.models.find(
                  (candidate) => JSON.stringify([candidate.model.providerId ?? null, candidate.model.id]) === value
                )
                onRunModel(option?.model)
              }}
              onEffortChange={(value) => onRunEffort(value || undefined)}
            />
            <button
              type="button"
              className="send"
              onClick={() => {
                resetPromptHistory()
                onSend()
              }}
              disabled={submitting || sessionLoading || !!sendBlockedReason || (!input.trim() && draftAttachments.length === 0)}
              aria-busy={submitting}
              aria-label={sendActionLabel}
              aria-describedby={composerStatus ? 'composer-status' : undefined}
              title={composerStatus ?? sendActionLabel}
            >
              <Icon name="arrowUp" />
              <span className="send-label">{submitting ? '启动中' : queueing ? '加入队列' : '发送'}</span>
            </button>
          </div>
  </div>
}
