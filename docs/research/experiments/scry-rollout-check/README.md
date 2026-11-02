# scry-rollout-check

在本机临时目录里，对已安装的 Scry uploader 跑 20 个黑盒场景：故障、并发、积压、开关、崩溃、隐私、定时补传、hook 延迟、升级回滚、登录过期。另附 `record-check.mjs`，给真实 Provider 录制和真实上传出机器可判定的结论。两部分都可以整份交给 Agent 执行。

**不会碰真实环境**：每个场景都有独立的临时 `HOME`、`XDG_STATE_HOME`、`XDG_CONFIG_HOME` 和工作区；传输层换成本目录里的假实现，不联网；不调用 `register`、`scheduler-install`，不碰 launchd 和你真实的工作区。

## 准备：填协议映射（只需一次）

公开快照里，传输 CLI 的环境变量、工具名、身份字段都是别名。打开 `protocol.json`，对照私有 uploader 源码换成真实值：

| 字段 | 含义 | 在源码里找 |
| --- | --- | --- |
| `transportEnv` | uploader 读取传输 CLI 路径的环境变量 | `transport.ts` 的 `transportExecutable` |
| `toolName` | 上报用的 MCP 工具名 | `constants.ts` 的 `MCP_TOOL` |
| `argumentNames` / `recordsArgument` | 工具参数名（7 个，顺序不能变） | `transport.ts` 的 `ARGUMENT_ORDER` |
| `whoami.userIdField` / `nickField` | 身份查询返回的字段名 | `transport.ts` 的 `actorIdentity` |
| `response.*` | 上报响应的包装与条目状态名 | `uploader-worker.ts` 的 `validateReportResponse` |

## 运行

需要 Node ≥ 20、git。

```sh
# uploader 是 PATH 上的命令
node run.mjs --uploader scry-upload

# 或者直接指向安装包里的 CLI 入口
node run.mjs --uploader "$(npm root -g)/<uploader 包名>/dist/cli.js"

# S19（带积压升级 + 回滚探测）需要再给一个旧版本，否则记为 SKIP
node run.mjs --uploader scry-upload --old-uploader /path/to/<同事手上最老的版本>/dist/cli.js

# 只跑部分场景；保留临时目录便于排查
node run.mjs --uploader scry-upload --only S02,S10 --keep
```

全部跑完约 8 分钟（Linux 容器实测）。结束时打印汇总，并在当前目录写 `rollout-report-<时间>.json`。退出码：有 `FAIL` / `ERROR` 为 1，否则为 0。

## 结果含义

- `PASS`：符合预期。
- `SKIP`：缺少运行条件（S19 没给 `--old-uploader`），不算通过。
- `KNOWN`：命中已登记的已知问题（目前只有 S15 的两个脱敏缺口），不阻塞，但要跟踪修复。
- `FAIL`：行为不符合预期，推广前必须查清。
- `ERROR`：场景自身没跑起来，通常是 `protocol.json` 没填对，或 uploader 路径不对。

## 场景

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| S01 | 正常上传 5 条 | 5/5 上传，无死信 |
| S02 | HTTP 503 整体故障 25 秒后恢复 | 故障期请求 ≤ 15 次；恢复后全部上传；0 死信 |
| S03 | 无法识别的整体故障（"服务繁忙"）40 秒后恢复 | 故障期 0 条死信；恢复后全部上传 |
| S04 | 一条坏记录（413） | 其余 9 条全部上传，不被卡住 |
| S05 | 一条坏记录（无状态码的业务错误） | 其余 9 条全部上传 |
| S06 | 传输超时后恢复 | 恢复后全部上传，0 死信（超时退避约 60 秒起，耗时较长） |
| S07 | 服务端已写入但响应丢失 | 以同一身份重发，按 duplicated 收下 |
| S08 | 响应格式不对（持续 60 秒） | 60 秒内请求 ≤ 12 次，没有每秒重试 |
| S09 | 20 次 hook 同时触发 | 存活的 worker 进程 ≤ 2 |
| S10 | 5 个仓库各 8 条同时上传 | 40/40 上传；同时在途的上传 ≤ 2 |
| S11 | 关闭 → 提交 → 开启 → 手动放行 | 关闭期间记录不上传；开启后新记录上传；只放行指定那一条 |
| S12 | 被拒绝 → 死信 → redrive | redrive 后重新上传成功 |
| S13 | 自定义 `dataDir`（路径含空格） | 正常上传，不在 `.scry/upload` 写任何东西 |
| S14 | 上传中途杀掉 worker | 下次唤醒后全部上传 |
| S15 | 传输层 stderr 带凭证 | 状态文件、`flush`、`doctor` 输出里都不出现凭证 |
| S16 | 上传中途删除工作区 | 工作区不被重新创建，worker 退出 |
| S17 | 2 个已 `register` 的仓库在故障期积压，worker 被杀，只靠定时补传入口 `_recover`（禁止 hook 拉起 worker） | 恢复后 4 分钟内 8/8 上传 |
| S18 | 连续 20 次 `notify`（hook 路径）的耗时 | p95 ≤ 1500 ms，hook 不阻塞会话 |
| S20 | 登录过期时提交 2 条，再重新登录 | 记录留在本地、不进死信；状态里能看出是登录问题；冷却期内额外唤醒不反复请求；重新登录后 `flush` 立即上传 |
| S19 | 旧版本在故障期积压后升级到新版本，再用旧版本读一次 | 升级前后待上传、挂起、死信计数不变（需要时自动提示 `migrate`）；新版本恢复后全部上传；旧版本读取不损坏队列 |

## 已验证能抓到的缺陷

在旧版本上跑过，以下场景确实会失败：

| 场景 | 旧版本 | 旧版本上的结果 |
| --- | --- | --- |
| S04 | 0.2.0 | 其余 9 条 0/9 上传（队头阻塞） |
| S09 | 0.2.0 | 20 次 hook 留下 20 个 worker |
| S03 | 0.2.4 | 整体故障期间有正常记录被送进死信 |
| S15 | 0.2.5 | Bearer token 原样出现在 `doctor` 输出里 |
| S20 | 0.2.0 | 登录过期只显示 `actor failed`，看不出是登录问题 |

在 0.2.7 上：19 个 `PASS`（S17 约 32 秒排空；S18 p50 224 ms、p95 283 ms，Linux 容器测得，Mac 上以实测为准；S19 在 0.2.0→0.2.7、0.2.5→0.2.7 上均通过，但还没有在已知有缺陷的版本上验证过能报错），S15 为 `KNOWN`（多个 Cookie 键值对时后面的值、引号里带空格的值没有被完整脱敏）。

## record-check.mjs：真实录制与真实上传的判定

`run.mjs` 用的是合成记录和假传输层。真实 Provider 跑出来的记录、真实服务端的回执，由 `record-check.mjs` 判定。它只读本地证据（records、回执、status），不上传、不改记录、不读凭证。Provider 由执行的 Agent 驱动，每轮提示词里带一个唯一标记（如 `[rc-codex-tool-1a2b]`），脚本靠标记把记录和轮次对上。

```sh
# 跑轮次之前记下高水位
node record-check.mjs snapshot --workspace "$WS" > snap.json

# 跑完一个 Provider 的三轮后判定录制
node record-check.mjs turns --workspace "$WS" --since snap.json --provider codex \
  --expect tool:rc-codex-tool-1a2b,text:rc-codex-text-1a2b,interrupt:rc-codex-stop-1a2b \
  --file rollout-1a2b.txt --scry "$(command -v scry)" > turns-codex.json

# 判定上传：outbox 排空、0 死信、每条都有 uploaded 回执、repo 是 host/org/repo
node record-check.mjs upload --workspace "$WS" --turns turns-codex.json --uploader "$UPLOADER" --timeout 180

# 压测或日常期间定时采样，结束后出结论
node record-check.mjs observe --workspaces "$WS1,$WS2,$WS3" --uploader "$UPLOADER" --interval 60 --count 60 --out obs.jsonl
node record-check.mjs report obs.jsonl
```

`turns` 检查：新增记录数与轮次数一致、recordId 不重复、Provider 正确；证据诚实（`unavailable` 不带空列表、缺失的用量不写成 exact 0、`unavailable` 有原因）；工具轮有工具调用且文件足迹里有指定文件；纯文本轮是 `available + []` 或 `unavailable`；停止的轮次不是 `completed` 且有 `partial` 段。`--scry` 给出时再跑一次 `scry turns verify`。

`upload` 和 `observe` 的 `--uploader` 要指向 `cli.js`（`$(npm root -g)/<uploader 包名>/dist/cli.js`）：`repo` 格式检查调用同目录 `transport.js` 里 uploader 自己的 `repositoryName`，进程统计只认这个路径下的 worker。

结论：`PASS` 通过；`WARN` 测试本身不够干净（模型在纯文本轮仍调了工具、停止信号到达前轮次已结束），换提示词重跑；`UNAVAILABLE` 该 Provider 不提供这项证据，如实记录，不算通过也不算失败；`FAIL` 推广前必须查清。退出码：有 `FAIL` 为 1。

## 局限

- `run.mjs` 的记录是合成的，和 Provider hook 走同一条 `notify` 路径，但不验证真实录制；真实录制用 `record-check.mjs turns`。
- 假传输层只模拟协议，不能证明真实服务端的去重、限流和请求体大小上限；`record-check.mjs upload` 以回执里的 `inserted` / `duplicated` 为准，不独立查询服务端。
- S17 直接调用定时补传入口 `_recover`，不经过 launchd；launchd 本身的加载与触发在测试清单的 Agent 步骤里单独验证。
