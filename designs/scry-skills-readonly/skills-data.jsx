// Skills 清单示例数据：取自本机 codex / cc-switch skill 目录，字段对齐 SkillMeta。
const SKILLS = [
  {
    name: 'four-agent-validation',
    scope: 'user',
    enabled: true,
    description: '四路 agent 交叉验证：同一结论分别独立复核，冲突处停下来报告分歧。',
    dir: '/Users/baobingjiang/.codex/skills/four-agent-validation/SKILL.md'
  },
  {
    name: 'humanize-writing',
    scope: 'user',
    enabled: true,
    description: 'Rewrite, polish, review, draft, or audit Chinese and English prose while removing AI-like wording and predictable phrasing.',
    dir: '/Users/baobingjiang/.codex/skills/humanize-writing/SKILL.md'
  },
  {
    name: 'loop-me',
    scope: 'user',
    enabled: true,
    description: 'Grill me about specs for the workflows I want to build, within this workspace.',
    dir: '/Users/baobingjiang/.codex/skills/loop-me/SKILL.md'
  },
  {
    name: 'markdown-to-html',
    scope: 'user',
    enabled: true,
    description: '把 Markdown 转为高品质单文件 HTML 网页。31 套模板自动匹配（白皮书/攻略/仪表板/落地页等）+ frontend-design 兜底。',
    dir: '/Users/baobingjiang/.cc-switch/skills/markdown-to-html/SKILL.md'
  },
  {
    name: 'mobile-use',
    scope: 'user',
    enabled: true,
    description: '通用手机操控 skill。通过 mobile-mcp 接收用户指令操作 iOS/Android 真机：截图、点击、滑动、输入、启动应用。',
    dir: '/Users/baobingjiang/.cc-switch/skills/mobile-use/SKILL.md'
  },
  {
    name: 'qiaomu-goal-meta-skill',
    scope: 'user',
    enabled: true,
    description: '把一次模糊的目标拆成可验收的里程碑，并在每轮结束时回读进度。',
    dir: '/Users/baobingjiang/.codex/skills/qiaomu-goal-meta-skill/SKILL.md'
  },
  {
    name: 'topic-scout',
    scope: 'user',
    enabled: false,
    description: '围绕一个主题做选题侦察：候选角度、已有覆盖、还没人写的缺口。',
    dir: '/Users/baobingjiang/.cc-switch/skills/topic-scout/SKILL.md'
  },
  {
    name: 'yao-meta-skill',
    scope: 'user',
    enabled: true,
    description: '写 skill 的 skill：从一段口述需求生成结构完整、可直接加载的 SKILL.md。',
    dir: '/Users/baobingjiang/.codex/skills/yao-meta-skill/SKILL.md'
  },
  {
    name: 'apply-patch',
    scope: 'builtin',
    enabled: true,
    description: 'Provider 内置补丁写入能力，用统一 diff 格式落盘文件改动。',
    dir: 'codex:builtin/apply-patch'
  },
  {
    name: 'plan-mode',
    scope: 'builtin',
    enabled: true,
    description: 'Provider 内置计划模式：先产出待确认的实施计划，批准后才动手。',
    dir: 'codex:builtin/plan-mode'
  },
  {
    name: 'web-search',
    scope: 'builtin',
    enabled: true,
    description: 'Provider 内置联网检索，用于超出模型知识截止时间的事实查询。',
    dir: 'codex:builtin/web-search'
  },
  {
    name: 'shell-exec',
    scope: 'builtin',
    enabled: true,
    description: 'Provider 内置命令执行通道，受当前审批策略与沙箱约束。',
    dir: 'codex:builtin/shell-exec'
  },
  {
    name: 'view-image',
    scope: 'builtin',
    enabled: true,
    description: 'Provider 内置本地图片读取，把截图作为多模态输入交给模型。',
    dir: 'codex:builtin/view-image'
  },
  {
    name: 'update-plan',
    scope: 'builtin',
    enabled: true,
    description: 'Provider 内置任务清单更新，用于长任务的分步推进与回读。',
    dir: 'codex:builtin/update-plan'
  }
];

const SKILL_ICONS = {
  refresh: 'M3 8a5 5 0 0 1 8.5-3.5L13 6 M13 3v3h-3 M13 8a5 5 0 0 1-8.5 3.5L3 10 M3 13v-3h3',
  x: 'M4 4l8 8 M12 4l-8 8'
};

Object.assign(window, { SKILLS, SKILL_ICONS });
