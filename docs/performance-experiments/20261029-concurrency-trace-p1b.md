# 2026-10-29 P1b：投影 stamp 驱动的增量 hash（单点检查点）

## 状态

**P1a+P1b 已实现，功能与 L1 已验证；完整预注册 A/B 第一轮已执行完毕，结果按 scope 分别判定，见[结果篇](./20261029-concurrency-trace-p1-results.md)。本篇本身仍不作 CPU／wall 结论。**

- 这是 P1 的第二个检查点，不是性能验收。完整候选冻结后才按 [P0 冻结篇](./20261028-concurrency-trace-p0-freeze.md) §4 执行 32 R6 + 16 main50k 采样；阈值与顺序不变（该篇 §3／§4 未改动）。
- P1b 源码提交 `517e4f6d`（P1a 为 `445fa62c`）；未安装、未推送。
- P1a 的内容见 [P1a 篇](./20261029-concurrency-trace-p1a.md)，此处不重复。

## 1. 做了什么

- `src/main/live-trace.ts`：新增只读 `ProjectionStamp {generation, revision, baseRevision, dirtyFrom}`，WeakMap 按**投影数组身份**附着；值只有数字和一个不引用任何 run／数组的 opaque `generation`，只在本进程，**不作为 IPC/wire 字段**，renderer 或远端无法伪造。
- `src/main/bootstrap/trace-runtime.ts`：每个 cache entry 持有一个 `generation` token（重建复用、miss/换代/forget/evict 新建）；每次新建投影数组时**在 consume 之前**快照 `state.revision`、该 entry 上次 `seenRevision`（没有则 null）和真正重建的 `from`；quiet 直接返回原数组与原 stamp。
- `src/main/remote/desktop-trace-delta.ts`：每 entry 只额外保存最后采用的 `{generation, revision}`，并按三态决定 compare 起点：
  - 同一 generation 且该 revision 已 hash、count 一致 → 直接复用原 hashes，**0 hash、0 compare**；
  - 同一 generation 且已 hash 的 revision 等于 `baseRevision`（版本连续）→ 只从 `dirtyFrom` 重算并比较后缀；
  - 其余（无 stamp、generation 变、跳过中间投影、旧 hint 不匹配、prefix 对不齐）→ 全量 hash。
  - 复用 prefix 只做一次切片副本，hash 在一次后缀循环里写入并比较一次；`entry.hashes` 从不原地改写。读不到私有 stamp 的普通数组仍走原全量 `JSON.stringify` + SHA，并清空该 entry 的 hint，防止 unhinted 读夹在中间时复用错误 hash。
- 未改：`observe(runId, items, after?, now?)` 调用方式、公开参数、wire／协议、public epoch／revision 发布、history、trackedChanges、count、reset／after 校验、forget／sweep／LRU，以及 delta 的 `MAX_RUNS 8`／`MAX_REVISIONS 32`／`MAX_TRACKED_CHANGES 50 000`；JSON 序列化与 SHA 算法不变，未把 hash 搬去 writer，未加 engine／scheduler／配置项。

## 2. 证据

### 2.1 focused／type／build

- focused 最终 **74 tests / 12 files 通过**。父命令把 `src/main/live-trace.test.ts` 误写成 `src/main/main/live-trace.test.ts`，该文件未被选中；随后用正确路径单独 **3/3** 通过，合计 **77 覆盖 13 files**，但**不能称为一次 77 通过**。
- full node ＋ web `typecheck`、`npm run build`、`git diff --check` 通过。
- 新增 **18 个 P1b 用例**（12 main ＋ 3 bounds ＋ 3 fault controls），覆盖：独立全量 hash oracle 与真实 JSON 隔离 `mergeRemoteTrace` 逐步比对（items／顺序／正文／count／reset 判定，opaque revision 不比较）、tool 累计预算的 early→tail 回填（17×8192，早项缩小/增大改变末项 storage 与可见正文）、真实嵌套 `runtimeMetadata` 原地改、items generation 换代与漏中间投影、私有 no-op 不推进 public revision、wrong count／sweep／8 run／32 rev／50 000 change budget 的旧 reset 边界，以及只破坏 stamp 版本／dirty 证据的负控制。

### 2.2 首败（保留，不抹）

- 第一轮 `47 pass / 26 fail`（`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-2f08c1684604d780.log`）：漏 `projectionStamp` import，node `typecheck` 同错。
- 第二轮 `75 pass / 2 fail`（`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-f1ca946892d534b7.log`）：行首括号被 ASI 当成上一次调用；change-budget 淘汰时机写成无效期望。两处都按旧合同修正测试，**没有改生产 limits**。
- full `npm run test:unit` 的额外尝试被父 runner 在 180 秒截断（`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-10b7f38177a17b3a.log`）：日志未见 FAIL，但也没有完成 summary；之后 `ps` 未见 Vitest 进程。配置为 `maxWorkers 2`。**不计为全量通过**，也不提高 deadline 或重跑掩盖；该次检查仅未发现 Vitest 进程；未登记的退出后代仍为 unknown，不能据此宣称完整进程树已收敛。

### 2.3 真实 source-red

`/tmp/scry-p1b-unhinted-control.tED3nt/red.log`：父临时把"读不到 stamp 时清空 hint"改成保留，真实 full-content oracle 随即拒绝 peer 的 `'unhinted body'`（正确值应为 `'a'`），exit 1；恢复源码后 `cmp` 证明与纠正版精确一致，再跑 focused 同用例通过（1 pass / 11 unselected）。纠正后 `src/main/remote/desktop-trace-delta.ts` SHA `707145d53751677355b86b987b5cd81755b96a934002eb82c55fbda801301e93`。

### 2.4 L1 计数（只说明减少了什么工作，不是 CPU/wall）

`trace.main-50k`、5 repeats、15 个 collector tests 通过、ratchet 通过，冻结 P0 workload 未变；输出 `/tmp/scry-p1b-counts.jvVm2Q/{candidate,measure,p0-comparison}.json`。对照冻结 P0 计数 `/tmp/scry-p0-trace-counts-complete.wT9Ehs/observations.json`：

| 指标 | P0 | P1a+P1b | 变化 |
| --- | --- | --- | --- |
| reader hash calls | 349 998 | 149 996 | −57.1438% |
| reader hash bytes | 115 847 868 | 49 644 669 | −57.1467% |
| reader stringify calls | 466 657 | 199 991 | −57.1439% |
| reader stringify bytes | 119 915 583 | 51 387 926 | −57.1466% |
| total stringify calls | 583 332 | 316 666 | −45.7143% |
| total stringify bytes | 273 416 619 | 204 888 962 | −25.0635% |
| writer／other | — | 未搬移工作 | 无 `worse` |

这组数字只说"重复投影里的哈希与序列化次数/字节减少"，hash 仍在读路径上产生（未搬到 writer），所以不能当作 CPU 或 wall 改善。

### 2.5 真实功能

`/tmp/scry-p1-functional.5jXYa9/acceptance.json`：R6 `limit 16 / peers 1` = 16 个正常回答／16 个真实 archive／112 rounds ＋完整 oracle／seeds 16 000，host 4 ＋ client 3 登记进程 stopped 且 close0；main50k 35 phases ＋完整 oracle，3 个登记进程 stopped 且 close0；`corrupt-body` exit 1 由独立 oracle 拒绝、原始错误保留，3 个登记进程 stopped 且 close0。身份稳定：App `out` `9204c10278d31583b0f273d4d1c5b10ed0602c04c26e3f6ac85d58982523ae2a`，`liveOut` `540bb0c0…`，50k 产物 `/tmp/scry-p1-main50k-build-nxANvp` bundle `4aa4169318eab3aaf529e2099efafa35e49550cc306586cc26c158b8bec8c5f2`／67 993 B。三次 `highLoad=false`（4.85→4.56、4.56→4.43、4.43→4.43），仍是**独立功能样本**，不是预注册 A/B 数据。

## 3. 边界

- stamp 只有数字 ＋ 一个不引用 run／数组的 opaque generation，存于本进程 WeakMap，不跨 IPC。
- 投影缓存 8 runs／50 000 items；delta 的 8／32／50 000 不变。
- 无 stamp 的普通数组永远全量 hash；只有同 generation 且版本连续才用 suffix；quiet 是 0 hash、0 compare。
- 新 generation、漏掉的中间投影、夹在两次 hinted 读之间的 unhinted 读都会退化为全量。
- **漏标记（writer 没记）没有自动检测**：靠 writer 盘点 ＋ 测试维护；源码 grep 不是完备性证明。
- 不改调用方式、协议、trust／storage／ACK，不加 engine，不为未来能力预留接口。

## 4. 未验证

- 本篇是检查点口径：写下时完整预注册 A/B（32 R6 ＋ 16 main50k）尚未执行，因此本篇不含 L2／L3 与 CPU／wall 结论；该轮结果另见[结果篇](./20261029-concurrency-trace-p1-results.md)，此处不回溯改写。
- full `npm run test:unit` 未取得完成 summary（见 §2.2 的 180 秒截断）。

## 5. 下一步

1. ~~提交 P1b 源码~~ → 已提交 `517e4f6d`。
2. ~~冻结候选并执行预注册采样~~ → 已在候选 `517e4f6d` 上执行 32 R6 ＋ 16 main50k，见[结果篇](./20261029-concurrency-trace-p1-results.md)；16 并发 host CPU 未达 15%，按预注册停止扩大，不换阈值、不补采。
3. 下一步（若继续）需要独立证据与维护者批准：不启动 P2、不做 gate 晋升。
