# three-turn profile：严格三轮与一致性核查

仅在用户明确要求发送或三轮验收时读取。本 profile 继承主 `SKILL.md` 的 Step 0-3、冻结身份、清场、权限和红线；进入本文件后禁止调用 `send_prompt.mjs draft` 或生成 `turn1-draft.json`。

## 1. 三轮发送边界

三轮文案只能由 `contract.json` 生成：

1. `<provider command> <workitem_id> 理解prd后停下`
2. `确认并继续 写技术方案前停下`
3. `确认 写完技术方案后停下`

每轮严格执行“发送一次 → 等待同一 session 的 renderer idle + archive done + completed record → 下一轮”。不得根据 UI 文案、耗时或 workflow phase 猜 terminal；不得在队列态追加消息，也不得点停止制造边界。

```bash
set -euo pipefail
node "$skill_dir/scripts/send_prompt.mjs" send \
  --run-root "$run_root" --provider "$provider" --turn 1 --workitem-id "$workitem_id"
node "$skill_dir/scripts/watch_session.mjs" \
  --run-root "$run_root" --until-idle true --expect-turns 1 --max-minutes 180
session_id="$(jq -er '.sessionId' "$run_root/turn-session.json")"
node "$skill_dir/scripts/capture_permission.mjs" bind \
  --run-root "$run_root" --session-id "$session_id"

node "$skill_dir/scripts/send_prompt.mjs" send \
  --run-root "$run_root" --provider "$provider" --turn 2
node "$skill_dir/scripts/watch_session.mjs" \
  --run-root "$run_root" --until-idle true --expect-turns 2 --max-minutes 180

node "$skill_dir/scripts/send_prompt.mjs" send \
  --run-root "$run_root" --provider "$provider" --turn 3
node "$skill_dir/scripts/watch_session.mjs" \
  --run-root "$run_root" --until-idle true --expect-turns 3 --max-minutes 180
```

`send_prompt.mjs` 必须在 click 前原子写对应 send-intent/attempt 证据。CDP transport timeout 后只能只读 reconcile composer/session 状态，禁止再次输入或再次 click。第一轮 watcher 写出唯一 `turn-session.json`；第二、三轮必须复用它。出现第二 session、第四条 turn，或 archive 与 workspace record 已经终态却发生 prompt / `providerTurnId` 矛盾时立即 `SESSION_FAIL`，不能等到 180 分钟超时才报告。

Pi 还必须精确回读 `agentProfileId=pi:default`，并证明 `/skill:rate-workflow` 来自 Pi command catalog 的 skill，而不是只靠 composer 文本猜测。Pi 必须分别冻结 append cursor 与 active leaf；authoritative `providerTurnId` 是 append cursor 后新增、且 ancestry 可回溯到旧 active leaf 的唯一 user message entry id。RPC request id 不能代替。

## 2. 人工问题与旧 generation

允许的人工问题只有两类，且都只发生在第一轮：

- Qoder 请求 contract 固定钉钉文档正文：沿用 `qoder-question-journal.json`，正文只经 Computer Use 和 recorder stdin 传递，不落明文。
- 同一 `REQ-<id>` 已有活动 generation：watcher 只可报告 `WAITING_FOR_LEASE_HANDOVER`。必须先记录旧代 `workflowctl status`，明确告知“放弃旧代、从 P0 重跑，外部 MR/CR/发布/部署不回滚”，并取得用户原话授权；随后才可在同一 UI 问题中选择“是，继续”。这是让 rate-workflow 自己执行 canonical `release-orphaned-lease`，不是验证脚本删 lease。没有授权证据、旧 owner 本回合仍活跃、问题身份漂移或第二个问题时一律停止。

取得授权后、回答 UI 问题前，先把 `workflowctl status --json` 与 `workflowctl doctor --json` 的结构化结果和用户原话通过 stdin 交给 watcher 记录。doctor 证据必须证明旧 owner 的最后机械活动早于本轮 open prompt；controller 真正释放时仍会在锁内重新核验。该动作不保存需求正文、不释放 lease、不回答问题：

```bash
(
  cd "$workspace"
  python3 .claude/workflow/workflowctl.py status --task "REQ-$workitem_id" --json \
    > "$run_root/old-generation-status.json"
  python3 .claude/workflow/workflowctl.py doctor --task "REQ-$workitem_id" --json \
    > "$run_root/old-generation-doctor.json" || test "$?" -eq 1
)
jq -n \
  --arg quote '<用户明确同意放弃旧代并从 P0 重跑的原话>' \
  --slurpfile status "$run_root/old-generation-status.json" \
  --slurpfile doctor "$run_root/old-generation-doctor.json" \
  '{decision:"continue", impactAcknowledged:true, userQuote:$quote, oldGenerationStatus:{status:$status[0],doctor:$doctor[0]}}' \
  | node "$skill_dir/scripts/watch_session.mjs" record-lease-handover-authorization \
      --run-root "$run_root"
```

不得把任意文本问题泛化为允许项，不得自动点击问题答案，不得直接删除 `.task-leases.json`、workflow state 或 traces。

## 3. 本地数据与 overview 一致性

第三轮 terminal 后执行完整校验：

```bash
set -euo pipefail
python3 "$skill_dir/scripts/verify_local_session.py" \
  --workspace "$workspace" --provider "$provider" --workitem-id "$workitem_id" \
  --session-id "$session_id" \
  --scry-user-data "$run_root/scry-test-user-data" \
  --test-app-state "$run_root/test-scry-state.json" \
  --permission-evidence "$run_root/permission-evidence.json" \
  --scry-bin "$scry_bin" --output "$run_root/local-parity-initial.json"
python3 "$skill_dir/scripts/compare_turn_evidence.py" \
  --workspace "$workspace" --scry-user-data "$run_root/scry-test-user-data" \
  --session-id "$session_id" --output "$run_root/turn-evidence-parity.json"
```

`verify_local_session.py` 必须证明：恰好三轮；三条 prompt、status、timing、authoritative `providerTurnId` 完整；archive 与 `.scry/records` 的 user、assistant、skills、tools、MCP、usage、files、diff、errors、dangerous operations、interventions 全字段一致；真实 `scry turns summary --json`（即 Scry overview 的本地投影来源）与 records 独立聚合一致。Pi session 还必须匹配 `agentProfileId=pi:default`。

若三轮未齐，仍必须运行 `compare_turn_evidence.py` 对已有轮次按 `providerTurnId` 做部分对账，区分“轮数不足”和“已有轮次不一致”；部分对账不能产生 PASS。

## 4. 最终冻结与停手

再次运行相同参数输出 `local-parity-final.json`，并要求它与 initial 逐字节相等；再做 final preflight、test app live ownership、runtime snapshot 和 frozen fingerprint 对账。最后调用：

```bash
set -euo pipefail
python3 "$skill_dir/scripts/fixed_workspace.py" mark-retained \
  --provider "$provider" --run-root "$run_root" \
  > "$run_root/retained-lifecycle-result.json"
```

只有 `mark-retained` 原子写出 `RETAINED_FOR_REVIEW` 且 `validationOutcome=PASS` 才报告 PASS。数据不一致写 `LOCAL_DATA_FAIL`；Provider/CDP/identity/人工问题/轮数未完成写真实失败状态。无论结果如何都停在技术方案之后，不继续写代码，不停止 Scry Test，不清 workspace/userData，不释放 Provider 槽位。

显式清理仍只走主 `SKILL.md` Step 6。已经越过第一轮 send intent、但三轮无法完成的失败现场，只有在用户明确授权清理该 run 后才能调用 `mark-post-send-abandoned`；该终态必须绑定 provider、run root、launch id 和用户原话。没有授权就继续保留现场。
