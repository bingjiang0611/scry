# Performance loop：本次验收记录

实现：`e72eeb5`；浏览器 IPC fixture 兼容修复：`d8e577b`。使用方式与覆盖缺口见 [持续性能闭环](performance-loop.md)。

最终验收在隔离 worktree 进行，不包含主工作区其他并发 WIP。环境：macOS arm64 / Apple M2 Pro、Node 22.22.1、npm 10.9.4、Electron 42.10.1、App 0.2.189。未升版本、安装、发布或推送。

## 实际检查

| 检查 | 结果 / 范围 |
|---|---|
| `npm run test:unit -- --maxWorkers=1` | `e72eeb5`：241 文件、2990 tests 通过；3 个真实 Provider/账单探针按默认关闭。最后标准 Performance API 的兼容改动另跑相关 timing/IPC 10 tests 通过，没有再重复全量。 |
| `npm run test:shell` | 通过。 |
| `npm run check:cli-release` | Node 22 / npm 10：类型检查、585 tests、CLI 构建、真实 tarball 安装 smoke 通过。 |
| `npm run typecheck` | 最终兼容修复后再次通过。 |
| `npm run performance:bench` + `performance:compare` | 相同 Node/依赖锁/fixture/config；`940a1db` baseline 对 `d8e577b` candidate，4 场景、14 指标均通过。串行执行。 |
| 负对照 | 真实重复发布使传输 work 增长，compare CLI 返回 1 并保留报告；只保留 1/1000 文本的 projection 被完整性断言拒绝。环境/fixture 不同、缺指标、累计漂移均有失败测试。 |
| 本机记录与版本报告 | 临时真实文件验证队列与轮转上限、掉样、关闭刷新、损坏尾行、构建指纹；失败样本缺 workload 时也会阻止成功子集给出改善结论；未知 longtask 支持不显示为 0。 |
| `node scripts/session-open-bench.mjs short` | 最终代码在完整隐藏 Electron App 上执行 12 次原生会话打开，验证输入、历史、快速切换和草稿；读取到 122 条真实本机记录，含被拒绝历史的 error trace 和正常关闭 health。记录 build：`95afdb6fc02d559028b7d512f4f2d39b975be26b5feff7c4baae00020817404d`。8 个登记进程清理完成。 |
| `npm run pack:artifact` | `d8e577b`：构建、私有 CLI、packaged resource/preload 校验、external links、安全、文件与远程宿主 smoke 通过。开发签名，未 notarize，未安装。 |
| UI 子项 | Credits、chat preview、session performance、background、steer、remote desktop、source control 分别通过。完整 `test:renderer:ui` **不是通过**，见下文。 |
| 路径与 workflow | 16 组清单引用/注册入口校验通过；YAML 解析通过；comment job 不 checkout/执行 PR shell。GitHub 服务端实际运行、评论和 branch protection 未验证。 |

计数属于各自命令和源码快照，不互相相加，也不把 fixture 成功解释为真实 Provider/手机成功。

## 首轮失败与处理

1. 原主工作区全量首次出现 source-control push endpoint 集成用例 5 秒超时；该次为 2976 passed / 1 failed / 3 skipped。单独检查同一测试通过；随后隔离 Node 22 串行全量通过。未改 timeout、skip 或断言，首轮失败保留，不将调度争用推测写成已证实根因。
2. 初版用 15 个单次亚毫秒采样，其 p95 实际由最大值支配；相同且未修改的 terminal/renderer 生产源码也被报回退。保留原始失败报告，改为固定 20 次/批、15 批的均值测量；不提高预算。它是批均值 p95，不是用户请求尾延迟。
3. 主机 npm 12.2.0 的 `npm pack --json` 返回以包名为 key 的对象，既有 CLI smoke 预期数组，因此失败。隔离环境沿用 CI 的 Node 22 / npm 10，原脚本完整通过；未顺带修改无关 CLI 合同。
4. 新 timing import 最初使浏览器内 trusted-IPC fixture 无法打包 `node:perf_hooks`。改用 Node/Chromium 均原生支持的全局 Performance API，并只在 Node 环境读取环境开关；未放宽 CSP 或 IPC 信任检查。相关单测、fixture 编译及剩余 UI/原生 App 验收通过。
5. 上一项修复后，完整 UI suite 停在 Pi 命令反馈数量断言：仍期待三个 `Pi 命令反馈`，实际已有独立通知/扩展消息标签。**在不含本次改动的 `940a1db` 临时 worktree 重现同一断言与相同 DOM**。这是基线已有失败，未删改/跳过断言；其余 UI 命令单独执行并分别报告通过。

## 尚未证明

- 16 组地图不是 16 组完整端到端基准：本次固定门禁是 4 个真实计算/传输路径，其他 native UI、手机直连及网络各跳在清单中有具体 gap 和责任组。
- 没有真实手机/iCTRL、真实 Provider 探针或长时间真实用户负载验收；没有发布后两版本样本，因此不能声称实际用户已变快。
- 队列/文件有界已验证，默认采集在各种重负载下的长期 CPU/功耗影响尚未完成实测。
- CI 文件与本地等价命令已验证；未推送，所以远端 PR 评论和必需合并检查尚未生效。

本机原始基准和报告保留在 `/tmp/scry-performance-delivery-MRzlhP/`（`baseline.json`、`candidate-final.json`、`report-final.md`、`report-final.md.json`、基线 UI 失败日志及验证日志）。早期噪声失败保留在 `/tmp/scry-performance-validation-6IoYi3/`。这些是本机临时证据，不是仓库中的永久基准数据；固定 workload 与预算已提交在 `scripts/`。
