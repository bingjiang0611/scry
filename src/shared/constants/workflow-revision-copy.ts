export const workflowRevisionCopy = {
  unsupported: '修订恢复不支持 check、replica、verification 及使用副本的 Agent 调用；这些工作流必须保持原修订',
  invalid: '工作流修订历史缺失、损坏或与冻结程序不一致',
  stale: '工作流状态版本已变化，不能批准旧修订',
  identity: '修订必须保持原工作流和工作区身份，并确认完整的新冻结程序',
  inputsUnavailable: '工作区输入快照不可用；该结果不能跨修订复用',
  sourceChanged: '工作区输入已变化；该结果不能跨修订复用'
}
