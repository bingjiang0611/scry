# recorder 0.2.77：空闲 CPU 修复与发布证据

## 发布范围

- 只发布 `@ali/scry-turn-recorder@0.2.77`，部署 registry 的 `latest` 已回读为 `0.2.77`。未发布或安装 App、uploader、CodeLens；未改其 recorder pin，也未替换生产守护进程。
- PR [#116](https://github.com/bingjiang0611/scry/pull/116) 在适用检查通过后 squash 合入 main：`062a008dc9e97943c965f18eec7a0bae646faf89`。
- 验证等级 **L2**：隔离 socket harness、确切 CI 构件、正式 npm 下载包。没有真实宿主、生产上传或 ACK 验证。

## 现场与根因

macOS `sample` 取得两个生产 daemon 的 5 秒原生栈，出现 V8 JSON 解析/字符串分配热点。最初共 3 个 `recorder serve`：

| PID | 工作区类别 | 版本 | 已运行 |
|---|---|---|---|
| 57934 | 生产开发工作区 | 0.2.75 | 约 12.5 小时 |
| 53611 | 遗留隔离验收工作区 | 0.2.76 | 约 9.7 小时 |
| 94812 | 与 53611 相同的验收工作区 | 0.2.76 | 约 9.5 小时 |

后两者确实共用同一 socket 路径；只读 status 返回 PID 94812，53611 已无可达的该路径入口。工作区仍有一个 open，不能据此伪造完成或删除证据。生产工作区最初有 47 个 open，只有 5 个 transcript 仍可读，合计约 742 MB，其中一个 Codex rollout 约 739 MB。调查期间 PID 57934 被 PID 56447 / 0.2.76 替代，非本任务触发。

隔离 0.2.75 V8 profile 进一步定位：827 个非 idle/program 样本中，665 个（80.4%）在 `transcriptAnchorOffset` 子树。不是 socket 请求或反复发现 Git 仓库造成的主要热点：snapshot 缓存的查找发生在 anchor 定位**之后**，Codex 每次先重新扫描 JSONL，随后才发现投影已经缓存。已有 1→2→4→8→15 秒退避，不能把旧行为描述为一直每秒全量恢复。

另外，每次 health 会枚举 attention 会话的历史 generations 寻找 `pending-open.json`；每 64 个恢复 pass 还会重建全工作区 attention。当前轮次的事件文件也被重复 stat。直接 serve 的 owner 检查/写入/listen 未在一个独占区间内，存在双 daemon 竞态。

## 修改

- `recorder-transcript-cache.ts`：以文件 dev/ino/size/mtime/ctime、轮次身份、冻结边界、Pi entry IDs 查缓存，再定位 anchor。独立子 transcript 的投影仍不缓存，避免漏掉根文件不变而子文件更新。
- `runtime-state.ts`、`recorder.ts`、`recorder-turn-state.ts`：daemon 使用增量 attention；隔离轮次在 `.scry/quarantine-index/` 中先索引后发布，事实源仍是原来的补零 generation 下 `pending-open.json`。索引不写进 session 目录，不增加 session 生命周期的 fsync。失败的初始化不发布空索引；显式 recover 重建索引。完整事件时钟观测才缓存，事件目录或 open 状态变化使其失效。
- `managed.ts`：显式 handoff 的身份歧义检查仍完整核对隔离证据，不把旧写者/恢复备份遗漏为“只有一个 provisional turn”。
- `daemon-listen.ts`：按 socket 串行认领；失败不抢走活 owner。状态查询不延长空闲时间；idle update 返回后重验活动，不能关闭刚收到 hook 的会话。保留 `closed`（socket 已关闭）与 `close()`（delivery/清理结束）的原合同。
- 默认仍是 **30 分钟无 hook 且无待恢复证据退出**。有 open、队列或隔离证据则保活。长工具/审批等待不是结束证据，不改变为强制过期。旧版已经产生的重复进程未自动停止。

## 前后基准

脚本：`scripts/recorder-daemon-cpu-bench.mjs`。Apple M2 Pro / macOS arm64 / Node 24.18.0，同一机器；64 MiB Codex transcript、1,000 个合成已完成 generation、一个未终态 open。使用真实 600 秒等待，不改时钟；两侧启用相同的 10 ms V8 采样。profile 和状态只在隔离临时目录中生成。

CPU 是 daemon 与小型 socket 客户端所在进程的 user+system 时间，不含 Git 子进程。没有真实宿主或上传，diff capture 关闭。本机负载较高，CPU 时间与墙钟时间分开报告，不宣称生产 SLA。

| 指标 | 正式 0.2.75 | 正式下载的 0.2.77 |
|---|---:|---:|
| 空闲观察墙钟 | 600.001 s | 600.002 s |
| 空闲 CPU 时间 | 14,999.325 ms | 4,078.723 ms |
| 平均单核占用 | 2.4999% | 0.6798% |
| 重复 anchor 扫描 | 2,751,561,004 bytes | 0 bytes |
| snapshot 正文读取 | 0 bytes | 0 bytes |
| 一轮典型会话 CPU | 369.329 ms | 347.709 ms |

这条含遗留 open 的空闲场景 CPU 下降 **72.8%**，不是把瞬时 95% 与新版本的十分钟平均值比较。典型会话为 prompt + 10 对工具事件 + Stop，共 22 个事件；只测一轮，不据此宣称吞吐提升。

两侧都断言典型会话恰好提交一条 completed record；随后不发 hook、只追加真实格式的 Codex terminal，daemon 自动恢复并恰好提交一次。0.2.77 的 CI 未发布构件还独立跑过一次 600 秒：4,104.098 ms CPU，0 重复扫描；正式包重新下载、核对后另跑了上述 600 秒，不以旧产物替代正式包证据。

复现（包来自确切版本的 registry 下载件或 CI artifact）：

```bash
node scripts/recorder-daemon-cpu-bench.mjs \
  --package-root=/path/to/extracted/package \
  --seconds=600 --transcript-mib=64 --history=1000 --profile \
  --out=/tmp/recorder-cpu.json
```

## 测试与 CI

- 新增 9 项定向回归：缓存前置及终态/冻结/替换失效、历史索引与显式修复、65 次增量恢复不扫历史、事件 EIO 不缓存、索引发布失败/读写交错、listen 发布失败、并发单 owner、status 不续命、更新期间新 hook。
- 反向对照：旧 main 的缓存回归失败，4 次多扫 4,195,348 bytes；修复后为 0。最终 focused 5 文件 16 项和选定旧合同 7 项通过；node typecheck 与 `git diff --check` 通过。
- 首次 PR CI `44228655246` 失败，暴露了索引目录/额外 fsync、旧 managed 证据、时钟老化、shutdown 和 README 版本合同问题。均修正；没有放宽断言、删测试、扩大超时或把失败归为 flake。负载超过 35/10 核时停止了本地大目录测试，保留原日志。
- 最终 PR CI [`44230172954`](https://github.com/bingjiang0611/scry/actions/runs/44230172954) 15 个 job 全通过；适用的 Performance 与 Remote Check 也通过后才合并。
- main CI [`44231181988`](https://github.com/bingjiang0611/scry/actions/runs/44231181988) 15 个 job 全通过，含 Node 20/22/24 CLI 测试与干净 tarball smoke、unit/coverage、Linux package 与 packaged Electron。
- 正式包回读 `scry version = 0.2.77`。隔离关键路径再以前台命令验证一次，退出 0、两项 exactly-once/无 hook 恢复断言通过，运行时代码 hash 与十分钟正式包测量相同。

### 单独保留的 App 性能失败

main 的 **另一个** Native App Performance run [`44231181965`](https://github.com/bingjiang0611/scry/actions/runs/44231181965) 未通过，不能称 main 所有工作流全绿：

| 场景 / 指标 | 基线 | 候选 | 门槛 |
|---|---:|---:|---:|
| paged / nativeOpen fixture P95 | 110.8 ms | 199.2 ms | 166.2 ms |
| paged stop-immediate / terminal 6-run max | 214.1 ms | 497.7 ms | 464.1 ms |
| paged stop-immediate / settled-visible 6-run max | 256.9 ms | 553.7 ms | 506.9 ms |

同一候选 App 构件的诊断控制，正向另有 3 项、反向 4 项超标。它说明同产物测量不稳定，**不证明**原失败是 flake、不证明基线同样失败，也不抹掉原结果。未重跑或改门槛。按仓库独立 CLI 发布范围交付 recorder；本次没有发布 App。App 性能归因留待维护者另开任务，不在此处声称已解决。

## 产物追溯

- main CI 原包 SHA-256：`163c95578ab39dc6f67fc2128abbf30e9532bdda1f34b51a8063a2bc57ca082e`。provenance 明确为 main 提交 `062a008d…`；与最终 PR CI 的包逐字节相同。
- 发布仅在隔离目录将 package name 改为部署作用域名；代码不重建。发布时 `--ignore-scripts`，因为确切提交的完整 CLI 门禁已由上述 CI 执行，并非使用陈旧本地 dist。
- 正式下载包 SHA-256：`ec57450866dd3a8395d8e675931deef56bcd73e5943e38a978ebc34772d35a68`。
- registry SHA-1：`4cfb8634b388741f2609428c15a9545643b90152`，SHA-512 integrity 下载后验证一致。
- 150 个文件与 main CI 原包比对；除 package name 外全部一致。所有 dist JS 的有序内容 SHA-256：`c5f77cfbd4d23c774f40929b354e415ddb551613502508358d54fb7132b6e89a`。
- 基线安装件的 142 个 JS 文件与正式 0.2.75 下载件全部一致；其 tar SHA-256：`78353ca15d3b6b0b46db741c321a304fd026661e5de0dcb532c8ff28a4984b5d`。

原始本机证据留在 `/tmp/scry-recorder-idle-evidence/`，包含 sample、cpuprofile、JSON、失败及成功 CI 日志，不将私人工作区路径/原始现场栈提交到仓库。正式十分钟测量的 JSON 和隔离清理完成；后台包装没有留下 exit marker，不能把该包装退出码记为 0。独立前台正式包关键路径退出码为 0。

## 范围限制

- 上述数字只覆盖列出的 L2 workload；冷读、日志变化、缓存淘汰及独立子 transcript 仍可能读取真实内容，不保证所有会话规模下都为零 CPU。
- 旧版直接写者长期与新版 daemon 混用时，或恢复备份后，应显式执行 `scry recorder recover` 重建索引；后台增量路径不扫描所有历史来发现任意外部篡改。
- 默认 30 分钟退出规则检查了代码与缩短 timeout 的回归，没有把缩短测试称为真实 30 分钟等待。Linux 有 CI 合同/包检查，没有本地 Linux 十分钟 CPU 测量。
- 本机旧 daemon 与 CodeLens/uploader pin 未升级。npm 发布成功不等于这些进程已运行新版本。
