# 源代码管理 A：实施与验收

对应 [技术方案](source-control-technical-plan.md)。实现位于现有右侧 Surface，不替换 Agent 历史文件证据。

## 已实现

- `src/shared/source-control.ts`：Git、PR、review、操作日志与 typed preload 合同。
- `src/main/source-control/`：真实 Git、固定 github.com REST、受信 IPC、进程所有权、草稿与原子操作日志。
- `SourceControlPanel`：统一文件候选列表与差异预览，确认时暂存明确选择的工作区文件并提交完整 index；已有暂存内容锁定纳入，部分暂存余量保留。提交、非强制 push 与 PR 逐步引导、分别确认。fetch 与显式取消暂存保留在独立入口。多个 remote 时必须选择。
- 部分暂存文件需要另行确认才能被完整工作区版本覆盖。暂存已索引的 rename 不会顺带加入旧路径上的新文件。未选路径保持原样。
- `GithubPullRequestPanel`：手动读取账户与 PR，创建 PR、文件 patch、已有评论、行评论草稿、批量 review 与手动 merge。main 重验账户、head/base；review 绑定 `commit_id`，merge 绑定 `sha`。
- Agent 与 Git 写操作按 canonical common-dir 双向互斥。关联 worktree 共用 unknown 阻断；记录 intent 后失联不自动重试。只读核查与人工解除阻断分开，解除不把 unknown 改成成功。
- commit/review 草稿持久化并串行写入；草稿与 HEAD 绑定。提交后的草稿清理失败不会被伪装成远端操作失败。
- 原生 hook、命中的 clean/process filter、签名程序与仓库控制的传输执行扩展均不继承 recorder 自动授权。filter 检查在 `git status` 前；含 gitlink 的仓库拒绝递归读取，以免隐式执行子模块配置。
- renderer 无任意命令或 token。preload 保持 sandbox CJS；IPC 继续通过生产 sender/frame/origin wrapper。Git 传输身份不冒充 GitHub API 账户。

## T3 风格工作流优化（0.2.189）

原操作的三个问题：零暂存时提交入口形成死路；提交、push、PR 缺少下一步引导；`pre-push` 被当作所有 Git 写入的共同阻碍。

- 文件勾选不执行 `git add`。提交弹窗显示完整范围及说明，确认后只暂存候选文件；已有部分暂存不重新整文件暂存。相邻的整文件覆盖、取消暂存与 push 仍分别确认。
- main 在同一登记操作内验证完整候选范围、原有 index 与暂存后的额外路径变化；阶段失败保留现场为 unknown，不自动回滚、重复提交或 push。
- hook/签名阻碍按原生命令的实际触发关系返回。`pre-push` 只限制 push，commit hooks 只限制 commit，index 与 ref transaction hooks 各自限制对应操作；未使用的 checkout/merge/rebase hooks 不阻碍提交。不新增原生扩展授权或执行能力，自动 maintenance 保持关闭。
- 唯一 GitHub remote 自动带入仓库，支持本仓库的 `ssh://git@ssh.github.com:443/...`；多个仓库不猜目标。显式读取后才尝试打开唯一匹配当前仓库/分支的 PR，同仓库同分支不能创建 PR。
- 窄面板在文件/差异之间切换；最大化时并列显示。弹窗 Escape 与返回文件列表恢复原生焦点。

本轮实际检查（不是下面初版的全量发布检查）：

| 检查 | 结果 | 范围与证据 |
| --- | --- | --- |
| focused unit/contract | 300 passed，7 files | source-control main/shared/workflow、生产 IPC trust wrapper、renderer SSR；真实临时 Git 覆盖部分暂存、未选 WIP、阶段失败不重放与中途 index 漂移 |
| `npm run typecheck` | 通过 | node/web；首次暴露本次 tree 变量重名，修正；同时出现的并行 `qoder-credits.ts` 未使用变量错误不是本任务修改，后续当前工作区检查已通过 |
| `npm run test:source-control:ui` | production build 与真实 App 场景通过 | 隔离 HOME/userData，本地临时 Git/bare remote；零 index、候选切换不 stage、部分暂存保护、完整范围提交、hook 未执行且仅阻止 push、显式 push、草稿恢复、原生焦点/Escape、宽窄面板与深浅主题截图 |

独立评审指出未使用的 `post-checkout` 仍被误拦截，已修正并加入真实 Git 回归。评审提出的窄栏按钮裁切未复现：原图中按钮可见，新增 viewport 边界和命中断言通过。浅色截图中的黑色复选框来自 fixture 只切换 CSS 主题、未同步原生控件 color-scheme；fixture 现与生产 `applyTheme` 保持一致。新增断言首次使用旧 `.sc-file` 选择器失败，已定位为测试脚本错误并改为实际 `.sc-file-row`，未删除或放宽断言。

UI 截图保留于临时目录 `scry-source-control-ui-9VUc78`。本轮在 macOS arm64 / Node 24.18.0 的混合工作区构建 `0.2.189`；并行改动未纳入本次提交。本轮未执行真实 GitHub PR/review/merge 写入，未重跑完整发布/打包 gate，也未安装或推送。本轮证据不能替代真实账号与组织权限的验收。

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

## 初版验证结果（0.2.187，不代表本轮完整 gate）

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
- 输出/文件数量/diff 有明确上限。一次 guided commit 最多新增暂存 1,000 个候选路径；超限 main 在执行前拒绝，应缩小选择并分批提交。超限或不完整证据不能作为完整 review/merge 依据；不会用空数组或绿色状态掩盖不可用。
- 开发打包检查使用未签名的隔离副本；不等于签名发布、安装升级或真实 Provider 验收。

后续顺序不变：本项之后为 **4 跨 Provider 接续 → 6 Agent/MCP → 7 历史编辑/文件回退**。本提交不提前加入这些能力。
