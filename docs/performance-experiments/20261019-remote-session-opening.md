# 2026-10-19：远程会话打开定位与按需查询

## 范围与结论

修复进入远程会话后没有定位到最新消息的问题。打开路径删除重复 catalog 刷新，Provider 命令只在输入 `/` 后查询。没有新增缓存、进程池、IPC 协议或网络重试。

证据等级：L1 请求减少已验证；L2 无可靠结论；L3/真实 mac2 未验证。不能宣称首屏减少了 1.2 秒。

## 依据与候选

- `App.tsx` 的本机滚动控制器也参与 remote view，但其依赖是本机 session；`RemoteChat` 自己没有异步历史打开的粘底生命周期。
- App 已统一维护已连接主机的 catalog。再次进入 RemoteChat 不需要再主动刷新一次。
- 打开会话时查询 slash commands 与查看历史无关。首次输入 `/` 仍须承担真实查询成本，没有把它变成后台预取或默认成功。
- 只读快照中最新 packaged 日志分组 `2234a368f789b28ceb671146e7fba33f3875e7343fd0f43c8e37622763cbea90`：commands 19 条，p50 1229.9 ms；history 18 条，p50 361.7 ms / p95 1117 ms。该 build 与当前运行/优化源码的映射 unknown，只作历史线索，不作当前热点或因果收益证明；没有记录/上传会话内容。

| 视角 | 候选 | 取舍 |
|---|---|---|
| 用户意图 | 打开新上下文时独立定位最新消息 | 实施 |
| 调用去重 | 复用 App 的 catalog 刷新 | 实施，不取消全局刷新 |
| 按需工作 | `/` 打开补全时才查命令 | 实施，首用补全仍有等待 |
| 生命周期 | 保留打开意图直到异步历史完成 | 实施 |
| 布局 | Markdown/图片变高后仍跟随 | 复用既有 ResizeObserver helper |
| 输入 | 上翻阅读时不抢滚动；问题选项仍可点击 | 真实鼠标/滚轮验收 |
| 数据量 | 进一步减少历史页负载 | 未改；已有每页 2 轮和字节边界，不能丢证据 |
| 并发 | 并行读取图片 | 未实施；缺少本次会话的图片瓶颈证据 |
| 缓存 | 最近会话本地缓存、修订失效 | 未实施；需要单独架构决策及真实复用收益证据 |
| 传输/执行 | 推送、长连接协议、worker | 未实施；先测真实端到端分段，不扩张本次修复 |

## 固定负载与对照

测量/验收夹具提交：`7df3e0f`，独立于优化代码。优化代码是包含本记录的提交，可用 `git log -- src/renderer/components/RemoteChat.tsx` 定位。

复用隔离 Electron fixture，临时 HOME/userData、sandbox、真实 React/CSS、原生鼠标和滚轮。两台远程会话交替打开 5 次；每次返回同一份 80 段历史，不启动真实 Provider，不改真实记录。另验收延迟返回、后续布局增高、上翻后不跳回、首次 slash 查询。

| 每次打开的工作 | 旧实现（5 次均相同） | 新实现（5 次均相同） |
|---|---:|---:|
| history 请求 | 1 | 1 |
| commands 请求 | 1 | 0 |
| catalog 请求 | 1 | 0 |

删除的是重复刷新和不必要的命令查询。没有把历史、授权或证据工作移出统计范围。全局 catalog 定时刷新保持原样；catalog 计数仅描述本次五个短窗口，不是整段使用期的网络总量。显式输入 `/` 后补全正常，查询 1 次；点击会话没有发送任何本机/远程 turn。

```sh
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs remote-session-opening-before -- node scripts/desktop-remote-ui-smoke.mjs --measure-session-opening
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs remote-session-opening-after -- node scripts/desktop-remote-ui-smoke.mjs --measure-session-opening
node scripts/desktop-remote-ui-smoke.mjs --session-opening-only
npm run performance:measure -- --scenario remote.trace.preview
```

旧/新首屏 fixture p50 分别 49.9 / 53.0 ms，1 分钟 load 为 19.71–19.81 / 16.99–17.79，机器 10 核，两次 `highLoad: true`。这些时间不可信，且桥接是离线 fixture，不代表 SSH/mac2 时延。L2 unavailable；未证明首屏变快。现有 remote.trace.preview 门禁通过（5 次，1 条 IPC / 2778 bytes），没有放宽门禁、缩小负载或新增 ratchet 指标。

## 回归与首次失败

- 旧生产实现的 focused fixture 在“打开后定位到最新消息”失败；新实现的 5 次打开、延迟历史、后续增高、上翻阅读、slash 按需查询通过。
- 开发中曾出现迟到 scroll 事件取消跟随，已修正；没有用 sleep、重试或扩大超时通过。
- 原通用测试要求原生鼠标必须命中 16px radio。贴底后坐标变化时，实际命中所属 label 并正常选择，但测试据此失败。改为点击产品的真实选项命中区 label，并新增 `radio.checked` 断言；继续检查目标命中、远端回答 UUID 和拒绝结果，没有跳过业务断言。完整远程 UI fixture 通过。
- 针对性 unit：18 通过；main 工作区 typecheck、build、focused opening UI 通过。另在 `7df3e0f + 仅本次生产补丁` 的干净隔离工作树中，typecheck、build、focused opening UI 全部通过，排除对其他 WIP 的依赖。
- `test:renderer:ui`：新增 opening 检查通过，随后原 session-capability fixture 报 `New session inherited the previous compaction count`，后续组合步骤未执行。未应用本次生产修复的对照工作树运行同一完整 fixture，复现同一错误；没有声称完整 UI gate 通过。
- 默认安装使用 Node 22.22.1，完整 unit 为 3466 通过 / 3 失败 / 4 按既有配置跳过。失败为 Pi direct transport 超时、Codex fixture 子进程 SIGABRT、source-control pre-push 超时；这些路径未被本次修改。调查 fixture 后，串行筛选这三项均通过（3 通过 / 54 因筛选未执行），不抵消首轮失败。未扩大超时或再次盲跑安装。

## 交付与升级条件

- 代码及测试已应用到主工作区，仅提交本次 diff，其他 WIP 保留；不 push。
- `install:mac:dev` 在 unit gate 停止，未执行安装替换。App 未自动停止、启动或重启。本次修改尚未在真实 mac2 会话生效/验收。
- 等并行任务/机器负载收敛后，重新执行完整安装；安装成功后由用户手动重启，重放打开 mac2 会话、上翻、再切换另一会话和 slash 补全。
- 若真实 mac2 仍慢，先补 history、图片传输与 renderer 首屏的端到端分段。只有测出主导成本后，再决定分页、并行图片或缓存；本次不预留这些能力。
