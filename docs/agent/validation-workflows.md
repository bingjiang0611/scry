# CI 验证接线

PR 治理、维护与合入条件见 [PR 工作流运行手册](pr-workflow.md)。本页记录具体工作流及其验证范围。

| 文件 | 行为 | 门禁身份 |
| --- | --- | --- |
| `ci.yml` | changes 后并行执行 Node/typecheck、`check:harness-bindings`、shell/App build、4 片 coverage（合并报告）、Node 20/22/24 CLI 编译与运行/包校验、3 片 macOS 15 renderer UI（第 2 片打包，第 3 片共享一次新鲜 App 构建）、Linux App / pacman 检查与 Xvfb 下真实 Electron 的 daemon 模式 smoke（开发布局与打包产物）；桌面 typecheck 仅在 node 执行，独立 CLI 发布命令仍包含它；main push 同组只留最新 run 并全量验证；汇总成功后记录 `scry/full-suite`，`Check` 失败开启或更新 `main-red` | `Check` 汇总全部验证 jobs（含 changes 与 `packaged-linux`）；纯文档时全部跳过，`desktop=false` 时仅 macOS 分片跳过，其余失败、取消、缺失或意外跳过均拒绝 |
| `performance.yml` | PR、main push 与手动 dispatch 触发。changes 后并行执行 compare 与 native；Node 在同一 runner 按 A1/B1…A20/B20 交替采样并记录阶段耗时，counter 随后执行；native 顺序、各场景负载与预算不变。macOS native 只在 PR 改动冻结的 native harness（`nativeHarnessFiles`）、`performance.yml`、`validation-changes.yml` 或 cache-electron action 时在 PR 上运行；其余 App 改动在合入 main 后对父提交测量（每个 push 独立 run，不合并），也可对分支手动 dispatch 立即测量。main push 不跑 Node ABAB | `Performance Check` 汇总 changes 与两个测量 jobs；纯文档时全部跳过，`native_performance=false` 时 native 跳过，`node_performance=false` 时 compare 跳过；评论明确标明未测量（含“合入后在 main 测量”），不计为测量通过；评论不属于正确性门禁 |
| `validation-changes.yml` | CI/Performance 共用的只读 diff；仅 README.md 与 docs/**/*.md 跳过全部验证；只改测试、Agent 指导、PR/Issue 模板、名单或 apps/ios 时 `desktop=false`；只改 recorder（`src/core/turn-recorder/**`、`src/cli/**`、`packages/turn-recorder-cli/**`）时也 `desktop=false`——这些输入仍走 node（类型检查、App build、build:cli、recorder 构件打包）、unit 四片、cli-compat 三个 Node 版本与 packaged-linux（真实打包 + Xvfb 下启动），只有 macOS renderer UI、mac 布局检查与 App 安全 smoke 被跳过；仅 apps/ios 加文档时同时 `node_performance=false`，其余 Ubuntu 验证照跑；混合任何非文档、非 iOS、非 recorder 输入均保留 macOS 门禁与 Node 性能测量；`native_performance` 仅在 `desktop=true` 且改动 native harness 路径时为 true（合同测试逐项核对 `nativeHarnessFiles`）；无法读取 diff 时失败，手动 dispatch 总是全验；main push 全验 CI 并测 native，但 `node_performance=false` | 不在触发器上过滤 required workflow，三个原有必需检查名不变；recorder 只影响 `packaged-electron` 的跳过，`required` 仍为 true，`Check` 的“跳过必须是已证明无影响”不变 |
| `.github/actions/cache-electron/action.yml` | 仅 Electron runtime jobs 使用；按 OS/架构/锁定 Electron 版本缓存 ZIP 与校验文件，原安装器继续校验 SHA256；不缓存 node_modules、App 或编译输出，不使用宽泛 restore prefix | 不替代运行时校验，首次下载失败仍失败 |
| `remote-g0.yml` | main push 一律并行运行 transport 与 ios，成功记录 `scry/remote-g0`；PR 仍按 remote/iOS/工作流的非 README 改动决定是否运行（同一 runner、共享 DerivedData/一份 Swift 包源码缓存，依次编译 ScryRemoteG0、ScryRemote；普通 PR 占 3 个 macOS slot（native 改为合入后测量），remote/iOS 变化时 5 个，改动 native harness 时再加 1 个，与其他 PR 及 main push 共享 GitHub Free 的 5 个 slot）；transport 限 20 分钟、ios 限 30 分钟 | `Remote Check` 要求两项全部成功，或 changes 明确判定无影响且两项全部跳过；检测失败、结果缺失或任一项取消均拒绝 |
| `main-red.yml` | `Check` 或 `Remote Check` 失败、或任一正确性工作流写入成功状态后调用；串行维护一个打开的 `main-red` issue；同 SHA 的两项状态齐全、且 SHA 不早于失败提交时评论并关闭 | 仅告警，不是合并或发布门禁；无 checkout，仅 `issues: write`、`statuses: read`、`contents: read`、`actions: read` |
| `pr-vouch.yml` | 使用默认分支的 VOUCHED 配置，自动同步 `vouch:*` | 仅上下文，不是准入或门禁 |
| `pr-size.yml` | 基础仓库代码读取 PR git diff，不运行 PR 内容；混合 PR 排除测试行 | 仅上下文，不按大小拒绝 PR |

Node 测量豁免以当前 harness 不读取 `apps/ios` 为前提；若未来加入该目录的运行时或生成输入，须先收紧分流范围并恢复相关测量。该豁免不代表手机端性能验收通过。

size 采用上游阈值 XS <10、S <30、M <100、L <500、XL <1000、XXL ≥1000；忽略空白改动，纯测试 PR 仍计算测试行。二进制改动没有行数，这个标签不表示风险。移植补充了标签定义任务的 push/手动触发入口、PR retarget 的 edited 事件，适配 Scry fixture 路径，并禁止 git 外部 diff/textconv。

`pull_request_target` 标签任务只运行可信 workflow/Action，以 PR 为数据，不安装 PR 依赖、不构建 PR 代码、不运行 PR 脚本。不得在这些有写权限的 job 中切到 PR head 执行代码。PR 构建/测试 job 保持只读 token；`performance.yml` 的独立 `comment` job 仅对同仓库 PR 使用 `actions: read` 和 `pull-requests: write`，读取被动报告 artifact 并发布评论，不 checkout、构建或执行 PR 代码。fork 仅保留只读 summary/artifact。不添加 Provider、签名或生产凭据。

`performance-ratchet.yml` 用 `GITHUB_TOKEN` 创建的 PR 通常不会触发后续 PR Actions。当前保持原行为：维护者在获授权后用个人身份关闭再重新打开该 PR，以触发正常检查，并核实 head 与检查结果；不要免检合并。若频繁产生此类 PR，再单独授权最小权限 GitHub App token，不能为了自动化添加宽权限 PAT。

## main 的全量通过记录

仅非取消的 main **push** 可以在自己的 SHA 写 commit status。`Check` 成功写 `scry/full-suite: success`，`Remote Check` 成功写 `scry/remote-g0: success`。Remote 的“已证明无影响”跳过只用于 PR。main 每次都验证 Remote，不继承未验证父提交的状态；原本可跳过的 push 会多调度两个 macOS job（transport 上限 20 分钟、ios 上限 30 分钟），共享原有 5 个 slot。为免连续合入时每个 push 各积压一对 macOS job，Remote 的 main push 与 CI 一样只保留最新一次 run：被取消的 run 不写状态，其 SHA 保持未验证。`Performance Check` 不计入。写入任务仅有 `statuses: write`，不 checkout、不执行仓库代码、不移动 ref、不打 tag。

两个 context 都以最新状态为准。工作流只写成功记录，不写 `failure`：这些记录证明该 SHA 曾通过，失败诊断看 run 和 `main-red` issue。没有成功记录就是未验证，包括被更新 push 取消、被跳过和手动 dispatch。CI 与 Remote 的 main push 都只保留最新一次 run。要为已有 SHA 补记录，重跑保留在 Actions 中的原 main push run；手动 dispatch 可诊断，不能补状态。发布条件见[版本、打包、安装与发布](verification.md#版本打包安装与发布)。

`main-red` 标签留给告警自动化。issue 记录失败的 workflow、SHA、对应 run attempt、失败的 jobs 和最近一个有双成功状态的 main SHA（尚无记录或查询失败时明确说明）。只有两项状态齐备的同一 SHA 能恢复告警；更旧的 run 不覆盖或关闭较新的告警。查询和写入统一使用 job 自带 token，不添加 PAT。

`record-full-suite` / `record-remote` 自身失败不会开启 `main-red`：正确性检查可能已通过，但没有记录的 SHA 仍不能发布。Actions run 会显示失败的写入 job；在原 main push run 重跑失败的写入 job，确认写入后再发布。

<a id="merge-required-checks"></a>

## 合并前只等必需检查

合并只需要**类型检查**（`node`：`npm run typecheck`、harness binding、shell 测试、App build、`build:cli`）和**单测**（`unit` 四片 + `unit-coverage`）这两项通过。不要为 `packaged-electron`（3 片 macOS 15，常排队）或 `Performance Check`（native 只在改动 harness 时跑，其余在 main 上测量）阻塞合并：它们的结果仍出现在 PR 上，但不是合并前置。

`gh pr checks --required` 现在不可用——main 上没有 ruleset，命令会返回 `no required checks reported`。按 job 名过滤，并给等待设上界，避免某个 job 没产出结果时无限等：

```bash
pr=123
deadline=$(( $(date +%s) + 1800 ))
while :; do
  summary=$(gh pr checks "$pr" --json name,state --jq '
    [ .[] | select(.name == "node" or .name == "unit-coverage" or (.name | startswith("unit ("))) ]
    | if any(.state == "FAILURE" or .state == "CANCELLED") then "failed"
      elif length == 6 and all(.state == "SUCCESS" or .state == "SKIPPED") then "pass"
      else "pending" end')
  case "$summary" in pass|failed) break ;; esac
  [ "$(date +%s)" -lt "$deadline" ] || { summary=timeout; break; }
  sleep 20
done
echo "$summary"   # pass / failed / timeout
```

`length == 6` 是 1 个 `node` + 4 片 `unit` + `unit-coverage`。分片数变了就改这个数——写死是有意的：少一个就说明有 job 没产出结果，此时输出 `pending` 直到超时，不会误报通过。

这三个必需项在任何 PR 上都会产出结果：纯文档 PR 里它们以 `SKIPPED` 出现（`changes` 输出 `required=false`），不会被过滤掉，所以上面的循环不会悬挂；`Check` 汇总仍按“跳过必须是已证明无影响”判定。

recorder-only PR（`src/core/turn-recorder/**`、`src/cli/**`、`packages/turn-recorder-cli/**`）现在连 `packaged-electron` 都会跳过，这条路径上实际只需要等 `node`、`unit` 与 Ubuntu 的 `cli-compat`、`packaged-linux`。
