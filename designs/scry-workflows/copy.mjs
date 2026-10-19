export const copy = {
  title: 'Scry · 工作流', brand: 'Scry', workspace: '工作区', project: 'scry',
  workflow: '工作流', current: '当前演示', history: '上一次演示',
  demo: '交互原型 · 演示数据 · 未连接 Provider', objective: '检查接口的鉴权与输入校验',
  scope: 'src/routes/ · 8 个文件', template: '代码审计',
  inspect: '运行详情', configuration: '配置下一次运行', configure: '模型与执行配置',
  configHint: '此处是样例目录，不代表本机模型可用。配置只应用于下一次演示。',
  provider: 'Provider', profile: '配置档', model: '模型', defaultProfile: '默认配置', piProfile: '研究配置（样例）',
  selectModel: '请选择模型', fieldLabel: (stage, field) => `${stage} · ${field}`,
  concurrency: '扫描并发上限', concurrencyHint: '样例上限 1–4；生产还需检查各 Provider 的并发限制。',
  readIntent: '请求只读审计', readBoundary: '只读是任务意图，不是安全沙箱；Provider 和获准的仓库配置仍以本机权限运行。',
  frozen: '当前运行的模型配置已冻结', modelUnknown: '实际模型：未观测（演示）',
  save: '保存模板', saved: '样例模板已保存到此浏览器', saveFailed: '浏览器未允许保存；本次配置仍可用于演示。',
  start: '开始演示', cancel: '关闭', finishFirst: '可以先保存配置；请完成或停止当前演示后，再开始下一次。',
  invalid: '请为每个阶段选择模型，并将并发设为 1–4 的整数。',
  pause: '暂停调度', resume: '恢复调度', stop: '停止', next: '下一步演示',
  readOnlyHistory: '历史记录 · 只读',
  status: { running: '运行中', paused: '调度已暂停', stopping: '停止待确认', stopped: '已停止', completed: '已完成 · 含未验证' },
  states: { completed: '已完成', partial: '含未验证', running: '运行中', pending: '待调度', cancelled: '已取消', unverified: '未验证' },
  stages: {
    plan: { title: '范围规划', description: '拆分检查范围与验收标准' },
    scan: { title: '并行扫描', description: '逐文件收集候选问题' },
    verify: { title: '独立复核', description: '重读源码，验证每项发现' },
    summarize: { title: '汇总报告', description: '保留依据与未验证项' }
  },
  progress: (done, total) => `${done} / ${total} 已收口`, active: (count, cap) => `${count} / ${cap} 执行槽位`,
  selectedStage: '阶段详情', detail: '任务证据', events: '事件日志',
  evidence: '来源', prompt: '任务说明', result: '结果', requestedModel: '请求模型',
  evidenceUnavailable: '此任务尚未产生结果。',
  providerUnavailable: '费用不可用 · 演示未连接 Provider',
  totalStages: (count) => `${count} / 4 阶段收口`,
  notice: {
    running: '点击阶段查看任务；用“下一步演示”推进样例。',
    paused: '已停止新任务调度。在途任务仍可完成；“下一步演示”只收敛在途任务。',
    stopping: '已请求停止，不再派发新任务。等待在途任务确认，结果未知时不自动重试。',
    stopped: '演示任务已确认停止。未开始的任务已取消。',
    completed: '审计完成：1 项确认，1 项排除，1 项未验证。未修改文件。'
  },
  planTask: '检查范围与分片', planPrompt: '根据用户目标生成有界文件清单与检查标准，不修改文件。',
  planResult: '已规划 8 个文件；复核需独立读取源码，无法确认的发现保留为未验证。',
  scanPrompt: '检查所分配文件的鉴权与输入校验，输出带文件与证据位置的候选问题；不修改文件。',
  scanResult: '扫描结果已收集；候选问题必须经过独立复核，不能直接计为确认缺陷。',
  verifyPrompt: '使用新会话重新读取候选证据及调用方；分别标记确认、排除或未验证，并记录依据。',
  summaryTask: '有依据的审计报告', summaryPrompt: '按已确认、已排除、未验证汇总，保留证据引用，不将验证失败解释为安全。',
  summaryResult: '1 项确认：缺少资源归属检查。1 项排除：上层已有校验。1 项未验证：任务中断，未取得足够证据。',
  evidenceLabel: '演示证据 · 非本仓库审计结论',
  findings: [
    { title: '资源归属检查', path: 'src/routes/documents.ts:42', result: '确认（样例）：读取资源前未核对当前用户归属。', verdict: '已确认' },
    { title: '列表参数边界', path: 'src/routes/search.ts:18', result: '排除（样例）：调用方已统一限制参数范围。', verdict: '已排除' },
    { title: 'Webhook 签名验证', path: 'src/routes/webhooks.ts:76', result: '未验证（样例）：复核任务中断，缺少足够证据；不计为已排除。', verdict: '未验证' }
  ],
  logs: {
    started: '演示开始；配置已冻结，运行面板自动关联。', planned: '范围规划完成：8 个文件。',
    scanning: '扫描在途任务已收敛。', scanned: '扫描完成：收集到 3 项候选发现。',
    verifying: '开始独立复核：使用新会话重读证据。', verified: '复核收口：1 项确认、1 项排除、1 项未验证。',
    summarized: '报告已汇总；未修改工作区。', paused: '暂停新任务调度；在途执行不冻结。',
    resumed: '恢复新任务调度。', stopping: '停止请求已登记，等待任务确认。', stopped: '在途任务确认结束；未开始任务取消。'
  }
}

export const catalog = {
  claude: { label: 'Claude', profiles: ['default'], models: ['sonnet', 'opus', 'haiku'] },
  codex: { label: 'Codex', profiles: ['default'], models: ['sample-codex-model'] },
  qoder: { label: 'Qoder', profiles: ['default'], models: ['sample-qoder-model'] },
  opencode: { label: 'OpenCode', profiles: ['default'], models: ['sample-provider/sample-model'] },
  pi: { label: 'Pi', profiles: ['default', 'research'], models: ['sample-provider/sample-model'] }
}
export const stageIds = ['plan', 'scan', 'verify', 'summarize']
export const paths = ['auth.ts', 'documents.ts', 'search.ts', 'webhooks.ts', 'users.ts', 'teams.ts', 'sessions.ts', 'exports.ts'].map(name => `src/routes/${name}`)
