export const WORKFLOW_CHECK_FIX_COPY = {
  title: '检查并修复',
  description: '先在独立工作副本检查。只有明确失败才修复一次，再运行同一检查；不会自动应用到原项目。',
  goal: '修复项目检查报告的问题，保留仍未解决的诊断。',
  repair: '只在当前工作副本修复检查报告的问题。读取目标与首次检查诊断，不修改检查脚本或测试标准来伪造通过。你的自述不是检查结果；修复后由 Main 再运行同一检查。不得向原项目应用改动。',
  create: '创建项目检查修复草稿',
  argv: '检查命令（JSON 参数数组，不经过 shell）',
  cwd: '检查目录（项目内相对路径）',
  parser: '检查结果格式',
  parsers: { exit_code: '退出码', typescript: 'TypeScript 诊断', node_test: 'Node TAP 测试' },
  timeout: '检查超时（毫秒）',
  invalid: '请填写有效的 JSON 字符串数组、项目内相对目录和正整数超时。',
  placeholder: '["node", "--test", "--test-reporter=tap", "test/example.test.cjs"]'
} as const
