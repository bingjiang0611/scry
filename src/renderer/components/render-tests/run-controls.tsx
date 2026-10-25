import * as shared from './shared'
const { describe, it, expect, resolveRunControlSelection, shouldResetRunControlCatalog } = shared

describe('运行控制选择', () => {
  it('重复选择同一 Agent 时不清空已有模型目录，切换 Provider 时才重置', () => {
    expect(shouldResetRunControlCatalog('qoder', 'qoder')).toBe(false)
    expect(shouldResetRunControlCatalog('codex', 'qoder')).toBe(true)
  })

  it('Provider 目录变化时丢弃失效模型和 effort，并保留仍受支持的权限', () => {
    expect(resolveRunControlSelection({
      models: [{ model: { id: 'new-model' }, label: 'New', efforts: [] }],
      permissions: [
        { id: 'default', label: '默认审批', description: 'ask' },
        { id: 'full_access', label: '完全访问', description: 'allow' }
      ]
    }, {
      model: { id: 'removed-model' },
      effort: 'high',
      permissionMode: 'full_access'
    })).toEqual({ model: undefined, effort: undefined, permissionMode: 'full_access' })
  })
})