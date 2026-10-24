import type { AgentModelOption } from '@shared/runtime'
import { MODEL_PICKER_COPY as COPY } from '../constants/model-picker-copy'
import type { RunControlSelectOption } from './picker-state'

export interface ModelPickerOption extends RunControlSelectOption {
  providerId?: string
  modelId?: string
}

export function modelPickerOptions(
  models: AgentModelOption[],
  reason: string | null,
  loading: boolean
): ModelPickerOption[] {
  const labelCounts = new Map<string, number>()
  for (const option of models) {
    const key = JSON.stringify([option.model.providerId, option.label])
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1)
  }
  return [
    {
      value: '',
      label: COPY.automatic,
      description: reason ?? (loading ? COPY.loadingDescription : COPY.automaticDescription)
    },
    ...models.map((option) => ({
      value: JSON.stringify([option.model.providerId ?? null, option.model.id]),
      providerId: option.model.providerId,
      modelId: option.model.id,
      label: labelCounts.get(JSON.stringify([option.model.providerId, option.label]))! > 1
        ? COPY.duplicate(option.label, option.model.id) : option.label,
      description: option.description
    }))
  ]
}

export function groupModelOptions(options: ModelPickerOption[], query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const groups = new Map<string | undefined, ModelPickerOption[]>()
  for (const option of options) {
    const text = [option.label, option.modelId, option.providerId].join(' ').toLocaleLowerCase()
    if (!terms.every((term) => text.includes(term))) continue
    const group = groups.get(option.providerId)
    if (group) group.push(option)
    else groups.set(option.providerId, [option])
  }
  return [...groups].map(([providerId, options]) => ({ providerId, options }))
}
