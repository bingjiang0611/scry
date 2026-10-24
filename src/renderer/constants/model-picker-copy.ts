export const MODEL_PICKER_COPY = {
  automatic: '自动模型',
  automaticDescription: '使用 Provider 默认模型',
  loadingDescription: '正在后台读取可选模型；当前使用 Provider 默认模型',
  trigger: '选择 Model 与 Effort',
  dialog: 'Model 与 Effort',
  model: '模型',
  list: '选择 Model',
  effort: '推理强度',
  defaultEffort: '默认',
  search: '搜索模型或 Provider',
  clear: '清空搜索',
  empty: '没有匹配的模型',
  count: (count: number) => `${count} 个模型`,
  current: (model: string, effort: string) => `当前 ${model}，${effort}`,
  chooseModel: (model: string) => `选择 Model，当前 ${model}`,
  qualified: (provider: string | undefined, label: string) => provider ? `${provider} / ${label}` : label,
  duplicate: (label: string, id: string) => `${label} · ${id}`
} as const
