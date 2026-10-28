export const appRunEditLastTurnCopy = {
  lastTurnChanged: '最后一条消息已变化，已拒绝从过期边界建立分支',
  reloadLastTurn: '重新打开当前会话后再编辑最后一条消息',
  previousBoundaryChanged: '上一轮边界与当前会话不一致',
  forkUnavailable: '当前 Provider 不支持从历史边界建立分支',
  missingForkSession: 'Provider 未返回分支会话 ID',
  upgradeProvider: '升级 Provider CLI/SDK 后重试',
  missingPreviousBoundary: '缺少上一轮边界，已拒绝把多轮会话当成首轮重新开始',
  loadFullSession: '加载完整会话后再编辑最后一条消息',
  restartChanged: '停止轮次已变化或已形成 Provider 边界，已拒绝重新开始',
  reloadRestart: '重新打开当前会话；只有全部轮次都已停止且未形成原生边界时才能直接编辑重发'
} as const
