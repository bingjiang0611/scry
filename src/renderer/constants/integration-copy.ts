export const INTEGRATION_COPY = {
  analyticsUnavailable: '分析接口不可用，请重启 Scry',
  analyticsQueryError: 'SQLite 查询失败，请重试',
  sqliteUnavailable: 'SQLite 暂不可用',
  mcpTestUnavailable: '当前 Provider 不支持 MCP 测试',
  mcpAuthFailed: 'MCP 认证失败',
  runtimeRefreshFailed: '运行状态刷新失败',
  mcpWorkspaceMissing: '没有当前工作目录，无法扫描 MCP 配置',
  mcpGuardUnavailable: '当前 Provider 不支持 MCP Guard',
  mcpVerification: (status: string | undefined) => `刷新后运行状态为 ${status ?? '未返回'}`,
  fullAccess: '完全访问',
  defaultApproval: '默认审批',
  legacyControls: '兼容旧版运行控制',
  approvalDescription: '危险操作会暂停并请求你的确认',
  cachedCatalogMarker: '最后已知模型目录',
  cachedCatalogRead: (observedAt: number) => `最后已知模型目录（${new Date(observedAt).toLocaleString()} 读取）；正在向 Provider 复核运行权限`,
  cachedCatalogRefresh: (reason: string) => `当前显示最后已知模型目录；${reason}`,
  cachedCatalogUnconfirmed: '当前显示最后已知模型目录；Provider 尚未确认本次运行权限',
  cachedSelectionMissing: '最后已知模型目录不包含当前模型、推理强度或权限，请重新选择',
  selectionUnsupported: '当前 Provider 不支持所选模型、推理强度或权限，请重新选择',
  permissionUnconfirmed: '运行权限能力尚未确认，暂不能发送',
  compatibility: (name: string | undefined, observedVersion: string | null | undefined, reason: string, recommendedRange: string | null | undefined) => {
    const version = observedVersion ? ` ${observedVersion}` : ''
    const recommended = recommendedRange ? `；推荐版本 ${recommendedRange}` : ''
    return `${name ?? 'Provider'}${version}：${reason}${recommended}`
  }
}
