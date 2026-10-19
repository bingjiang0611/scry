export const copy = {
  title: 'Scry · Workflow live', brand: 'SCRY', heading: 'WORKFLOW LIVE', demo: '演示回放 · 未连接 Provider',
  objective: '检查鉴权逻辑，隔离修复，再独立验证', project: 'scry / src/routes',
  configure: '模型配置', configHint: '样例模型目录。保存后用于下一次演示，当前运行保持不变。',
  provider: 'Provider', profile: '配置档', model: '模型', defaultProfile: '默认配置', piProfile: '研究配置（样例）',
  selectModel: '请选择模型',
  save: '保存模型配置', saved: '已保存，重新演示时生效', saveFailed: '无法保存到浏览器，本次配置仍可用于重新演示。',
  close: '关闭', invalid: '请为每个阶段选择有效模型。',
  play: '播放回放', freeze: '暂停回放', replay: '重新演示', next: '下一帧',
  pause: '暂停调度', resume: '恢复调度', stop: '停止任务',
  orchestrator: 'ORCHESTRATOR', script: 'workflow.js', mainSession: 'main session',
  plannerRole: '编写工作流 · 等待汇总', plannerIdle: 'idle · 等待执行结果', plannerDone: 'review · 汇总已返回',
  plannerStopped: 'idle · 运行已停止', ownerEnd: '◇ review results',
  phaseLabel: '当前阶段', agentsLabel: '执行中的 Agent', contextLabel: '上下文用量', unknown: '未提供',
  scriptHeld: '脚本保持流程，主会话等待结果', runtime: 'SCRY RUNTIME',
  routing: '按阶段分派', routingModel: '模型来源', routingModelValue: '用户配置',
  routingReady: '可运行任务', routingReadyValue: '依赖就绪即派发',
  routingEvidence: '完成依据', routingEvidenceValue: '执行与证据确认',
  runtimeCaption: '执行器 · 依赖与事件驱动', signoff: 'back to main · review',
  signoffWaiting: '等待工作流结果', signoffDone: '结果已返回 · 1 项未验证', signoffStopped: '运行已停止 · 保留已有结果',
  signoffHint: '只汇总结果与证据引用', events: 'SESSION LOG', eventSource: '演示事件',
  stageDetail: '任务详情', requestedModel: '请求模型', actualModel: '实际模型未观测（演示）',
  evidence: '演示证据 · 不是本仓库的审计结论', emptyResult: '等待任务结果',
  simulatedEdit: '修复阶段仅演示；没有创建 worktree 或改写文件。',
  noCharge: '用量 / 费用：未提供',
  pauseNotice: '调度已暂停；在途任务仍会结束，不启动后续阶段。',
  stopNotice: '停止待确认；下一帧模拟确认，不自动重试。',
  finishedNotice: '回放完成 · 没有执行真实模型或修改文件。', stoppedNotice: '演示已停止 · 没有执行真实模型或修改文件。',
  stageStatus: { pending: '等待依赖', running: '执行中', completed: '已结束', partial: '含未验证', cancelled: '已取消', paused: '待恢复调度' },
  runStatus: { running: 'RUNNING', paused: 'PAUSED', stopping: 'STOP REQUESTED', stopped: 'STOPPED', completed: 'COMPLETED · PARTIAL' },
  taskStatus: { pending: '等待依赖', running: '执行中', completed: '已结束', unverified: '未验证', cancelled: '已取消' },
  stages: {
    plan: { title: '主编排', code: 'plan', detail: '生成检查范围与阶段依赖' },
    scan: { title: '并行扫描', code: 'scan', detail: '逐文件发现候选问题' },
    edit: { title: '隔离修复', code: 'edit', detail: '各自在隔离副本中修复' },
    verify: { title: '独立验证', code: 'verify', detail: '重读证据，交叉检查改动' }
  },
  active: count => `${count} agents running`, counts: (done, total) => `${done} / ${total} 已结束`,
  nodeLabel: (name, state, done, total) => `${name}，${state}，${done} / ${total} 已结束`,
  logs: {
    start: 'workflow.js 已载入 · 模型配置已冻结', plan: '检查范围已展开 · 阶段依赖已建立',
    dispatch: (stage, count) => `${stage} · 派发全部 ${count} 个就绪任务`,
    finish: name => `${name} · 结果已返回`,
    partial: 'signature check · 证据不足，保留为未验证',
    summary: '结果交回主会话 · 含 1 项未验证；未修改真实文件',
    paused: '暂停调度 · 允许在途任务结束', resumed: '恢复调度 · 派发依赖就绪任务',
    stopping: '停止请求已登记 · 等待终态', stopped: '停止已确认 · 待执行任务取消'
  },
  findings: ['类型检查', '回归检查', '签名检查'],
  results: {
    scan: '候选发现已返回。是否成立仍需独立验证。',
    edit: '隔离修复样例已返回；演示没有产生真实文件改动。',
    verify: '验证样例已结束。',
    unverified: '未取得足够证据，保留为未验证；不计为通过或排除。'
  }
}
export const catalog = {
  claude: { label: 'Claude', profiles: ['default'], models: ['sonnet', 'opus', 'haiku'] },
  codex: { label: 'Codex', profiles: ['default'], models: ['sample-codex-model'] },
  qoder: { label: 'Qoder', profiles: ['default'], models: ['sample-qoder-model'] },
  opencode: { label: 'OpenCode', profiles: ['default'], models: ['sample-provider/sample-model'] },
  pi: { label: 'Pi', profiles: ['default', 'research'], models: ['sample-provider/sample-model'] }
}
export const stageIds = ['plan', 'scan', 'edit', 'verify']
export const workerStages = ['scan', 'edit', 'verify']
export const paths = ['auth.ts', 'documents.ts', 'search.ts', 'webhooks.ts', 'users.ts', 'teams.ts', 'sessions.ts', 'exports.ts', 'permissions.ts'].map(name => `src/routes/${name}`)
