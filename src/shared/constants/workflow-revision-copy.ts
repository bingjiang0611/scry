export const workflowRevisionCopy = {
  unsupported: '工作流修订缺少可验证的静态依赖来源，不能安全复用该结果',
  invalid: '工作流修订历史缺失、损坏或与冻结程序不一致',
  stale: '工作流状态版本已变化，不能批准旧修订',
  draftInvalid: '工作流修订草稿无效；仅允许目标、角色和程序正文',
  candidateMissing: '修订候选已过期或尚未在此宿主准备，请重新预览并确认',
  identity: '修订必须保持原工作流和工作区身份，并确认完整的新冻结程序',
  inputsUnavailable: '工作区输入快照不可用；该结果不能跨修订复用',
  sourceChanged: '工作区输入已变化；该结果不能跨修订复用'
}
