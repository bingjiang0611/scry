# Recorder 内容与归属修复：本地交付

本次桌面产物为 Scry **0.2.237**，内置独立 recorder **0.2.56**。基线已整合到 `f9a01039`，包含此前 0.2.235 的桌面改动，未用旧 0.2.227 基线覆盖安装。

## 修复范围

- Pi：单工具事件上限改为 4 MiB；保留已捕获的完整 CAS 正文与有界预览。错误消息的初始化零用量不再被标成真实观测。模型元信息来自 Provider 事件。
- Codex：保留展开调用的原始 exec 程序和参数，不执行原程序；识别 collaboration.spawn_agent。子 rollout 必须满足 session/cwd/父轮次/fork 身份，且不重复合入继承历史。
- Qoder：以唯一主用户消息的 requestSetId → promptId 关联身份；读取经过归属及路径校验的一级子 Agent sidecar，合并相同工具 ID 的父关系，不重复累计子用量。子回复保留为独立 modelSegments，不混入根 assistant。
- 模型：逻辑 tier 与具体 model 分开保存；tier 不覆盖明确不完整或无效的模型证据。
- Diff：终态冻结工作树快照，保留既有 180 秒证据宽限。后续编辑不会污染旧轮；完成后清理 capture。捕获失败保留 unavailable，不改用稍后的工作树。

具体字节、文件数量、读取预算和超限后的 partial 语义见 [CLI README](../../packages/turn-recorder-cli/README.md)。

## 验证

环境：macOS arm64；主运行时 Node 24.18.0。

| 检查 | 结果 | 范围 |
|---|---|---|
| `npm run typecheck` | 通过 | 最终源码与新增断言 |
| `npm run test:unit -- --maxWorkers=1` + `npm run test:shell` | 528 文件、5218 用例通过；4 项跳过；shell 通过 | 跳过性能相关性实测、billing admin、P0/P1 真实探针；未开启真实账号探针 |
| `npm run check:cli-release` | 66 文件、846 用例通过；打包冒烟通过 | 拆分后的 recorder 0.2.56 |
| Node 20.20.2 / 22.22.1 包冒烟 | 通过 | 额外运行 `scripts/cli-package-smoke.mjs`，不是这两个版本的完整测试矩阵 |
| `npm run test:renderer:ui` | 通过 | 包含 Credits 与现有隔离 Electron UI 检查 |
| 现有安装流程分步执行 | 通过 | typecheck → 单 worker 全量 unit → shell → `pack:artifact` → `scripts/install-macos.mjs`；没有跳过包资源校验或隔离 App 冒烟 |
| Codex 原始 exec 保全断言 | 4 个命名空间用例通过 | 完整源程序与两个展开后的 cmd 均保留 |
| `performance:measure -- --scenario recorder.content-reuse` | 5 样本、6 个 L1 候选计数均 unchanged | 经 timing-run 锁执行；机器高负载，不据此声称毫秒变快 |

首轮 CLI 门禁发现 recorder 版本常量仍为 0.2.55；同步为 0.2.56 后门禁通过。

提交钩子要求每个修改文件不超过 20,000 字节。用户确认后，按职责拆出调用、Hook、usage、capture、Codex 子 Agent 处理及测试/文档；保留原公开导出。56 个测试定义的 AST 比对一致，17 个原有辅助函数的函数体也一致。拆分检查发现并修正遗漏导入、未导出的 outputSummary 和一次重复计算；重点 502 项随后通过。

拆分后的首次完整安装流程停在两项 5 秒超时（workspace-choices 分页与 concurrency-trace-launcher 参数拒绝）。相关文件未改；当时 10 核机器负载 17.8、空闲内存约 1 GiB。两个文件单 worker 诊断通过后，用单 worker 重跑全部 5218 项，再逐项完成原流程的 shell、构建、包校验、隔离 App 冒烟、安装及 UI 门禁。保留首轮失败记录；资源争用是推断，未提高超时、删断言、缩小范围或放宽性能门限。

关键负向对照：恢复 Pi 旧工具限制、关闭 Qoder sidecar 接线均使对应回归失败，之后恢复修复。Qoder 的实际 hook → canonical 测试还覆盖错误身份、符号链接、缺失/超限、后续 sidecar 出现，以及工具去重和根回复隔离。

已安装解析器只读重放保全的 Codex 原生日志，三个轮次分别恢复 1/2/1 个自身子调用。Qoder 在整合后源码上曾完成只读重放；最终尝试从安装包再次读取原始文件时被系统拒绝（EPERM），不能把此前结果当作这次安装包重放成功。没有改变原始文件权限。

## 交付边界

- 本次安装不等于用户当前运行实例已加载新版；未停止用户实例，日常实例需用户自行重启。
- 最终安装包构建于提交前的同一运行代码快照；最终安装后仅更新交付记录。未完成公证的开发安装包，不冒充正式公证发布。
- 独立 uploader 与接收端的正文传输修复另仓交付；canonical 原字节与原有 record identity 不变，正文通过独立版本合同传输。此处不声称服务已部署、全局 CLI 已升级或远端 UI 已显示全文。
- 未执行服务部署、DDL、历史正文补传或 cursor 迁移。
- 本轮未重新执行真实 Provider 长稳验收。历史总验收仍未通过；OpenCode 权限/限流与 Codex 服务端 400 未由本地测试消除。
- 下一阶段需接收端维护者授权迁移与部署，再分别发布、安装独立 recorder/uploader 并重新验收；不能用本次组件检查代替端到端成功。
