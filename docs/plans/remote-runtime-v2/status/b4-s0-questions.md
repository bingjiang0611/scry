# B4-S0-2 · daemon 模式下提问 / 审批不实时出现

日期：2026-11-12。来源：维护者 macOS 真实 Provider 验收 S0-2（提交 `79644a2`）。`SCRY_HOST_DAEMON=1` 下，真实 Codex 的审批请求、Pi 的提问表单在运行中不出现在窗口里，在侧栏重新选中该会话后才出现；之后批准、拒绝都正常。开关关闭（进程内）时立即出现。

## 原因

根因是**提问用错了 run id**，不是时序本身。

- daemon 的提问 broker（`src/main/remote/remote-interaction-broker.ts` 的 `request`）把待答提问改写成 `{ ...request, runId: ledgerRunId }`，`questions` 操作返回的就是这个账本 id（UUID）。
- `src/main/daemon-run-questions.ts` 的 `publishQuestions` 把它原样发到 `agent:userQuestion`，并原样交给 run 订阅（`RunTraceRouter.publishQuestion` 按 `request.runId` 查订阅）。
- 窗口持有的是 `start` 返回的规范 id（`remote-run-…`，trace 事件也带这个 id）。`useAgentSession` 的 `receiveQuestionDelta` 丢弃非聚焦 run 的提问；`ChatTurnAssistant` / `Composer` 也按 `request.runId === turn.runId` 匹配。所以提问被丢掉，或者归到一个窗口不显示的 run 下。
- 再选中会话时，窗口读 `agent:activeRun` 快照，其中 `pendingQuestions` 来自 daemon 内 `run-provider.ts` 的 `publishQuestionOpened(remoteQuestion)`（规范 id），所以那时才出现。回答走 `#cursorFor(response.runId)`，两个 id 都认，所以批准/拒绝正常。
- 关闭事件也不一致：`agent:userQuestionClosed` 发的是 `cursor.runId`（账本 id），订阅的关闭发的是 `scryRunId`。另外，本窗口回答后 `answerQuestion` 把该提问从 `askedQuestions` 删掉，下一次读不到它时就不会发关闭事件（进程内回答后会发 `agent:userQuestionClosed` 和订阅的关闭）。

时序（主要怀疑点）的核实结果：`61106a4` 之后，`start` 等准入期间的 pump 步骤确实会调用 `publishQuestions`。真实 daemon + smoke Provider（`side chat ask …`，一运行就请求审批）连续 3 次，提问都在 `start` resolve **之前**发出。按旧代码，这时 renderer 的 `focusedRunIdRef` 为 `null`，会采用提问里的账本 id 作为焦点；`start` resolve 后焦点改成规范 id，这条提问不再匹配任何轮次，而 `askedQuestions` 已记下它，不会再发一次。所以时序会让症状更稳定，但只要 id 对，提前到达也没问题：焦点为空时采用的就是 `start` 随后返回的同一个 id，这与进程内一致。

还有一处小竞态：同一步里先读 watch、后读 questions。如果 bind 标记和提问恰好都落在这两次读取之间，提问会在 `scryRunId` 未知时被读到，只能用账本 id 发出。

## 修复（只改 `src/main/daemon-run-questions.ts`）

1. 打开和关闭事件（窗口通道和 run 订阅）都用 `windowRunId(cursor) = cursor.scryRunId ?? cursor.runId`，即 `start` / `follow` 返回、trace 也带的 id。回答仍按账本 id 发给 daemon（不变）。
2. 本 cursor 还没读到准入（`admissionPhase !== 'admitted'`）时不读也不发提问。提问只可能在准入之后出现，准入在 bind 之后，所以发出时 id 已知；被推迟的提问不记入 `askedQuestions`，下一步读到准入时再发。顺带减少了准入等待期间的 `questions` 请求。
3. 回答成功后不再从 `askedQuestions` 删除该提问；daemon 不再列出它时，按同一个 id 发关闭事件，和进程内一致。

renderer 未改：「只接受自己聚焦的 run 的提问」是正确的合同，问题在 main 给错了 id。`daemon-run-runtime.ts`（约 19.85 KB）和 `host-process.ts` 未改。

## 测试

- `src/daemon/host-process-questions.test.ts`（新增，真实 daemon，临时 userData/workspace，smoke Provider，App 自己的 `DaemonRunTransport` + `DaemonRunRuntime` + `createDaemonRunSurface`，记录 `send` 和 run 订阅）：`side chat ask …` 启动后，`agent:userQuestion` 只发一次，`runId` 等于 `start` 返回的 id，订阅收到同一 id；按收到的请求回答后，`agent:userQuestionClosed` 和订阅关闭都是 `{ runId: <start 返回的 id>, questionId }`；run 正常结束、无错误。
- `src/main/daemon-run-questions.test.ts`（新增，脚本化 daemon）：
  - 第一次读到提问时还没读到 bind（竞态），提问被推迟，读到 bind + 准入后以规范 id 发出，订阅同样；
  - 本窗口回答后关闭事件以打开时的同一 id 发出，期间不重复打开；回答请求仍是账本 id。
- 修复前（`f5024e0` 的 `daemon-run-questions.ts`）：
  - 真实 daemon 用例失败：`expected '5fc5d290-…'（账本 id）to be 'remote-run-mwdqkhgm-0'`；
  - 两个单元用例都失败。
- 分项对照：
  - 只去掉准入门槛：竞态用例失败，其余通过；
  - 只恢复「回答后删除」：关闭用例和真实 daemon 用例失败（`expected [] to deeply equal [...]`；真实 daemon 10 s 内没有关闭事件）；
  - 恢复完整修复后 3 个用例全部通过。
- 首轮记录：最初的真实 daemon 用例把回答写成 `answers: { 0: … }`，daemon 回 `invalid_question_response`。这是测试写错了（回答按问题文字作键），改正后才暴露出回答后没有关闭事件的问题。单元用例最初在旧代码上因断言失败时没有 `dispose()`，pump 在即时返回的假 daemon 上空转导致 vitest 超时；已改为 `try/finally` 释放。

## 实际运行（Linux 容器，root，有其他 lane 并行）

- `npx vitest run src/main/daemon-run src/main/bootstrap/daemon`：21 个文件、113 个用例通过。
- `npx vitest run src/daemon`：33 个文件、116 个用例通过。
- `npm run typecheck`：通过。
- 改动的文件不在 `scripts/performance-paths.json` 的 `sources` 中，未跑 `performance:measure`。

## 未运行 / 未验证

- renderer 没有补 hook 级测试：仓库 unit 层没有 hook 渲染夹具，DOM 行为走 Electron UI 夹具；本次 renderer 代码未改。
- 真实 Provider（Codex、Pi）、macOS 真实 App 未在本容器运行，需要验证人重放。在本分支先 `npm ci && npm run build`；HOME 保持验证人自己的，以便使用已授权的 Codex / Pi 登录：

  ```sh
  T=$(mktemp -d /tmp/scry-s0q-XXXX); mkdir -p "$T/userData" "$T/workspace"
  SCRY_TEST_APP=1 SCRY_HOST_DAEMON=1 SCRY_DAEMON_CREDENTIAL_PLAINTEXT=1 SCRY_REMOTE_HOST=0 \
    ./node_modules/.bin/electron . --user-data-dir="$T/userData"
  ```

  1. 打开 `$T/workspace`，Provider 选 Codex（默认审批模式），发一条会触发审批的请求（例如让它在工作区里创建文件或运行命令）。审批卡片应在运行中**直接出现**在当前轮次下，不需要在侧栏重新选中会话。分别点批准、拒绝各一次：卡片消失，run 按选择继续或结束。
  2. Pi：发一条会弹出提问表单的请求，表单在运行中直接出现；回答后表单消失、run 继续。
  3. 回答后再切到别的会话、再切回来：不应重新出现已回答的提问。
  4. 对照：不设 `SCRY_HOST_DAEMON` 重复 1–2，行为相同。
  5. 结束后按 `$T/userData/daemon/daemon.lock` 的 pid 核对身份再停后台服务，删除 `$T`。
- iOS 未运行。
