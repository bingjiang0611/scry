# Scry CLI 与 uploader 推广前本地测试清单

最后更新：2026-11-02

## 目的与范围

整份清单交给一个 Agent 在一台 Mac 上执行，没有人工步骤：每一步都写成可以直接运行的命令和机器可判定的通过标准，Agent 跑完给出一份报告。全部通过（或已知问题均已接受）后，再按“试点 → 小组 → 全员”分批推广。被测对象是 Scry CLI（recorder）和 uploader 0.2.7 及以上；Provider 覆盖 Codex、Qoder、OpenCode、Pi，本轮不测 Claude；场景包括一个人同时在多个仓库里使用 Agent。

| 部分 | 怎么测 | 主要回答的问题 |
| --- | --- | --- |
| 上传可靠性（故障、并发、积压） | 自动化脚本，临时目录 + 假传输层 | 网络和服务出问题时会不会丢数据、卡队列、堆积进程 |
| 安装、init、各 Provider 录制 | Agent 驱动真实 Provider，`record-check.mjs` 判定 | 同事按文档装完，每种 Agent 的轮次能不能被正确记录 |
| 多仓库、开关、定时补传、升级 | Agent 在测试仓库和真实 launchd 上执行，脚本判定 | 真实使用节奏下状态是否一致、能否自我恢复 |
| 隐私与资源 | Agent 扫描文件和权限，采样脚本出结论 | 有没有凭证落盘、后台进程和磁盘是否有上限 |

本文不包含：Linux 部署（推广范围不含）、Claude（本轮不测）、服务端去重与网关限额（Agent 无法验证，列在放行条件里由服务方确认）。

## 测试前准备

下面这些是交给 Agent 之前机器上已经具备的状态，不是测试步骤。Agent 的第 0 步会逐条检查，任何一条不满足就停下报告，不自行登录、不自行授权。

- **传输 CLI 已登录**：SSO 登录需要人在浏览器里完成，Agent 做不了，也不应该代做。
- **四个 Provider 都已登录**：Codex、Qoder、OpenCode、Pi 在本机能正常跑一轮。
- **成本授权写进给 Agent 的指令里**：真实 Provider 轮次会产生费用。按本文的步骤，总量约 60 轮（每个 Provider 单仓库 3 轮、多仓库并发 15 轮、开关和补传约 10 轮、压测 30 轮），指令里写明上限，超出就停。
- **服务方已同意接收测试数据**：约定测试仓库的命名（例如 `scry-rollout-test/*`），便于事后在服务端清理。
- **Agent 在本仓库检出本分支**：脚本和本文都在 `docs/research/experiments/scry-rollout-check/`。开始前在 `protocol.json` 里填好真实协议映射（README 写了每项在源码哪里找；Agent 也可以对照私有源码自己填）。填好真实值的 `protocol.json` 只留在本地，不要提交回仓库。

通用判定：每一步看三样东西——命令退出码、`status --json` 的计数、`record-check.mjs` 的结论。只看命令没报错不算通过。脚本给出 `UNAVAILABLE` 表示这个 Provider 不提供该项证据，如实写进报告，既不算通过也不算失败；`WARN` 表示测试本身不够干净（例如模型在纯文本轮仍调用了工具），换提示词重跑一次。

## 自动化脚本

`scry-rollout-check/run.mjs` 在 0.2.7 快照上跑 20 个场景，结果 19 个 PASS、1 个 KNOWN（S15 的两个脱敏缺口），全程约 8 分钟（Linux 容器实测，Mac 上以实测为准）。它在临时目录里用独立的 `HOME`/`XDG_*` 和假传输层运行，不联网，不碰 launchd 和真实工作区，所以是 Agent 第一个要跑的部分。

1. 打开 `protocol.json`，对照私有 uploader 源码把传输环境变量、工具名、参数名、身份字段换成真实值（README 写了每项在源码哪里找）。
2. 运行 `node run.mjs --uploader <uploader 的 dist/cli.js> --old-uploader <最老版本的 dist/cli.js>`；不给 `--old-uploader` 时 S19 记为 `SKIP`。
3. 看汇总和生成的 `rollout-report-*.json`：任何 `FAIL` 或 `ERROR` 都要查清再推广；`ERROR` 多半是协议映射没填对。

| 编号 | 场景 | 通过标准 | 0.2.7 结果 |
| --- | --- | --- | --- |
| S01 | 正常上传 5 条 | 5/5 上传，无死信 | PASS |
| S02 | HTTP 503 整体故障 25 秒后恢复 | 故障期请求 ≤ 15 次；恢复后全部上传；0 死信 | PASS（3 次请求） |
| S03 | 无法识别的故障（“服务繁忙”）40 秒 | 故障期 0 死信；恢复后全部上传 | PASS |
| S04 | 一条坏记录（413） | 其余 9 条全部上传 | PASS |
| S05 | 一条坏记录（无状态码业务错误） | 其余 9 条全部上传 | PASS |
| S06 | 传输超时后恢复 | 恢复后全部上传，0 死信 | PASS |
| S07 | 服务端已写入但响应丢失 | 同一身份重发，按 duplicated 收下 | PASS |
| S08 | 响应格式不对（持续 60 秒） | 60 秒内请求 ≤ 12 次 | PASS（4 次） |
| S09 | 20 次 hook 同时触发 | 存活 worker ≤ 2 | PASS（1 个） |
| S10 | 5 个仓库各 8 条同时上传 | 40/40；同时在途 ≤ 2 | PASS（最多 2） |
| S11 | 关闭 → 提交 → 开启 → 手动放行 | 关闭期记录不上传；只放行指定那条 | PASS |
| S12 | 被拒绝 → 死信 → redrive | redrive 后重新上传 | PASS |
| S13 | 自定义 `dataDir`（含空格） | 正常上传，不写 `.scry/upload` | PASS |
| S14 | 上传中途杀掉 worker | 下次唤醒后全部上传 | PASS |
| S15 | 传输层 stderr 带凭证 | 状态文件、`flush`、`doctor` 输出里都没有凭证 | KNOWN |
| S16 | 上传中途删除工作区 | 不重建工作区，worker 退出 | PASS |
| S17 | 两个已登记仓库在故障期积压、worker 被杀，只靠定时补传入口 | 4 分钟内 8/8 上传 | PASS（33 秒） |
| S18 | 连续 20 次 hook 路径调用的耗时 | p95 ≤ 1500 ms | PASS（p95 289 ms，Linux 容器） |
| S19 | 旧版本积压后升级，再用旧版本读一次（需要 --old-uploader） | 计数不变；新版本全部上传；旧版本不损坏队列 | PASS（0.2.0→0.2.7、0.2.5→0.2.7） |
| S20 | 登录过期后提交，再重新登录 | 记录留在本地、不进死信；状态里能看出登录问题；重新登录后 flush 立即上传 | PASS |

脚本本身也验证过能抓到问题：S04、S09 在 0.2.0 上失败（队头阻塞、留下 20 个 worker），S20 在 0.2.0 上失败（登录过期只显示 `actor failed`），S03 在 0.2.4 上失败（正常记录进了死信），S15 在 0.2.5 上失败（Bearer token 泄露）。S17、S18、S19 还没有在已知有缺陷的版本上证明过能报错。记录是合成后经 `notify` 送入的，和 hook 走同一条 CLI 路径，但不验证真实 Provider 的录制，那部分在下面的 Agent 执行步骤里，由 `record-check.mjs` 判定。

## Agent 执行步骤

按顺序执行。每一步记录命令、退出码和 `record-check.mjs` 的 JSON 输出，最后汇总成报告。任何一步出现 `FAIL`：停在这一步，保留现场（不删测试目录、不靠重跑抹掉首次结果），写进报告；不修改 uploader 或 recorder 代码，不放宽判定标准。所有测试仓库都在 `$R` 下，不在正在开发的仓库里驱动 Provider。

```sh
K="$(git rev-parse --show-toplevel)/docs/research/experiments/scry-rollout-check"   # 在本仓库检出目录里执行
R="$HOME/scry-rollout-$(date +%Y%m%d-%H%M)"; mkdir -p "$R/before"
UP="$(npm root -g)/<uploader 包名>/dist/cli.js"   # 下文 scry-upload 均指 node "$UP"
TE=$(node -p "require('$K/protocol.json').transportEnv")
```

### 0. 前置检查与备份

- 记录版本：`scry version`、`node "$UP" --help | head -1`、`codex --version`、`qodercli --version`、`opencode --version`、`pi --version`、`sw_vers -productVersion`、`uname -m`、`node -v`，写在报告开头。
- 备份到 `$R/before/`：`scry-upload scheduler-status --json`、`launchctl print gui/$(id -u)/com.scry.uploader`（不存在也记下）、`~/.pi/agent/settings.json`、`ls ~/.pi/agent/extensions`、用户主工作区的 `scry-upload status --json`。第 9 步按这些恢复。
- Provider 登录：在 `$R/probe`（`git init` 的空仓库，不 init Scry）里用第 3 步表中的命令给每个 Provider 跑一句“只回答 ok” → 4 个都退出 0。任何一个失败就停。
- 跑合成场景：`node "$K/run.mjs" --uploader "$UP" --old-uploader <同事手上最老版本的 cli.js> --report "$R/rollout-report.json"` → 0 个 `FAIL` / `ERROR`，S15 为 `KNOWN` 可接受，S19 不能是 `SKIP`。

### 1. 搭测试仓库

```sh
mk() { mkdir -p "$R/$1" && git -C "$R/$1" init -q && git -C "$R/$1" commit -q --allow-empty -m init \
  && git -C "$R/$1" remote add origin "git@<代码托管域名>:$2/$3.git"; }
mk a scry-rollout-test rollout-a; mk b scry-rollout-test rollout-b; mk c scry-rollout-test rollout-c
mk same1 scry-rollout-test same; mk same2 scry-rollout-test-2 same   # 不同组织下的同名仓库
mk clash scry-rollout-test rollout-clash; mk fresh scry-rollout-test rollout-fresh
git -C "$R/a" worktree add -q "$R/a-wt"
```

remote 只用来生成仓库标识，永远不 push。

### 2. 全新安装与 init

- 全新安装：`npm install --prefix "$R/prefix" <scry 包>@<推广版本> <uploader 包>@<推广版本>`，只用 `$R/prefix/node_modules/.bin` 里的命令，逐字执行推广文档的安装与接入段落 → 不需要文档以外的命令；文档缺的步骤逐条写进报告。
- `cd "$R/a" && scry-upload init --providers codex,qoder,opencode --json` → 退出 0；`changedFiles` 里的文件都存在；记下 `codexTrustRequired`。
- 再执行一次 → 退出 0；`scry integrations diff --workspace "$R/a"` 退出 0（没有重复 hook）。
- 在 `$R/a/sub`（先 `mkdir`）里执行 init → 退出码非 0，提示到 Git 根目录执行。
- 在 clash 里先写入别人的 hook：`printf '{"schemaVersion":1,"commitHook":{"entry":"tools/other-hook","files":["tools/other-hook"]}}' > "$R/clash/scry.config.json"`，再执行 uploader init → 退出码非 0，`commitHook` 仍是 `tools/other-hook`。
- `scry integrations install-pi` → `scry integrations status-pi` 退出 0。Pi 扩展是用户级的，只在有 `scry.config.json` 的仓库里产生记录。
- `scry-upload doctor --workspace "$R/a" --json` → 退出 0，`healthy: true`。把 `checks.scry.value.version` 和 `scry version` 都写进报告：Pi 调用的是全局 `scry`，两者不一致要标出来。

### 3. 各 Provider 录制与上传

在 a 里按 Codex → Qoder → OpenCode → Pi 依次做，每个 Provider 三轮：一轮改文件、一轮纯文本、一轮中途停止。提示词里的标记用来把记录和轮次对上。

```sh
P=codex; N=$(openssl rand -hex 3)
node "$K/record-check.mjs" snapshot --workspace "$R/a" > "$R/snap-$P.json"
# 三轮提示词（命令见下表）：
#   [rc-$P-tool-$N] 在仓库根目录创建 rollout-$N.txt，内容是 ok，然后结束。
#   [rc-$P-text-$N] 只回答“好”，不要调用任何工具。
#   [rc-$P-stop-$N] 依次运行 sleep 5 共 12 次，每次之后说一句进度。
node "$K/record-check.mjs" turns --workspace "$R/a" --since "$R/snap-$P.json" --provider $P \
  --expect tool:rc-$P-tool-$N,text:rc-$P-text-$N,interrupt:rc-$P-stop-$N --file rollout-$N.txt \
  --scry "$(command -v scry)" > "$R/turns-$P.json"
node "$K/record-check.mjs" upload --workspace "$R/a" --turns "$R/turns-$P.json" --uploader "$UP" --timeout 180
scry status --workspace "$R/a"
```

| Provider | 非交互命令 | 说明 |
| --- | --- | --- |
| Codex | `codex exec --dangerously-bypass-hook-trust --full-auto "<提示词>"` | 不加 bypass 时项目 hook 不执行，表现为没有记录 |
| Qoder | `qodercli -p "<提示词>"` | 允许写文件的参数以 `qodercli --help` 为准 |
| OpenCode | `opencode run "<提示词>"` |  |
| Pi | `pi -p "<提示词>"` | 依赖第 2 步的 `install-pi` |

各 Provider 的权限参数以本机版本的 `--help` 为准，只允许在 `$R` 下的测试仓库里放开写权限。

中途停止的那一轮在 tmux 里跑：`tmux new -d -s rc-$P '<命令>'`，等到 `.scry/runtime/<provider>/` 下出现 `open.json`（或 20 秒）后 `tmux send-keys -t rc-$P C-c`。非交互模式下中断没有产生记录时，改为在 tmux 里启动交互模式、提交同一提示词后发送 Esc。两种都没有记录就是 `FAIL`，用 `scry doctor --workspace "$R/a"` 的 orphan 和 hook-skip 计数分清是 Provider 没发终态事件还是 recorder 没落盘。

通过标准：每个 Provider 的 `turns` 和 `upload` 都是 0 个 `FAIL`，`scry status` 退出 0。另外用 `/usr/bin/time -p` 记下纯文本轮的耗时，并在 `$R/probe` 里跑 3 次同样的提示词对比中位数：这个差值只记录，不做门禁（模型响应波动远大于 hook 开销），hook 开销的门禁是 S18。

### 4. 多仓库同时使用

- 在 b、c、same1、same2、a-wt 里执行 `scry-upload init --providers codex,qoder,opencode`。
- 后台采样：`node "$K/record-check.mjs" observe --workspaces "$R/a,$R/b,$R/c" --uploader "$UP" --interval 30 --count 60 --out "$R/obs-multi.jsonl" &`
- 三个仓库同时各跑 5 轮：a 用 Codex，b 用 OpenCode，c 里 Qoder 与 Pi 交替；三组并行启动，组内串行。每组先 `snapshot`，跑完后 `turns`（按实际的 tool / text 轮次写 `--expect`）和 `upload`，都是 0 个 `FAIL`。
- 采样结束后 `node "$K/record-check.mjs" report "$R/obs-multi.jsonl"` → 0 个 `FAIL`：同时存活的 worker 不超过 2 个，没有活过 5 分钟的 worker，结束时三个仓库积压为 0，死信始终为 0。
- 同名仓库：same1、same2 各跑 1 轮后分别 `upload` → 两边输出的 `repo` 不同。
- worktree：a 和 a-wt 同时各跑 1 轮 → 两边的 `turns` 各自是 1 条，都不含对方的标记。

### 5. 关闭、开启与放行

在 b 里用 Codex 的纯文本轮做（便宜）。

- `scry-upload disable --workspace "$R/b"` 后跑 2 轮 → `upload --expect-held true` 为 0 个 `FAIL`（两条回执都是 `skipped_disabled`）；`status --json` 的 `disabledHeld` 增加 2。
- `enable` 后再跑 1 轮 → 这一轮 `upload` 为 0 个 `FAIL`；关闭期间的两条仍是 `skipped_disabled`。
- `scry-upload flush --workspace "$R/b" --release-disabled <关闭期间第一条 recordId>` → 这一条变为 `uploaded`，另一条仍是 `skipped_disabled`。
- 新装仓库：在 fresh 里 init 后立刻跑 1 轮、再执行 `enable` → 这条回执是 `uploaded`，不是 `skipped_disabled`（0.2.6 修复项）。

### 6. 定时补传（真实 launchd）

- `scry-upload scheduler-install` → 退出 0；`scheduler-status --json` 的 `activation.state` 为 `loaded`；`plutil -extract StartInterval raw ~/Library/LaunchAgents/com.scry.uploader.plist` 为 `60`，`RunAtLoad` 为 `true`。
- 对 a、b、c 执行 `scry-upload register --workspace <仓库>` → `scheduler-status --json` 的 `workspaces` 含这三个。
- 只靠 launchd 清积压（代替断网和睡眠）：在 c 里用 `SCRY_UPLOADER_NO_SPAWN=1` 启动 Provider 跑 2 轮，hook 不再拉起 worker。先确认前提成立：`status --json` 的 `outboxPending + committedPending ≥ 1`，且没有 c 的 `_worker` 进程；不成立就把这一项记为 `UNAVAILABLE`（环境变量没传到 hook）。之后不调用 `wakeup` / `flush`、不再操作 Provider → 3 分钟内积压归 0，且 `launchctl print gui/$(id -u)/com.scry.uploader` 里的 `runs` 增加。
- 模拟重新登录 macOS：`launchctl bootout gui/$(id -u)/com.scry.uploader`，再 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scry.uploader.plist` → `scheduler-status` 回到 `loaded`，1 分钟内 `runs` 至少为 1（RunAtLoad）。
- 不执行：真实断网（会断开 Agent 自己和模型的连接）、合盖睡眠（会挂起 Agent，定时唤醒需要 root）。断网时的行为由 S02、S03、S06、S08 覆盖，补传逻辑由 S17 和上一条覆盖；“睡眠中错过的触发在唤醒后补跑”依赖 launchd 自身行为，作为残留风险写进报告。

### 7. 登录失效（不真的退出登录）

真的退出 SSO 之后需要人重新登录，所以只对一次手动 `flush` 换上“已过期”的假传输层。先在 c 里用 `SCRY_UPLOADER_NO_SPAWN=1` 跑 1 轮造出积压，然后立刻：

```sh
echo '{"loggedOut":true,"stderrSecret":"Authorization: Bearer rc-secret-0123456789abcdef"}' > "$R/logged-out.json"
env "$TE=$K/fake-transport.mjs" FAKE_CONTROL="$R/logged-out.json" FAKE_PROTOCOL="$K/protocol.json" \
  FAKE_LOG="$R/fake.log" node "$UP" flush --workspace "$R/c"
node "$UP" status --workspace "$R/c" --json
```

→ 记录留在本地（`outboxPending + committedPending` 不变），`deadLetterRecords` 为 0，`lastError` 或 `.scry/upload/health.json` 里能看出是登录问题。然后不带假传输层执行 `flush` → 对这一轮的 `upload` 为 0 个 `FAIL`（重新登录后可以马上手动上传，不必等 15 分钟冷却）。这一步留下的假凭证供下一节的隐私扫描使用。

### 8. 升级、卸载与回滚

- 带积压升级和回滚的队列兼容性由 S19 覆盖（第 0 步已用最老版本跑过）。
- 卸载只针对测试仓库和测试期间新装的东西：对 `$R` 下每个仓库执行 `scry-upload unregister --workspace <仓库>` 和 `scry integrations uninstall --yes --workspace <仓库>`；第 0 步备份显示测试前没有装过定时补传时，再 `launchctl bootout` 并删除 plist。
- 卸载后 → 没有这个 uploader 的 `_worker`、`_recover`、锁辅助进程（`observe --count 3` 即可）；在 a 里用 Codex 跑 1 轮纯文本 → Provider 退出 0，`.scry/records` 不再增加。
- Pi：没有专门的卸载命令。测试前没装 Pi 扩展时，用备份的 `settings.json` 还原并删除 `~/.pi/agent/extensions/scry-recorder.ts`，然后 `scry integrations status-pi` 应为非 0。

### 9. 收尾与报告

- 按第 0 步备份恢复 launchd、登记列表和 Pi 设置；主工作区的 `status --json` 与备份一致（死信数、`enqueuedThrough` 不变）。
- 报告写清：版本、每步命令与退出码、`record-check` 的 JSON、所有 `UNAVAILABLE` 和未执行项及原因、实际跑了多少轮。`$R` 保留，等维护者看完报告再删；服务端的测试数据按约定的仓库名由服务方清理。

## 隐私与安全检查

推广前必须让同事知道：上传的是完整的轮次记录，运行时不做正文脱敏（`REDACTION_VERSION` 为 `none`）。下面对推广文档的要求由 Agent 逐条核对文档里有没有写，其余是命令检查。

- [ ] 推广文档明确写出会上传什么：提示词、回复、工具入参和输出、文件路径、diff。`toolOutput: none` 只关闭工具正文，入参和路径仍会记录，diff 除非设 `diff: false` 也会记录
- [ ] 文档告诉同事哪些仓库不要启用（含密钥、客户数据的仓库），以及如何 `disable`
- [ ] 权限：`find "$R"/*/.scry/upload \( -type d ! -perm 700 \) -o \( -type f ! -perm 600 \)` 没有输出；`git -C "$R/a" check-ignore -q .scry` 退出 0（`.scry/` 不会被误提交）
- [ ] 凭证不落盘：第 7 步之后，`grep -rlF rc-secret-0123456789abcdef "$R"/*/.scry "${XDG_STATE_HOME:-$HOME/.local/state}" ~/Library/LaunchAgents` 和 `scry-upload doctor --workspace "$R/c" --json` 的输出都没有命中；`grep -rElI 'Bearer [A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.' "$R"/*/.scry/upload` 没有命中
- [ ] 服务端的数据保留期和访问权限：Agent 无法验证，由服务方确认（列在放行条件里），确认结果写进推广文档
- [ ] 仓库里的 hook、MCP、插件配置会自动执行（只校验指纹），推广文档提醒同事不要在不可信的仓库里启用

已知缺陷：诊断信息脱敏在两种写法下不完整，Cookie 头里第二个及之后的值、引号里带空格的值会残留。影响仅限本机报错输出（脚本 S15 标为 KNOWN），已列为源仓库下一轮必修项。

## 资源与稳定性观测

压测由 Agent 在第 4 步之后做：a、b、c 三个仓库并发再跑 30 轮（每个仓库 10 轮，四个 Provider 轮换），全程 `record-check.mjs observe --interval 60`，结束后用 `report` 出结论。下表是采样的指标和判定，任何一项超出预期就是推广阻塞项。试点期间可以用同一个脚本在同事机器上每小时采样一次，作为日常使用下的数据。

| 指标 | 怎么看 | 预期 |
| --- | --- | --- |
| 常驻 worker 进程 | `ps -axo pid,etime,%cpu,command \| grep -E '_worker\|_recover'` | 每个仓库最多 1 个；没有待办任务时为 0；没有运行超过 5 分钟的 |
| 锁辅助进程 | `ps -axo pid,etime,command \| grep lockf` | 空闲时为 0；不应持续累积 |
| CPU | `obs.jsonl` 里每个进程的 `%cpu` 列 | 空闲时接近 0；launchd 每 60 秒的补传检查不应持续占用 CPU |
| 待上传积压 | 各仓库 `status --json` 的 `outboxPending`、`committedPending` | 联网时一直接近 0，不持续上涨 |
| 死信 | `deadLetterRecords` | 正常使用中保持 0；出现就看 `dead-letter/` 里的 `reason` |
| 重试与冷却 | `retryingJobs`、`timeoutRecords`、`transportFailures`、`nextRetryAt` | 联网时归 0；有值时 `nextRetryAt` 在几分钟内 |
| 健康状态 | `.scry/upload/health.json` 的 `status` | `healthy`，或短暂的 `deferred`；不应长期停在 `error` |
| 磁盘 | `du -sh <仓库>/.scry` | 随轮次增长是正常的；已上传满 30 天的副本会被清理，记下增长速度用来估算 |
| Agent 体感 | S18 的 hook 路径耗时；第 3 步记录的纯文本轮耗时对比 | S18 p95 ≤ 1500 ms；对比差值只记录，不做门禁 |

## 放行条件与分批推广

下面 6 条全部满足才开始推广：

- [ ] 脚本用真实协议映射、在推广版本上跑完，0 个 `FAIL` / `ERROR`
- [ ] Agent 执行步骤 0–9 全部完成且 0 个 `FAIL`；所有 `UNAVAILABLE` 和未执行项都写进报告并被接受；推广文档已补上第 2 步发现的缺口
- [ ] 压测的 `report` 0 个 `FAIL`：没有进程堆积、结束时没有积压、死信为 0
- [ ] 隐私项全部确认，推广文档写清上传内容、不宜启用的仓库和关闭方法
- [ ] 服务方确认：按 `recordId` 去重、单次请求体大小上限、限流规则、数据保留期
- [ ] S19 在最老版本上通过，第 8 步卸载后没有残留进程和任务

| 已知问题 | 影响 | 处理 |
| --- | --- | --- |
| 诊断信息脱敏不完整（多个 Cookie、带空格的引号值） | 本机报错输出可能残留部分凭证 | 源仓库下一轮必修；修复前可以推广，但要在推广文档里说明 |
| 关闭期间的轮次开启后不自动补传 | 这段时间的数据留在本地 | 设计如此；文档告诉同事用 `flush --release-disabled` 逐条放行 |
| 鉴权失败后冷却 15 分钟 | 重新登录后不会立即上传 | 文档告诉同事重新登录后可以手动 `flush` |
| Pi 不走 `init` | 需要 `scry integrations install-pi`，是用户级扩展，没有卸载命令 | 已纳入本轮测试；推广文档单写 Pi 的接入和手动卸载 |
| 服务端去重、请求体上限未实测 | 大轮次或重发时行为未知 | 列入放行条件，向服务方确认 |
| 真实断网和合盖睡眠没有实测 | 睡眠中错过的补传是否在唤醒后立即补跑，只依赖 launchd 自身行为 | 会中断 Agent 自己，由合成场景和 launchd 补传步骤代替；试点期间看同事机器上的采样数据 |

分批推广：

1. 试点：2–3 位愿意反馈的同事，覆盖 Apple Silicon 和 Intel，至少两种 Provider，跑 1 周。每天收一次各自的 `status --json`，重点看积压和死信。
2. 小组：约 10 人，1 周。试点期间发现的问题修完、脚本重新跑过再进入这一批。
3. 全员：发布推广文档和卸载说明，指定一个反馈渠道。任何一批出现死信增长或进程堆积，就停在当前批次先修。
