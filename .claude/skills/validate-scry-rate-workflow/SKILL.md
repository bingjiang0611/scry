---
name: validate-scry-rate-workflow
description: 对 rate-native 的 Claude Code、Codex、Qoder、OpenCode 或 Pi 执行真实 Scry 验收。默认 draft profile 只把第一条契约消息放入 composer；用户明确要求发送、三轮或“写完技术方案后停下”时切换 three-turn profile，逐轮等待 terminal，最终严格核对 Scry archive、workspace records 与 CLI overview。复用 Provider 固定 treehouse、冻结 recorder/源码/构建/Profile 身份并保留现场供复盘。用于单 Provider 或多 Provider 并行验收。
---

# 验证 Scry rate-workflow

在每个 Provider 专属、长期租用的预热 `rate-native` treehouse 中，按显式 profile 验收 Scry 与 rate-workflow；两个 profile 都不修改业务代码。

判据由脚本 fail closed 地强制执行，本文件只给命令顺序、授权边界和停手条件；字段级判据见 [验收契约](references/acceptance-contract.md)，异常处置见 [恢复与保留规则](references/recovery.md)。所有固定 ID、槽位映射、提示词、权限值和清场 allowlist 只从 [contract.json](references/contract.json) 取，不在运行中另造一份。脚本报错即为权威原因，不要用界面观感或截图覆盖它，也不要绕过脚本手写等价逻辑。

## 验收模式

- `draft`（默认）：只把第一条契约消息精确放入 composer 并停住，不发送、不产生会话。执行本文 Step 0-6。
- `three-turn`：仅当用户明确要求“发送”“三轮”“第一轮结束后继续”或“写完技术方案后停下”时启用。Step 0-3 与本文相同，Step 4 起改为完整执行 [严格三轮与一致性核查](references/three-turn-workflow.md)；不得再执行 draft 的 `record-draft` 或 `RETAINED_DRAFT` 分支。

profile 一旦为某个 `run_root` 进入第一条消息阶段就冻结：`turn1-draft.json` 与 `turn1-send-intent.json` 互斥。任何人不得把保留草稿继续发送，也不得把已形成 send intent 的运行降级成草稿。

## Provider lane 编排

直接在当前会话执行时按本文 Step 推进；使用 Subagent 时，Step 0 前以 `provider + pending` 标识 lane，由首个 worker 创建 `run_root`；落盘后 `provider + run_root` 成为唯一 lane key。必须遵守：

- 同一 lane 同时只有一个 worker；跨 Provider 可并行，但每个 Provider 仍各自单 worker。禁止为同一 `provider/run_root` fan-out 相似任务或反复从父会话 fork 全量历史。
- 首次 worker 使用 fresh context，只接收本 skill 路径、`provider`、profile 与必要用户输入，并负责创建 `run_root`。运行中纠偏用 `steer`，完成或暂停后携带紧凑 handoff 继续用同一 worker 的 `resume`；不要另起替代 worker。
- 每次暂停或 worker 交回时都输出同一个 handoff 合同：`provider`、`run_root`、当前 `lifecycle`、最后通过的证据文件、下一条精确 Step/命令、阻塞决定。`run_root` 内的权威文件优先于继承对话。
- 只有原 worker 明确不可恢复时才能启动一个 replacement；replacement 仍用 fresh context，必须收到上述 handoff 和替换原因，且启动前确认旧 worker 已终止。不得让两个 writer 共同拥有同一 lane。

## 边界

- 必填 `provider`：`claude`、`codex`、`qoder`、`opencode`、`pi`。用户未指定时先问，禁止自选。
- **Agent 永不克隆 Aone**（详见末尾红线 1、2）。用户要求执行只授权把契约固定的第一条消息放进输入框；未拿到用户给的新需求纯数字 ID 或 canonical URL 前不得继续。
- 本 skill 只验收和诊断（红线 13）；源码提交、recorder 版本或构建产物一变，本次运行即失效，必须新跑。
- 自动恢复仅限契约 allowlist：四个 hook 型 Provider 的 `settings.local.json` env key、`.mcp.json` 模板、Pi 的 tracked `.pi/settings.json`、缺失/错 origin/clean-stale 子仓、按 tracked lockfile 物化 `node_modules`、`init.sh`、固定池陈旧 worktree 注册项；逐项边界见 [恢复与保留规则](references/recovery.md)。
- Scry 源码的本地未提交改动只作身份证据，不作闸门，也不进入构建产物：验收以最新 commit 为准；唯一例外是 registry 缺 recorder 精确版本、必须 publish 时仍要求干净 release input（发包不可逆）。
- Provider ↔ 槽位一对一：Codex=`1`、Claude Code=`2`、Qoder=`3`、OpenCode=`4`、Pi=`5`。Pi 必须同时回读 `agentProfileId=pi:default`，且 MCP 门禁为 `not_applicable`；同 Provider 串行，跨 Provider 可并发。`environment` 与 `build` 共享锁互斥，正常验收不取 `browser` 锁。每条退出路径都释放本次持有的共享锁。
- 固定槽位跨运行保留 lease，不做 `treehouse return`。**草稿记录一旦落盘就按保留处理**：保留 Scry Test、隔离 userData、workspace 数据和槽位锁，直到用户显式清理；草稿记录未落盘则走 `PRE_SEND_ARCHIVED` 自动归档并释放槽位。`run_root` 永不删除。
- Step 0 不得追溯清理别人的现场：只接管 inactive owner/lifecycle 或 prepared journal 明确交出的事务；“无草稿记录”不等于 abandoned。
- 停止边界由 profile 决定：draft 停在第一条消息入框；three-turn 依次发送三条契约消息，只在每轮 terminal 后推进，并在第三轮写完技术方案后停止。两者都不改业务代码。
- Computer Use 白名单只有三项：只读观察、确认 Hook 信任与 MCP 执行授权、只读确认 `Scry Test` 输入框内容。启动、workspace/Provider 选择、权限落盘与 ownership 取证只能由契约脚本产出；其余弹窗一律停手报告。

## 变量与执行约定

每个代码块首行都是 `set -euo pipefail`，且必须整块执行：任一 `test` / `jq -er` 失败即为该 Step 失败，不得凭块内最后一条命令的退出码判定通过，也不得让空变量流进后续命令。本 skill 天然横跨多个 turn 和 shell（Step 1 硬暂停），**每个新 turn、新 shell 都先跑这段重建，不新建目录**：

```bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
skill_dir=/Users/baobingjiang/IdeaProjects/vibecoding/scry/.claude/skills/validate-scry-rate-workflow
run_root="<上一 turn 最终回复里原样打印的绝对路径>"
test -d "$run_root"
test "$(jq -er '.state' "$run_root/environment-prepared.json")" = "FROZEN_READY"
provider="$(jq -er '.provider' "$run_root/environment-prepared.json")"
baseline_preflight="$(jq -er '.baselinePreflight' "$run_root/environment-prepared.json")"
scry_bin="$(jq -er '.scryBin' "$run_root/environment-prepared.json")"
build_out="$(jq -er '.buildOut' "$run_root/environment-prepared.json")"
test "$(jq -er '.ok' "$baseline_preflight")" = "true" && test -x "$scry_bin"
# 以下两行按已到达的阶段自动跳过；跳过不算失败，但文件存在就必须解析成功
if [ -f "$run_root/workitem-id.txt" ]; then workitem_id="$(cat "$run_root/workitem-id.txt")"; fi
if [ -f "$run_root/fixed-workspace.json" ]; then workspace="$(jq -er '.workspace' "$run_root/fixed-workspace.json")"; fi
```

`provider` 从 `environment-prepared.json` 回读，不靠记忆；**每个 turn 的最终回复都必须独立成行打印 `run_root=<绝对路径>`**，不只 CHECKPOINT 1。若该行丢失，**不得自己挑一个**：列出候选连同 provider/lifecycle 交用户指定——`run_parent="$(jq -er '.retention.runRootParent' "$skill_dir/references/contract.json")"`，再对 `ls -1dt "$run_parent"/validate-scry-rate-workflow-*` 的每一项打印 `environment-prepared.json` 的 `.provider` 与 `lifecycle.json` 的 `.state`。环境未冻结时 `.baselinePreflight`、`.scryBin`、`.buildOut` 都是 `null`，`jq -er` 会失败——这就是要的 fail closed，不得换成 `jq -r` 让空串流下去。`build_out` 更不能省：漏传会让 `preflight.py` 静默落回 canonical `scry/out`，把运行身份换成另一份构建。

**非零退出分两类**：Step 0-4 的预检/启动/消息闸门非零即停手；`fixed_workspace.py status`（`ok=all(mappingReady)`，池未 lease 就为 false）、`lease-all`（ok 覆盖全部五个槽位）、`check_mcp_execution_prereq.py`、Step 5 的 `preflight.py`、`finalize_pre_send.py`、`scry doctor|turns verify` 非零只是**判定结论**（`ok=false` / 不健康），JSON 已落盘，必须接住退出码读文件继续分流，不得当成执行故障就地停手。所有代码块以 **bash** 执行（macOS 自带 3.2 即可，未使用 4+ 语法）。

## 0. 冻结版本与运行身份

```bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
skill_dir=/Users/baobingjiang/IdeaProjects/vibecoding/scry/.claude/skills/validate-scry-rate-workflow
provider="<claude|codex|qoder|opencode|pi>"
run_parent="$(jq -er '.retention.runRootParent' "$skill_dir/references/contract.json")"
install -d -m 700 "$run_parent"
run_root="$(mktemp -d "$run_parent/validate-scry-rate-workflow-XXXXXX")"
chmod 700 "$run_root"
node "$skill_dir/scripts/capture_permission.mjs" self-test
python3 "$skill_dir/scripts/prepare_environment.py" \
  --provider "$provider" --run-root "$run_root" \
  > "$run_root/prepare-environment-result.json"
test "$(jq -er '.state' "$run_root/environment-prepared.json")" = "FROZEN_READY"
test "$(jq -er '.status' "$run_root/environment-recovery.json")" = "FROZEN_READY"
baseline_preflight="$(jq -er '.baselinePreflight' "$run_root/environment-prepared.json")"
scry_bin="$(jq -er '.scryBin' "$run_root/environment-prepared.json")"
build_out="$(jq -er '.buildOut' "$run_root/environment-prepared.json")"
test "$(jq -er '.ok' "$baseline_preflight")" = "true" && test -x "$scry_bin"
# status 在池未 lease 时以 ok=false 退出，这是探测结论不是故障：接住退出码再读文件
python3 "$skill_dir/scripts/fixed_workspace.py" status --provider "$provider" \
  > "$run_root/slot-status.json" || true
test -s "$run_root/slot-status.json"
slot_class="$(jq -r --arg p "$provider" \
  '.mappings[]|select(.provider==$p)|.slotLifecycle.classification' "$run_root/slot-status.json")"
test "$slot_class" = "null" || { echo "slot occupied: $slot_class"; exit 1; }
# CHECKPOINT 1 需要的三项一律由脚本产出，不靠记忆
jq -er '.sourceWorkitem.url' "$skill_dir/references/contract.json"
printf 'run_root=%s\nprovider=%s\n' "$run_root" "$provider"
```

`prepare_environment.py` 是唯一的环境事务入口：它自己按顺序取/放 `environment`、`build` 锁，扫描五个 Provider 锁，做有界恢复（recorder 版本与 registry、四个 hook 型 Provider settings、tracked Pi settings、Scry 依赖），冻结契约/源码/版本/构建指纹，必要时在本 run 的 `scry-build-out` 里隔离构建。禁止把 `claim-shared → 裸命令 → release-shared` 手写成多进程序列。

- `RECOVERING_ENVIRONMENT`、`needsBuild=true`、`needsInit=true`、`repair_required` 都是正常中间态，不得上报成 `BLOCKED`。
- **Scry 源码有本地未提交改动不阻塞，也不影响构建与测试**：验收以最新 commit 为准。preflight 把 `git.scry` 的 `head/treeHash/dirty/worktreeHash` 冻结成本次运行身份并在报告里披露 dirty，但构建身份与缓存判定只用 `head/treeHash`；隔离构建在干净 HEAD 快照（`run_root/scry-build-src`：git archive + 逐文件 blob 校验 + 复用主仓 `node_modules` 符号链接）上进行，工作区改动不会进入构建产物，构建期间工作区漂移只作披露、不再作废。不要要求用户先 commit/stash，也不得代他 commit、stash 或 `git clean`。只有源码身份不可证（非 Git 仓库、`git` 失败）才失败。
- 只有 `environment-recovery.json.status` 与 `environment-prepared.json.state` 都是 `FROZEN_READY`、且 baseline preflight `ok == true` 才继续；两次不收敛的 `RECOVERY_FAILED` 或 `RECOVERY_NOT_APPLICABLE` 按真实失败项分类。
- 后续验收命令用冻结的绝对 `$scry_bin`，PATH 里其他 `scry` 只作 audit；**清理/归档路径例外**：`sanitize_workspace.py`、`finalize_pre_send.py` 与 `recover_cleanup_cli` 统一解析当前 stable prefix 下最新安装的 recorder CLI 操作，冻结版本只作身份披露，recorder 升级不阻塞旧现场清理（身份边界仍在：必须位于该 prefix 的同名 package root 且可执行）。
- `slot_class` 打印为字符串 `null`（即无 slotLock）才是可继续的空槽位；`.mappings[].treehouse` 为 `null` 只说明池尚未 lease，不是槽位被占用，留给 Step 2 自愈；非空 `slotLock` 一律不得强删：`WAITING_FOR_REVIEW_CLEANUP`、`WAITING_FOR_DRAFT_CLEANUP`、`WAITING_FOR_ABANDONED_CLEANUP`、`WAITING_FOR_LEGACY_CLEANUP`、`WAITING_FOR_ACTIVE_REVIEW_FINALIZATION`、`PRE_SEND_ACTIVE` 都要求停手报告并等用户清理。`PRE_SEND_RECOVERY_REQUIRED` 已由 Step 0 的 `prepare_environment.py` 在 environment 锁内自动调同一 finalizer 归档旧 run 并释放槽位（证据在 `environment-recovery.json` 的对应 action），Agent 不得手动拿别的 `run_root` 去调 Step 5 分流器——Step 5 只作用于本次 `$run_root`。

## 1. 到 Aone 克隆点交给用户并硬暂停

Step 0 通过、共享锁已释放后才进入人工接管；此时还没做 `lease-all`、Provider `claim`、before 清场或启动测试 App。

🛑 **CHECKPOINT 1 · 必须结束 turn**：没有用户给的新需求 ID，且用户未明确选择 `--local-equality-only` 时，只允许做一件事：用最终回复输出 `WAITING_FOR_USER_CLONE`、contract 里的固定源需求 URL，以及独立成行、可逐字复制的 `run_root=<绝对路径>` 和 `provider=<id>`，请用户手工克隆一次并回新详情页 canonical URL 或纯数字 ID，然后**立即结束当前 turn**——不得再调用任何工具。该状态不是 PASS/FAIL/BLOCKED，且不持有任何共享锁或 Provider 锁，也没有运行中的测试 App。

用户回复后：

- 先跑「变量与执行约定」那段重建（`run_root` 从上一 turn 的回复逐字粘回），不新建目录。
- 只接受纯数字 ID，或 project 精确为 `952011`、路径为 `/req/<纯数字>` 的 canonical URL；归一化出的 `workitem_id` 不得等于 `85076624`。
- 归一化后立刻落盘，后续所有 turn 只从该文件回读，不从对话历史重抄：
  ```bash
  set -euo pipefail
  workitem_id="<用户回传并归一化出的纯数字 ID>"
  printf '%s' "$workitem_id" > "$run_root/workitem-id.txt"
  chmod 600 "$run_root/workitem-id.txt"
  test "$workitem_id" != "85076624"
  ```
- 用户只说“完成”而没给 ID/URL：只索要 ID/URL 并再次停止。用户取消或克隆失败：报告取消并停止，保留 Step 0 证据。
- `--local-equality-only` 需要两个条件**同时**成立：用户明确把范围收窄为“只验收草稿入框本身”，且手工克隆被外部网络阻塞或用户决定不给新 ID（等待用户回复不算阻塞）。只满足其一时回去让用户二选一，不得自行降级。该 profile 跳过人工克隆、草稿用固定源 ID，且必须把固定源 ID 落成同一个文件（后续 turn 与 Step 4 都从这里读）：
  ```bash
  set -euo pipefail
  jq -er '.sourceWorkitem.id' "$skill_dir/references/contract.json" \
    > "$run_root/workitem-id.txt"
  chmod 600 "$run_root/workitem-id.txt"
  ```

两个继续分支都必须先重新预检，确认暂停期间环境没坏：

```bash
set -euo pipefail
python3 "$skill_dir/scripts/preflight.py" --provider "$provider" \
  --build-out "$build_out" --output "$run_root/preflight-after-handoff.json"
test "$(jq -er '.ok' "$run_root/preflight-after-handoff.json")" = "true"
```

`ok != true` 就不得继续：保留旧 `run_root`，用新 `run_root` 从 Step 0 重跑，并复用用户已给的 `workitem_id`，不要求重复克隆。人工克隆的证据只有用户回传 + 后续只读核验 + 草稿的精确 prompt；Aone 详情不暴露来源字段时报告写 `cloneProvenance=user_attested`。

## 2. 取得固定预热 treehouse

```bash
set -euo pipefail
python3 "$skill_dir/scripts/fixed_workspace.py" status --provider "$provider" \
  > "$run_root/slot-status.json" || true
if [ "$(jq -r --arg p "$provider" '.mappings[]|select(.provider==$p)|.treehouse' \
     "$run_root/slot-status.json")" = "null" ]; then
  python3 "$skill_dir/scripts/fixed_workspace.py" lease-all > "$run_root/lease-all.json" || true
  python3 "$skill_dir/scripts/fixed_workspace.py" status --provider "$provider" \
    > "$run_root/slot-status-after-lease.json" || true
  # 只有本 provider 的 mappingReady 才是本次判据；其他槽位不 ready 只进报告
  test "$(jq -r --arg p "$provider" '.mappings[]|select(.provider==$p)|.mappingReady' \
    "$run_root/slot-status-after-lease.json")" = "true"
fi
python3 "$skill_dir/scripts/fixed_workspace.py" claim --provider "$provider" --run-root "$run_root"
python3 "$skill_dir/scripts/sanitize_workspace.py" \
  --provider "$provider" --run-root "$run_root" --phase before --scry-bin "$scry_bin" \
  > "$run_root/workspace-cleanup-before-result.json"
expected_head="$(jq -er '.git.rateNative.head' "$baseline_preflight")"
python3 "$skill_dir/scripts/fixed_workspace.py" prepare \
  --provider "$provider" --run-root "$run_root" --expected-head "$expected_head" \
  > "$run_root/fixed-workspace.json"
workspace="$(jq -er '.workspace' "$run_root/fixed-workspace.json")"
python3 "$skill_dir/scripts/fixed_workspace.py" bootstrap-status --provider "$provider" \
  --preflight "$baseline_preflight" > "$run_root/bootstrap-status.json"
python3 "$skill_dir/scripts/fixed_workspace.py" reconcile-bootstrap \
  --provider "$provider" --run-root "$run_root" \
  --preflight "$baseline_preflight" --scry-bin "$scry_bin" \
  > "$run_root/bootstrap-recovery.json"
python3 "$skill_dir/scripts/check_mcp_execution_prereq.py" \
  --provider "$provider" --workspace "$workspace" \
  --output "$run_root/mcp-execution-prereq.json"
test "$(jq -er '.ok' "$run_root/mcp-execution-prereq.json")" = "true"
doctor_rc=0; "$scry_bin" doctor --workspace "$workspace" \
  > "$run_root/scry-doctor.json" || doctor_rc=$?
verify_rc=0; "$scry_bin" turns verify --workspace "$workspace" \
  > "$run_root/turns-verify-before.txt" || verify_rc=$?
test "$doctor_rc" = 0 && test "$verify_rc" = 0
# 旧任务状态不得在 before 清场后重现；两个开关不得被设成 0
for rel in .claude/current-task.txt .claude/current-task-lease.json .claude/current-task-session.txt; do
  test ! -s "$workspace/$rel"
done
test ! -e "$workspace/.scry-disabled"
settings_files=()
while IFS= read -r rel; do settings_files+=("$workspace/$rel"); done \
  < <(jq -r '.recoveryPolicy.config.managedTargets[]' "$skill_dir/references/contract.json")
test "${#settings_files[@]}" -gt 0
for f in "${settings_files[@]}"; do test -f "$f"; done
# grep 三态：0=命中被关的开关(失败) 1=未命中(通过) 2=grep 自身出错(必须失败)
grep_rc=0
grep -qE '"SCRY_(RECORDER|TURN_UPLOAD)_ENABLED"[[:space:]]*:[[:space:]]*"?(0|false)"?' \
  "${settings_files[@]}" || grep_rc=$?
test "$grep_rc" = 1
```

`before` 清场只归档不删除；`reconcile-bootstrap` 可无条件调用，ready 时幂等返回。workspace 洁净度不用手工看：`prepare` 已用 `git status --porcelain=v1 --untracked-files=all` 硬校验并 reset 到 `$expected_head`。最后三组断言只管旧任务状态与开关，任一失败就停手。

`.mappings[].treehouse` 为 `null`（预热池被外部删除）时自动跑 `lease-all`，不要停手问用户：它会在 allowlist 内自愈陈旧 Git worktree 注册表，prune 判据与恢复预算见 [恢复与保留规则](references/recovery.md)，证据在 `lease-all.json` 的 `actions[].detail`。首次启用或用户显式要求修复固定池时也可直接跑一次（已 leased 返回 `already-leased`，幂等）。重建后是冷预热，`init.sh` 会明显变慢，不要因此中断。只有 prune 被 fail closed 拒绝、或重建后 `mappingReady` 仍为 false 才判 `BLOCKED`。

🔴 MCP 预检 `ok != true` 判 `BLOCKED` 停手：脚本本身就以非零退出，上面的 `test` 只是冗余复核。按 `violations` 报服务名/scope/源文件/规则（规则含义见 [恢复与保留规则](references/recovery.md) 的 MCP 执行语义冲突一节，处置边界见红线 7）。项目级凭据引用只有在 `contract.json` 的 `mcpExecutionPolicy.credentialScopeExceptions` 明确列出该 server/rule，且对应 Provider 的项目本地 `settings.local.json` 已含同名 env key 时，才被视作本机 seed 恢复出的受控凭据引用，不算冲突。它不是完整 trust-engine 副本，`agent:start` 的 guard 才是最终权威，晚失败要保留其结构化原因。`doctor` 或 `turns verify` 非零退出同样停手，走 Step 5 分流器。

放入草稿前还要解决 Aone 只读读取（`a1` CLI）与 Provider 登录（登录若占用模型回合，本次运行作废）。然后在 workspace 内做只读需求核验（`--local-equality-only` 时 `workitem_id=85076624`）：

```bash
set -euo pipefail
cd "$workspace"
intake=.claude/skills/rate-workflow/scripts/source_intake.py
test -f "$intake"
python3 "$intake" aone-metadata --workitem-id "$workitem_id" \
  > "$run_root/workitem-detail.json"
# ID / project / 完整标题 / 固定钉钉文档 URL 四项全作字段断言，不靠肉眼核对
jq -e --arg id "$workitem_id" \
  --arg proj "$(jq -er '.sourceWorkitem.projectId' "$skill_dir/references/contract.json")" \
  --arg title "$(jq -er '.document.title' "$skill_dir/references/contract.json")" \
  --arg doc "$(jq -er '.document.url' "$skill_dir/references/contract.json")" \
  '.ok==true
   and (.id|tostring)==$id
   and .projectId==$proj
   and (.url|endswith("/project/"+$proj+"/req/"+$id))
   and (.title|endswith($title))
   and (.linkedUrls|index($doc)!=null)' "$run_root/workitem-detail.json" > /dev/null
# 暴露了克隆来源就必须等于固定源 ID；空数组（未暴露）时 all(...) 为真 = user_attested
jq -e --arg s "$(jq -er '.sourceWorkitem.id' "$skill_dir/references/contract.json")" \
  '.sourceWorkitemIds|unique|all(.==$s)' "$run_root/workitem-detail.json" > /dev/null
```

Aone 只读核验只走 rate-workflow P0 的受信 `source_intake.py aone-metadata` 固定入口（旧的 `coop` MCP 已永久下线，也不得由 Agent 直接执行 `a1`、页面读取或其他查询方式）：脚本缺失、未登录、非零退出或任一 `jq` 断言不命中都判 `BLOCKED` 走 Step 5 分流器，不自行克隆。标题用 `endswith` 而不是全等，因为 Aone 克隆会加 `[克隆] ` 前缀，其余部分必须逐字等于契约 `document.title`；`--local-equality-only` 时 `$workitem_id=85076624`，标题恰好完全相等。`sourceWorkitemIds[]` 有值时要求每个值都等于 `85076624`，未暴露即 `cloneProvenance=user_attested`。草稿不发送消息，固定钉钉文档正文无需预取。

## 3. 启动隔离 Scry Test 并落盘权限

```bash
set -euo pipefail
scry_repo="$(cd "$skill_dir/../../.." && pwd)/scry"
python3 "$skill_dir/scripts/preflight.py" --provider "$provider" \
  --rate-native-repo "$workspace" --build-out "$build_out" \
  --output "$run_root/preflight-post-build.json"
test "$(jq -er '.ok' "$run_root/preflight-post-build.json")" = "true"
python3 "$skill_dir/scripts/fixed_workspace.py" start-test-app \
  --run-root "$run_root" --provider "$provider" \
  --scry-repo "$scry_repo" \
  --build-out "$build_out" --workspace "$workspace"
node "$skill_dir/scripts/test_scry_app.mjs" status --run-root "$run_root" \
  > "$run_root/test-scry-status.json"
jq -e --arg rr "$run_root" '
  .mode=="test" and .testAppLabel=="Scry Test" and .status=="running"
  and .processAlive and .commandMatches and .cdpReachable and .cdpReady==true
  and .cdpClosed==false and .ownedRendererReady and .ownedRendererCount==1
  and .runtimeSnapshotReady and .windowTitleLabeled
  and .rendererOwnership.status=="verified" and .rendererOwnershipLive.status=="verified"
  and (.statePath|startswith($rr)) and (.userDataDir|startswith($rr))
' "$run_root/test-scry-status.json" > /dev/null
node "$skill_dir/scripts/capture_permission.mjs" capture \
  --run-root "$run_root" --workspace "$workspace" --provider "$provider"
```

`fixed_workspace.py start-test-app` 是唯一公开启动入口（直接跑 Node `start` 会 fail closed）：它在 lifecycle gate 内校验 Provider/repo/workspace/槽位身份与 `ownerStage=BOOTSTRAP_READY`，把冻结 `out/` 复制成本 run 的 `scry-runtime` 快照，再启动 `version=3` 测试 App。

- `status` 退出码不构成健康证明，必须跑上面那条 `jq -e`。`mode/testAppLabel/status/statePath/userDataDir` 是启动时写入 state 的**静态身份字段**，只用于身份比对；live 探测是 `processAlive/commandMatches/cdpReachable/cdpReady/cdpClosed/ownedRendererReady/ownedRendererCount/windowTitleLabeled/rendererOwnershipLive/runtimeSnapshotReady`。`runtimeSnapshotReady=true` 已内含“源 `out/` ↔ `scry-runtime/out` ↔ 实时快照三方 files+sha256 相等”，不要再手拼比较对象型 `buildSnapshotLive`。
- 🔴 `cdpReady=null` 是“不可证明”，既不能当 false 也不能放行；上面的 `.cdpReady==true` 就是为此写成恒等而不是真值判断。
- `capture` 在受控 renderer 内完成 workspace/Provider/Profile 选择并按 contract 回读 `full_access` 文案后原子落盘 `permission-evidence.json`。禁止另写 CDP 选择逻辑或跳过它；🔴 `capture` 失败就停止，禁止把第一条消息放进输入框。Step 4 不再切 workspace、Provider、Profile 或权限。

## 4. 把第一条消息放入输入框（仅 draft profile）

three-turn profile 不执行本节，直接进入 [严格三轮与一致性核查](references/three-turn-workflow.md)。draft profile 只做打字 + 精确回读验证：不点击发送、不落 send intent、不产生会话。`draft` 与 `send` 共用同一套前置检查（renderer 身份、Provider/Profile 标签、Provider 对应的 `full_access` 文案回读、idle、`turnCount==0`、输入框为空或恰为该文本），打字后回读 `input.value` 精确相等，随后经 `fixed_workspace.py record-draft` 在同一 lifecycle gate 内原子落盘草稿记录并刷新槽位 ownerStage：

```bash
set -euo pipefail
# --local-equality-only profile：追加 --local-equality-only true（取值式）
node "$skill_dir/scripts/send_prompt.mjs" draft \
  --run-root "$run_root" --provider "$provider" --turn 1 --workitem-id "$workitem_id"
permission_label="$(jq -r --arg p "$provider" '.providers[$p].permissionLabel // .permission.label' \
  "$skill_dir/references/contract.json")"
jq -e --arg label "$permission_label" '
  .schemaVersion==1 and .turn==1 and .typed.ok==true and .text==.typed.value
  and .before.turnCount==0 and .before.busy==false
  and .before.permissionValue=="full_access" and .before.permissionLabel==$label
' "$run_root/turn1-draft-evidence.json" > /dev/null
jq -e --arg id "$workitem_id" '
  .schemaVersion==1 and .status=="drafted" and .turn==1 and .workitemId==$id
' "$run_root/turn1-draft.json" > /dev/null
```

prompt 文本只由 `send_prompt.mjs` 从 contract 生成，调用方不得传文案或追加 suffix。报 `draft gate rejected turn 1` 属于脚本侧契约缺口，按产品问题停下报告，绝不绕过 helper 手打。`record-draft` 拒绝在 terminal lifecycle、已有 send intent 或已有草稿记录时重写，草稿记录与 launchId/pid/port 身份一致才落盘。

🔴 草稿记录落盘后**禁止点击发送**：点击会把草稿现场变成会话现场，之后的收尾语义不再成立，本次运行作废。停在输入框即可，后续只做 Step 5 的只读复验。

## 5. 最终分流、报告与现场保留

每条已取得 Provider 锁的退出路径（含 MCP 预检、登录、bootstrap、需求核验、App/权限准备失败）都走唯一分流器，不得手拼 stop/after/release；它只作用于本次 `$run_root`：

```bash
set -euo pipefail
finalize_rc=0
python3 "$skill_dir/scripts/finalize_pre_send.py" \
  --provider "$provider" --run-root "$run_root" --scry-bin "$scry_bin" \
  > "$run_root/finalize-pre-send-result.json" || finalize_rc=$?
# finalizer 顶层异常时只把结果打到 stdout、不写 lifecycle.json，所以要回退读结果文件
lifecycle_state="$(jq -er '.state // .status' "$run_root/lifecycle.json" 2>/dev/null \
  || jq -er '.state // .status' "$run_root/finalize-pre-send-result.json")"
echo "lifecycle: $lifecycle_state"
```

- `RETAINED_DRAFT`：草稿记录已落盘，现场按保留处理。禁止自动重试或清理，继续下面的复验。
- `PRE_SEND_ARCHIVED`：草稿记录未落盘，已受控归档并释放槽位。报告后结束，不继续最终复验。
- `RETAINED_LEGACY`：报 `WAITING_FOR_LEGACY_CLEANUP`，不做追溯清理。
- `CLEANUP_FAILED`（`finalize_rc != 0`，含 `lifecycle.json` 缺失、只能从结果文件读到它）：报 `CLEANUP_FAIL`，保留槽位锁，不能为释放锁而删 state。

`RETAINED_DRAFT` 继续做最终只读复验：

```bash
set -euo pipefail
python3 "$skill_dir/scripts/preflight.py" --provider "$provider" \
  --rate-native-repo "$workspace" --build-out "$build_out" \
  --output "$run_root/preflight-final.json" || true
"$scry_bin" turns verify --workspace "$workspace" \
  > "$run_root/turns-verify-final.txt" || true
node "$skill_dir/scripts/test_scry_app.mjs" status --run-root "$run_root" \
  > "$run_root/test-scry-status-final.json"
jq -e --arg rr "$run_root" '
  .mode=="test" and .testAppLabel=="Scry Test" and .status=="running"
  and .rendererOwnership.status=="verified" and .processAlive and .commandMatches
  and .cdpReachable and .cdpReady==true and .cdpClosed==false
  and .ownedRendererReady and .ownedRendererCount==1
  and .runtimeSnapshotReady and .windowTitleLabeled
  and .rendererOwnershipLive.status=="verified"
  and (.statePath|startswith($rr)) and (.userDataDir|startswith($rr))
' "$run_root/test-scry-status-final.json" > /dev/null
# 与独立来源（草稿落盘时的记录）比对 launch 身份，并要求终态晚于草稿记录写入
jq -e --slurpfile d "$run_root/turn1-draft.json" \
  '.launchId==$d[0].launchId and .pid==$d[0].pid and .port==$d[0].port' \
  "$run_root/test-scry-status-final.json" > /dev/null
test "$run_root/test-scry-status-final.json" -nt "$run_root/turn1-draft.json"
```

`preflight-final.json` 与最终 `turns verify` 只作身份证据，`ok=false` / 非零退出不阻断报告，但 `.failures` 必须逐项进报告；两者都不做前后指纹比对，因此**中途改了 Scry 提交（HEAD/treeHash 变化）或 recorder 版本不会被自动拦住**，发现变化就作废本次运行（未提交的工作区改动不影响：构建与运行以冻结的 HEAD 快照为准）。`lifecycle.json=RETAINED_DRAFT` 已由 finalizer 在草稿记录存在时原子写入，不复用 `mark-retained`（那是 post-send 会话路径）。

判定完成后释放本次仍持有的共享锁即停手；草稿路径不停测试 App、不动 workspace 现场与隔离 userData、不释放槽位锁。最终报告醒目给出：

- `RETAINED_DRAFT` 与 `Scry Test` 仍在运行的 live ownership 结果；
- `provider`、`run_root`、`workspace`、`scry-test-user-data`、槽位锁；
- 用户可直接切到标题为 `Scry Test` 的窗口查看输入框里的第一条消息；
- 同 Provider 的下次验收会等本次现场显式清理，不会自动覆盖。

只有验收契约「草稿判据」全部通过才写 `DRAFT_PASS`。报告逐项给出身份、版本、证据路径、失败字段、未覆盖范围和复盘入口。

## 6. 显式清理保留现场

🛑 **CHECKPOINT 2 · 无授权禁止执行本步任何命令**：只有用户明确指定该 `run_root` 要清理/关闭，或开始同 Provider 新验收时才收尾；“验收结束”“完成”或看完结果都不构成授权。缺具体 `run_root` 时回去索要，不得自己挑一个。

🔴 除授权外还须证明验收判定已终结（下面块内第一条 `jq -e`），否则 `--phase after` 会把 workspace 数据归档出 workspace，现场将无法人工查看。正常完成走 `RETAINED_*`；已经越过 send intent、但三轮无法完成的失败现场，必须先用 `mark-post-send-abandoned` 把用户原话、影响确认、provider/run/launch 一起写入 `POST_SEND_ABANDONED`。超时、Provider 异常或 Agent 自己的判断都不能代替这份授权。旧 schema 只有 frozen contract 的 schema+sha256 精确命中 `recoveryPolicy.legacyPostSendCleanupContracts` 时才能走同一动作；不允许把“legacy”泛化为可清理。`PRE_SEND_ARCHIVED` 时槽位已释放，本步无需执行。

清理常发生在另一个 shell，所以块内先把 `provider` 与冻结的 `scry_bin` 反查回来（`skill_dir` 固定、`run_root` 由用户给出），不得退回 PATH 裸命令；`scry_bin` 只作身份披露，`sanitize_workspace.py` 内部统一解析当前 stable prefix 最新 CLI 执行清理，recorder 已升级不影响旧现场清理：

```bash
set -euo pipefail
skill_dir=/Users/baobingjiang/IdeaProjects/vibecoding/scry/.claude/skills/validate-scry-rate-workflow
run_root="<用户明确指定的绝对路径>"
test -d "$run_root"
# 对不完整的 post-send 现场，先把本次用户授权严格绑定到唯一 launch；已完成现场跳过此块
state="$(jq -r '.state // .status // empty' "$run_root/lifecycle.json" 2>/dev/null || true)"
if test "$state" != "RETAINED_DRAFT" && test "$state" != "RETAINED_FOR_REVIEW"; then
  provider="$(jq -er '.provider' "$run_root/turn1-send-intent.json")"
  launch_id="$(jq -er '.launchId' "$run_root/test-scry-state.json")"
  jq -n --arg provider "$provider" --arg runRoot "$run_root" --arg launchId "$launch_id" \
    --arg userQuote '<用户明确授权清理该 run 的原话>' \
    '{schemaVersion:1,decision:"abandon",impactAcknowledged:true,
      provider:$provider,runRoot:$runRoot,launchId:$launchId,userQuote:$userQuote}' \
    | python3 "$skill_dir/scripts/fixed_workspace.py" mark-post-send-abandoned \
        --provider "$provider" --run-root "$run_root" \
    > "$run_root/post-send-abandonment-result.json"
fi
# 判定未终结就不许清场；RETAINED_FOR_REVIEW 为旧版 post-send 现场，同路径兼容
jq -e '.state=="PRE_SEND_ARCHIVED" or .state=="RETAINED_DRAFT"
  or (.state=="POST_SEND_ABANDONED"
  and .cleanupAuthorization.decision=="abandon"
  and .cleanupAuthorization.impactAcknowledged==true
  and (.cleanupAuthorization.userQuote|type)=="string"
  and (.cleanupAuthorization.userQuote|length)>0)
  or (.state=="RETAINED_FOR_REVIEW"
  and (.validationOutcome=="PASS" or .validationOutcome=="LOCAL_DATA_FAIL"))' \
  "$run_root/lifecycle.json" > /dev/null
provider="$(jq -er '.provider' "$run_root/turn1-send-intent.json" 2>/dev/null \
  || jq -er '.provider' "$run_root/turn1-draft.json" 2>/dev/null \
  || jq -er '.provider' "$run_root/test-scry-state.json")"
scry_bin="$(jq -er '.scryBin' "$run_root/environment-prepared.json")"
test -x "$scry_bin"
node "$skill_dir/scripts/test_scry_app.mjs" stop --run-root "$run_root" \
  > "$run_root/test-scry-stop-result.json"
node "$skill_dir/scripts/test_scry_app.mjs" status --run-root "$run_root" \
  > "$run_root/test-scry-status-after-stop.json"
# 先证明真的停了再清场；CDP unknown 不能冒充 closed
jq -e '(.status=="stopped" or .status=="stale")
  and .processAlive==false and .cdpClosed==true' \
  "$run_root/test-scry-status-after-stop.json" > /dev/null
python3 "$skill_dir/scripts/sanitize_workspace.py" \
  --provider "$provider" --run-root "$run_root" --phase after --scry-bin "$scry_bin" \
  > "$run_root/workspace-cleanup-after-result.json"
python3 "$skill_dir/scripts/fixed_workspace.py" release \
  --provider "$provider" --run-root "$run_root"
```

`after` 只把 workspace 数据归档进持久 `run_root`，不删 `run_root` 或隔离 userData。`provider` 或 `scry_bin` 反查不到就停手报告，不猜——`environment-prepared.json` 缺 `.scryBin` 说明该 run 从未冻结成功，按无草稿记录处理走 Step 5 分流器，不是 Step 6。清理失败时保留现场与槽位锁并报 `CLEANUP_FAIL`，禁止强删锁或强制清理；修好后用**同一个** `run_root` 补完同一 phase，不直接开新运行。

## 红线：绝不允许的动作

每次准备动手前对照一遍；命中任一条就换方案，不押宝“这次应该没事”。

| # | 禁止 | 为什么 | 正确做法 |
| --- | --- | --- | --- |
| 1 | Agent 自己克隆 Aone（browser-harness / Computer Use / CDP / 写 API / 点“克隆新建”） | 执行本 skill 不构成这类写操作的授权 | 停在 `WAITING_FOR_USER_CLONE` 等用户手工克隆并回传 ID |
| 2 | 靠页面/搜索/标题/创建时间自己找新需求 | 克隆链无法证明，等于伪造证据 | 只接用户回传的纯数字 ID / canonical URL |
| 3 | 把用户的网络抱怨当成 `--local-equality-only` 授权 | 该 profile 要两个条件同时成立 | 回去让用户二选一后再跑 |
| 4 | 绕过契约脚本手写等价逻辑（自己写 CDP 选择、手拼 `claim-shared → 裸命令 → release-shared`、直接跑 Node `start`、手打字） | 脚本是判据持有者，绕过后证据不成立 | 只走契约脚本 |
| 5 | 用界面观感、截图或退出码代替字段断言 | 退出码不构成健康证明，`cdpReady=null` 不等于健康 | 跑各 Step 里的 `jq -e` 硬断言 |
| 6 | 草稿落盘后点“发送”把草稿变成会话，或点“停止”/重启 App 来“收尾” | 等同毁掉草稿现场并破坏收尾语义，直接作废本次运行 | 草稿只打字不点击；停 App、清场只走 Step 5 分流器与 Step 6 显式清理 |
| 7 | 为凑 PASS 改 tracked MCP/hook/Provider 配置、禁用/移动用户级 server、物化凭据 | 会影响其他并发项目，把冲突掩盖成继续 | 报 `BLOCKED` 列出 server/scope/path 交用户定 |
| 8 | 要求用户先 commit/stash Scry 改动，或代他 commit/stash/`git clean` | dirty 只是身份证据，不是闸门 | 把 dirty 冻进指纹并在报告里披露 |
| 9 | 手工 `rm -rf .scry` / `git clean` / 强删槽位锁 / `git reset --hard` 当回滚 | 会毁掉复盘现场与可追溯链 | 交给 `sanitize_workspace.py` / `finalize_pre_send.py`，失败报 `CLEANUP_FAIL` |
| 10 | 碰 `/Applications/Scry.app` 及其 userData / 会话 | 不属于本次隔离测试 App，也不构成阻塞 | 只管 `$run_root/test-scry-state.json` 标识的测试 App |
| 11 | 主动调 uploader / `flush.py` / 上传 API，或拿远端页面入判定 | Hook 是唯一上传入口，上传健康不进判定 | 只读本地 archive / records / CLI summary |
| 12 | 把 `RECOVERING_ENVIRONMENT`、`needsBuild`、`needsInit`、`repair_required`、`WAITING_FOR_USER_CLONE`、`WAITING_FOR_DRAFT_CLEANUP` 写成 `BLOCKED` | 都是正常中间态或等用户清理的状态，误报让用户白跑 | 按各 Step 的分流继续或停手等待 |
| 13 | 在未得授权时改 Scry / rate-native / 适配器 / 仪表盘 | 本 skill 只验收和诊断 | 发现产品问题就停下报告，等用户另行授权 |
