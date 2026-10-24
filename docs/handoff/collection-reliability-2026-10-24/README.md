# 采集可靠性交接（2026-10-24）

来源：基于 `main@205521e` 的静态源码审查（见 [review.md](review.md)）。审查只读代码，**没有复现或测量**。每条都给了代码位置和推理链，执行方要先写测试证实问题存在，再修。

目标只有一个：**hook 触发的每一轮都要落成 record，落不下来时必须留下可查的痕迹**。性能和设计问题只在影响这个目标时处理。

## 协作方式

- **审查方**（Claude，本会话）：写交接文档、核验执行结果。
- **执行方**（另一个 agent）：按批次实施，推送到本分支 `reliability/collection`。
- 执行方完成一个批次 → 写 `reports/<批次>.md` 并更新 [STATUS.md](STATUS.md) 为 `待核验` → push。审查方核验后标 `已核验`，或在报告末尾写「核验意见」并标 `需修改`。
- 批次在同一分支上**串行**进行：A → B → C → D。E 要等用户先确认 uploader 的行为（见 [E.md](E.md)），确认之前不要开工。
- 不 push `main`，不开 PR，不合入。合入由用户决定。
- 用户本地可以验证 OpenCode、Qoder、Codex。每个批次需要用户在真实 Provider 上手动确认的步骤，执行方写进报告的「用户验证」一节，参考 [USER-VERIFY.md](USER-VERIFY.md) 的格式。

## 使用场景（所有批次都要考虑）

- **单仓库**和**带十几个子仓库的工作区**（`repositories.mode = discover-nested-git`，日常数据显示一轮约 18–19 个仓库）。
- **装在不同同事的电脑上**：macOS / Linux，Node 20/22/24，nvm / fnm / volta / Homebrew / 系统 Node 都有可能；不一定有 `curl`；Provider 可能从 GUI 启动，`PATH` 和终端不同。
- Provider：Claude（主路径）、Codex、Qoder、OpenCode、Pi。行为差异按仓库 CLAUDE.md「Provider 差异必须显式存在」处理，不要假装一致。

## 批次

| 批次 | 内容 | 依赖 | 文档 |
|---|---|---|---|
| A | H1 缺开始事件整轮丢失；H2 hook 静默跳过无痕迹；L2 开始事件状态不 fsync | 无，**先做** | [A.md](A.md) |
| B | H4 inbox 失败即删除；M1 recover 被单个会话打断 | A 核验后 | [B.md](B.md) |
| C | M5 回退链路超时与三重处理；L1 长路径快路径失效；M6 子目录启动找不到 hook | B 核验后 | [C.md](C.md) |
| D | 多仓库覆盖可见性（发现深度、仓库数、diff 超时如实标注） | C 核验后 | [D.md](D.md) |
| E | H3 daemon env 串会话；M2 队头阻塞与死信；M3 ACK 身份；M4 ACK 语义 | **用户确认 uploader 语义后** | [E.md](E.md) |

## 硬约束

1. **先证实再修。** 每条先写一个在旧实现上失败的测试（或可复现的脚本），单独提交；再提交修复。证实不了的条目可以放弃，在 STATUS 写明证据，这是合格结果。
2. **不弱化现有保证**：
   - 观测 hook 继续 fail open，任何改动都不能让 Provider 卡住或报错（hook 返回码保持 0）。
   - commit hook 的 trust / 指纹校验继续 fail closed。
   - 证据诚实：重建或降级的记录必须标 `partial` / `inferred` / `unavailable` 并写明原因，不能伪装成完整记录（CLAUDE.md「证据不能说谎」）。
   - 持久性：不删 fsync，不把 `writeJsonAtomic` 换成非原子写。
   - Recorder Core 保持独立：`src/core/turn-recorder/` 不引入 Electron、SQLite、Provider SDK 或原生依赖。
3. **hook 热路径不能变慢**：改 `providerHookSource()` 时，daemon 在线时的 curl 快路径不能新增进程启动；只允许 shell 内建操作（`printf >>` 之类）。
4. **兼容存量安装**：改了 hook 脚本，存量 workspace 要 `scry integrations repair --yes` 才能生效，`doctor` 会报 `outdated`。报告里写清楚哪些修复需要 repair，哪些升级 CLI 即可生效。
5. 不改 record schema 的已有字段含义；需要新增字段时同步更新 `src/shared/turn-record.ts` 的校验和 README 的说明。
6. 测试：focused `npm run test:unit -- <files>` + `npm run typecheck`；提交前跑一次 `npm run test:unit` 全量。原有失败只报告不修。自动化测试一律用临时 workspace，不写真实 `.scry`。
7. 只提交本批相关改动，不做无关格式化或重构。

## 回报格式（核验依据）

每个批次在 `reports/<批次>.md` 写：

- 每条问题：`已修复 / 放弃 / 部分` + 一句话结论
- 证实测试的 commit 与修复 commit（hash），以及证实测试在旧实现上的失败输出
- 改动后的行为：原来丢在哪里，现在去了哪里（落盘位置、计数字段、日志行）
- 是否需要 `integrations repair` 才生效
- 运行过的测试命令与结果；首次失败与重跑都如实记录
- **用户验证**：用户在 OpenCode / Qoder / Codex 上要做的步骤和预期结果
- 未验证项、留给用户决定的事
