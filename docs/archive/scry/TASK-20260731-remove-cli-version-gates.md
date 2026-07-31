# TASK-20260731-remove-cli-version-gates — 移除 Provider CLI 精确版本门禁

> 本文档由 vibe-workflow 自动生成和维护，记录任务从摄入到交付的全过程。

## 基本信息

| 字段 | 值 |
|------|-----|
| 任务 | 不限制任何 Provider CLI 版本号，避免 CLI 升级后无法在 Scry 中使用 |
| 项目 | scry |
| 级别 | small |
| 开始时间 | 2026-07-31 11:24 CST |
| 状态 | 已完成 |

## 已否决方案与理由（持续追加，跨 Phase 不清空）

| # | 否决的方案 | 为什么否决（实测 / 约束 / 事故 / 成本） | 记录于 | 日期 |
|---|-----------|----------------------------------------|--------|------|
| 1 | 将 Qoder 精确版本从 `1.0.2` 更新为当前 `1.1.5` | 只会把故障推迟到下一次升级，仍违反“版本无关”的要求 | P3 | 2026-07-31 |
| 2 | 完全跳过 CLI 能力检查 | 新版本若真实删除运行所需参数，会在发送模型请求后才失败；应保留参数 surface 探测 | P3 | 2026-07-31 |

## Phase 3 · 代码 & CR 循环

- 删除 `assertRuntimeCliSurface` 中 `qodercli === 1.0.2` 的精确版本比较。`--version` / `--help` 仍用于确认可执行文件健康和运行所需参数 surface。
- 删除固定到 `~/.nvm/versions/node/v22.22.1/bin` 的 Qoder fallback 与 PATH 注入。Qoder 改为从显式配置、当前 PATH 和登录 shell PATH 动态发现。
- 将原“拒绝非 1.0.2”测试改为版本无关契约：`0.9.0`、`1.0.2`、`1.1.5`、`99.0.0` 只要提供必需参数均接受。
- 新增 PATH 回归断言，保证 Scry 不再把某个固定 Node/Qoder 目录插入 Provider 运行环境。
- 复核 `src/main` / `src/core`：已无外部 Provider CLI 的精确版本比较。保留的版本判断属于 Scry 自有持久化格式或 recorder 协议，不用于限制外部 Provider 升级。

## Phase 4 · 验证

- L1 静态 oracle：
  - 目标测试：`src/main/cli-runtime.test.ts`、`src/main/claude-locate.test.ts`，40/40 通过。
  - 全量测试：650 通过、3 个既有显式真实集成 probe 跳过。
  - `npm run typecheck` 通过。
  - `npm run build` 通过。
  - `git diff --check` 通过。
- L2 真实运行时 smoke：
  - 真实 `qodercli 1.0.41` 与 `1.1.5` 均通过同一套无模型 CLI surface probe。
  - Electron 中 Claude、Codex、Qoder、OpenCode 四个 Provider 均被动态发现。
  - Qoder 原生 SDK controls 初始化为 `ready`，返回 16 个模型、3 个权限选项；未发送模型请求。
- L3 用户路径：
  - 开发版打开既有 Qoder 会话，界面识别 `qodercli 1.0.41`，模型选择进入“自动模型”，无 `1.0.2` 错误。
  - 执行 `npm run install:mac`，替换 `/Applications/Scry.app`。
  - 冷启动安装版后，Scry 从登录 shell 动态找到 `/Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/qodercli`；打开 Qoder 会话后模型选择从初始化态进入“自动模型”，无版本门禁错误。
- 未执行 `scry-provider-regression` 的 40 轮真实模型请求协议：该协议会修改真实配置并产生四 Provider 模型调用，需要单独 checkpoint；本任务使用无模型、与版本兼容性直接相关的四 Provider 探测，不能把它表述为完整四 Provider 回归。

## 交付摘要

Scry 不再绑定任何外部 Provider CLI 的精确版本或某个固定 Node 安装目录。升级后的 CLI 会先被动态发现，再按实际运行能力验收；只有缺失 Scry 真正需要的参数或启动协议时才会拒绝。

## 复盘

外部工具兼容性应以能力为契约，而不是以版本字符串代替能力。精确版本门禁和固定安装路径都会把正常升级误判成故障；但完全取消能力探测同样会把真实破坏推迟到发送请求之后，因此本次只移除错误的版本/路径约束，保留可执行性与参数 surface 检查。
