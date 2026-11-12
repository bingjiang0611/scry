# CI 验证分流与故障恢复

## 路径与必跑检查

`validation-changes.yml` 用真实 Git diff（包括删除与重命名两端）输出 `required`、`desktop`。不在工作流触发器上加 path filter，避免必需的 `Check` 永久 pending。未知路径走完整验证，无法读取 diff 则失败。

| 改动范围 | CI 必跑 | 桌面产物 / macOS UI |
| --- | --- | --- |
| 仅 `**/README.md`、`docs/**/*.md` | 路径检测、聚合 Check | 不触发 |
| 仅 `src/core/turn-recorder/**`、`src/cli/**`、`packages/turn-recorder-cli/**`，可混合上述文档 | node 检查、全部 unit/contract/coverage 分片及合并、CLI Node 20/22/24 回归、clean tarball 打包冒烟 | 不触发 |
| 其他路径，或与 recorder 混合 | 上述全部检查；桌面 build、macOS 三个 UI 分片及打包冒烟、Linux App/pacman 打包检查 | 必跑 |
| 未限定范围的 `workflow_dispatch`（含桌面发布验证） | 完整检查 | 必跑 |

共享合同（如 `src/shared/turn-record.ts`）、依赖/锁文件、构建配置、CI 与 UI 脚本不列入 recorder 白名单。白名单只允许 recorder 自有目录；若以后移出共享运行代码，先重新审查依赖边界再改规则。没有删除测试或缩小 unit/coverage 范围。`check:cli-runtime` 保留 recorder 单测、CLI 合同、CLI build 和 clean tarball 安装/运行冒烟。Performance、Remote G0 继续沿用原有 `required` 规则，本次不放宽其门禁。

聚合 `Check` 根据两个输出逐项核对 success/skipped；需要的检查跳过、取消、失败、缺失或出现未知输出均不通过。

## 基础设施分类与一次重试

`CI infrastructure recovery` 在 CI 完成后读取 job、日志和 check annotations，分类写入其 Actions summary，并发出 `Infrastructure retry (1/1)` notice：

- runner 未启动：必须有明确的 runner 未领取/启动 annotation；没有日志本身不是证据。
- 软件源下载或 DNS 失败：必须发生在依赖安装/runner 准备步骤，并匹配明确的网络失败证据。日志按 GitHub step 起止时间归属，只用唯一属于失败步骤的日志秒；共享边界秒、缺失时间或无时间戳时不猜测，避免成功步骤的 DNS 负对照污染后续错误。
- 测试断言、测试步骤中的 DNS 负对照、依赖合同错误及未知失败：不自动重试，保留原始失败，先调查。

只调用失败的基础设施 job 的 rerun API（及 GitHub 自动安排的依赖聚合 job），不用重跑全部失败 job 的 API，因此不顺带重跑失败断言。每个完成事件最多请求一个 job；下一次完成后继续处理尚未重试的基础设施 job，避免并发 rerun 冲突。读取所有历史 attempts，按本 CI 唯一的 job 名（含 matrix 坐标）限制每个 job 最多一次；人工先行重跑也消耗额度。重复/过期事件、重名有歧义时不重试。不取消或覆盖首轮日志。

观察工作流仅在合入默认分支后自动生效。它固定 checkout **默认分支**，从不执行 PR head 代码或下载 PR artifact；token 只有 `contents:read`、`checks:read`、`actions:write`。观察工作流本身或 GitHub API 不可用时不能保证自动恢复，应由维护者查看原始结果；不会伪装成功。

Ubuntu 保持 `ubuntu-latest`。`packaged-linux` 已优先加入 kernel.org Ubuntu 镜像，并保留 npm、Electron 和打包工具缓存；不固定 Ubuntu runner 版本来掩盖源问题。

## 桌面 UI 就绪与崩溃证据

`scripts/ui-ready.mjs` 提供同一个被动等待：文档/正文加载、面板实际可见、目标会话匹配可组合在同一断言中；reload/restart 可同时要求不同的 `performance.timeOrigin`。它复用各 harness 原有 deadline，不重试失败、不增加超时、不点击或重建目标。CDP reload 先等 `Page.loadEventFired`，避免在旧 execution context 中等待一个不可能改变的文档 epoch；加载和就绪共用原 deadline，保留 crash 事件失败。

桌面远程场景统一从该等待进入；正文历史、右面板与 host reload，以及本机 side-chat 的面板、正文、theme reload、restart/workbench 共用此函数。专门验证 loading/preview 的用例不强制等到 authoritative，以免跳过要测试的中间状态。恢复检查在读持久化状态前不打开 child/history 来“修复”现场。

现有 Node/Electron 子进程失败仍输出退出码或 signal 与 stderr 尾部；回归测试覆盖 `-11`、`SIGSEGV` 与 Python 栈文本不会被改成成功或重试。CI 设置 `PYTHONFAULTHANDLER=1`，让 Python 子进程在 signal 11 崩溃时输出栈。仓库中没有找到旧的 Python `-11` 专用诊断实现，因此不能声称已验证某个 Python 调用链；不删除或替换已有诊断。

## 单 PR 的 recorder-only 计时

完整 PR diff 包含 CI/UI 改动，本来就应跑桌面门禁，不能把其末次 recorder commit 冒充 recorder-only PR。可在同一任务分支提交完整实现，再提交一个 recorder 自有路径的独立改动，然后显式 dispatch：

```bash
gh workflow run ci.yml --ref <task-branch> -f recorder_base=<implementation-commit-sha>
```

`recorder_base` 只能用于手动计时：必须是 HEAD 的严格祖先、40 位 SHA，且到 HEAD 的 diff 必须非空并仅触及 recorder 白名单/文档；包含任何桌面/未知路径则失败。PR/push 忽略该输入，默认手动/桌面发布验证也不使用它。报告比较 base/head、运行链接、结果、`created_at → completed_at` 墙钟耗时及各必跑 job 时间；排队算在墙钟内，不把并行 job 时长相加当作耗时。
