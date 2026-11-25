export const ANTIGRAVITY_COPY = {
  residualRiskNotice: '用户级来源：~/.gemini/config/mcp_config.json 与 ~/.gemini/config/hooks.json；启动前校验工作区配置指纹。残余风险：检查与执行之间存在时间差（TOCTOU），且本机 ~/.gemini 目录为多会话共享。',
  usagePartial: '部分用量',
  usageUnavailable: '用量不可用',
  modelUnobserved: '模型未观测',
  hookAllowed: '由 hook 放行',
  hookAllowedTitle: '由工作区或用户级 hooks.json（PreToolUse）自动放行，非用户批准'
} as const
