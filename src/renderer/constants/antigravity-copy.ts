// Antigravity Provider 界面固定文案（P7 D1/D4/D11/D12 与 S3/S5/S10）。
export const ANTIGRAVITY_COPY = {
  accountUnverified: '账号未验证',
  accountUnverifiedDetail: '账号未验证：钥匙串模式不读取登录账号标识，在终端切换账号时 Scry 不会察觉。',
  tosNotice: '条款提示：通过本机已登录的 agy CLI 经 ACP 接入，请自行确认符合 Google / Antigravity 服务条款。',
  processScopeNotice: '运行边界：每轮对话独立启动一个 agy 进程，本轮结束或停止时会终止后台子 Agent 与 /goal 续跑。',
  residualRiskNotice: '用户级来源：~/.gemini/config/mcp_config.json 与 ~/.gemini/config/hooks.json；启动前校验工作区配置指纹。残余风险：检查与执行之间存在时间差（TOCTOU），且本机 ~/.gemini 目录为多会话共享。',
  usagePartial: '部分用量',
  usageUnavailable: '用量不可用',
  modelUnobserved: '模型未观测',
  hookAllowed: '由 hook 放行',
  hookAllowedTitle: '由工作区或用户级 hooks.json（PreToolUse）自动放行，非用户批准'
} as const
