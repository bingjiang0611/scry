export const WORKFLOW_BATCH_MIGRATION_COPY = {
  title: '批量迁移候选草稿',
  description: '为每个迁移项创建独立候选副本，逐项检查后只合并已通过的候选。不会修改源工作区。',
  goal: '迁移目标',
  instruction: '迁移指令',
  items: '迁移项 JSON',
  checkArgv: '检查 argv JSON',
  checkCwd: '检查 cwd',
  parser: '检查解析器',
  parsers: { exit_code: '退出码', typescript: 'TypeScript 诊断', node_test: 'Node 测试' },
  timeoutMs: '检查超时（毫秒）',
  create: '保存项目草稿',
  invalidItems: '迁移项必须是有稳定 key 的 JSON 对象数组',
  invalidCheck: '检查 argv、cwd、解析器或超时无效',
  invalidJson: '请输入有效的 JSON',
  saved: '项目迁移草稿已保存，请在草稿审查中继续'
} as const
