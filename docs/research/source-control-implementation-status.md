# 源代码管理 A：实施与验收

对应 [技术方案](source-control-technical-plan.md)。实现位于现有右侧 Surface，不替换 Agent 历史文件证据。

## 已实现

- `src/shared/source-control.ts`：Git、PR、review、操作日志与 typed preload 合同。
- `src/main/source-control/`：真实 Git、固定 github.com REST、受信 IPC、进程所有权、草稿与原子操作日志。
- `SourceControlPanel`：独立展示 worktree/index，显式暂存与取消暂存，提交完整已确认 index，fetch 与非强制 push。多个 remote 时必须选择。
- 部分暂存文件需要另行确认才能被完整工作区版本覆盖。暂存已索引的 rename 不会顺带加入旧路径上的新文件。未选路径保持原样。
- `GithubPullRequestPanel`：手动读取账户与 PR，创建 PR、文件 patch、已有评论、行评论草稿、批量 review 与手动 merge。main 重验账户、head/base；review 绑定 `commit_id`，merge 绑定 `sha`。
- Agent 与 Git 写操作按 canonical common-dir 双向互斥。关联 worktree 共用 unknown 阻断；记录 intent 后失联不自动重试。只读核查与人工解除阻断分开，解除不把 unknown 改成成功。
- commit/review 草稿持久化并串行写入；草稿与 HEAD 绑定。提交后的草稿清理失败不会被伪装成远端操作失败。
- 原生 hook、命中的 clean/process filter、签名程序与仓库控制的传输执行扩展均不继承 recorder 自动授权。filter 检查在 `git status` 前；含 gitlink 的仓库拒绝递归读取，以免隐式执行子模块配置。
- renderer 无任意命令或 token。preload 保持 sandbox CJS；IPC 继续通过生产 sender/frame/origin wrapper。Git 传输身份不冒充 GitHub API 账户。

## 检查入口

```sh
npm run test:unit -- src/main/source-control src/renderer/right-surface.test.ts src/preload/index.test.ts src/renderer/components/TurnDiffReviewPanel.test.tsx
npm run typecheck
npm run test:source-control:ui
npm test
npm run test:renderer:ui
npm run check:cli-release
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:artifact
```

`test:source-control:ui` 使用隔离 HOME/userData、真实 production main/preload/renderer、真实临时 Git 与本地 bare remote。原生鼠标/键盘验证暂存、取消暂存、部分暂存确认取消、完整 index 提交、push、对话框焦点/Escape、关闭 Surface 后草稿恢复，以及深浅主题截图。它不启动真实 Provider，也不进行 GitHub 外部写入。

GitHub 测试使用 HTTP fixture。覆盖 head/base/account 漂移、自批限制、行号与 diff 完整性、批量 review、丢响应不重试，以及创建 PR 参数。IPC 拒绝测试调用生产可信 wrapper，并断言特权 listener 未执行。

Git filter 的负对照会在临时仓库故意绕过读取保护，证明原生 `git status` 确实执行 filter；正式路径必须保持 marker 不存在。其他真实 Git 用例覆盖 stale revision、unborn unstage、linked worktree 互斥、有效 push endpoint、崩溃恢复、损坏 journal、草稿重启恢复、部分暂存及 rename 源路径隔离。

## 最终验证结果

冻结基线为 `088c005186924bc72f02a482531acc35e99fc82c` 加本次改动，App 版本 `0.2.187`。隔离打包副本与工作区的 26 个改动代码文件逐一按字节比对一致；文档不属于构建输入。

| 检查 | 结果 | 范围与证据 |
| --- | --- | --- |
| `npm test` | 2956 passed，3 skipped；shell passed | Node 24.18.0；跳过 billing-admin-real、P0、P1 三个真实外部探针 |
| `npm run typecheck` | 通过 | node/web 两套 TypeScript 检查 |
| `npm run test:renderer:ui` | 完整命令通过 | 包含 Credits、会话/终端/历史/远端 UI 与新增真实 source-control App 场景；后者触发 production build |
| `npm run check:cli-release` | 585 passed，CLI package smoke 通过 | 隔离副本，Node 22.22.1 / npm 10.9.4；真实 tarball 安装与初始化/记录/doctor |
| `npm run pack:artifact` | 通过 | macOS arm64，Electron 42.10.1；未签名 App 298,438,401 bytes；CJS preload、私有 CLI、原生资源与完整 Electron smoke |
| `git diff --check` | 通过 | 仅本次相关文件 |

开发产物与复盘现场保留在 `/tmp/scry-source-control-final-VNkQtG`。最终 source-control UI 深浅主题截图位于临时目录 `scry-source-control-ui-jdVUOB`。这些是本地验收产物，不是正式发布或安装。

## 首轮失败记录

- 新 Surface 改变菜单位置，暴露 terminal smoke 中三处 `nth-child(4)` 假设。已改为按“终端”语义定位，仍使用原生坐标输入与命中断言。
- 混合工作区首次整体 renderer gate 在会话缓存场景失败。隔离原始 HEAD 的同用例通过；隔离本次改动及最终工作区的整体 UI gate 均通过。未删除断言或增加重试，不能据此宣称已定位首次缓存失败的原因。
- `check:cli-release` 的 581 项测试和 CLI 构建通过，但 Node 24.18.0 / npm 12.2.0 的 package smoke 失败：`npm pack --json` 返回以包名为键的对象，原 smoke 预期数组。未修改既有 smoke；改用已安装的 Node 22.22.1 / npm 10.9.4，真实 tarball 安装、bin/init/hook/doctor 检查通过。npm 12 下该既有检查仍未兼容。
- 初次真实 App smoke 曾被并行改动中的 `providerCompatibilityNotice` 缺失导入阻挡；对应源码补齐后重构建通过。

## 明确限制

- 尚未授权或执行真实 GitHub PR/review/merge 写入。HTTP fixture 不能证明真实账号、组织规则或 GitHub 分支保护已端到端验收。
- 第一版仅支持本机桌面与 github.com，不包含移动端、其他 forge、自动建/切分支、auto-merge、force push、冲突解决或原生扩展授权流程。相关原生扩展需在终端处理，不会静默绕过。
- 主进程互斥不是跨进程事务或安全沙箱；外部终端仍能并发修改同一仓库。同用户并发攻击者不在保证范围内。
- 输出/文件数量/diff 有明确上限。超限或不完整证据不能作为完整 review/merge 依据；不会用空数组或绿色状态掩盖不可用。
- 开发打包检查使用未签名的隔离副本；不等于签名发布、安装升级或真实 Provider 验收。

后续顺序不变：本项之后为 **4 跨 Provider 接续 → 6 Agent/MCP → 7 历史编辑/文件回退**。本提交不提前加入这些能力。
