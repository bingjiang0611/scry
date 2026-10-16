# 日常记录分析

日常记录是 packaged App 在真实使用中写入的性能日志，位于 `~/Library/Application Support/scry/performance/`：当前文件 `performance-0.jsonl` 加 gzip 归档 `performance-<UTC>-<随机>.jsonl.gz`，归档总上限 64 MiB（按 2026-10-16 的记录速度约可保留 340 小时使用）。旧版 App 只保留约 20 MB（约 5 小时）；新版安装前的数据仍按旧方式轮转。

需要长期趋势时，把快照归档到 `~/scry-performance-archive/`（本机，不进仓库、不上传）。

## 步骤

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
DAY=$(date +%Y%m%d-%H%M)
ARCHIVE="$HOME/scry-performance-archive/$DAY"   # 本机归档，不进仓库，不上传
node scripts/performance-report.mjs snapshot "$HOME/Library/Application Support/scry/performance" "$ARCHIVE"
```

列出 build、模式与记录数（同时读取 `.jsonl` 和 `.jsonl.gz`）：

```bash
node --input-type=module -e "import('./scripts/performance-report.mjs').then(async m=>{const {records}=await m.readRecords(process.argv[1]);const c=new Map();for(const r of records){const k=r.build+' '+r.mode;c.set(k,(c.get(k)||0)+1)};console.log([...c])})" "$ARCHIVE"
```

逐个 build 生成基线并排名：

```bash
node scripts/performance-report.mjs baseline "$ARCHIVE" <build> "$ARCHIVE/baseline-<build前8位>.json"
node .agents/skills/scry-performance-climb/scripts/journal-hotspots.mjs "$ARCHIVE"/baseline-*.json
```

两个 build 前后对比（发布后验收用）：

```bash
npm run performance:report -- "$ARCHIVE" <旧build> <新build>
```

## 读结果时必须考虑

| 问题 | 怎么处理 |
|---|---|
| Σp50（p50 × 次数）大，但操作在后台 | 后台操作不直接让用户等，降低优先级；但会抢 CPU、拖慢事件循环，看 `eventLoopMaxMs` |
| `agent.first_text` 的 `durationMs` 很大 | 主要是模型耗时，不是 Scry 代码；但它的 `stage.*`（git 基线、进程启动、run 注册）是 Scry 工作，要单独看 |
| provider/workload 显示 `unmeasured` | 该 IPC 没有记录工作量维度，无法区分大仓库和小仓库；这是可补的观测缺口 |
| maturity 含 `single-session`、`short-recording` | 只是线索，不能当作结论或发布对比 |
| 机器负载 | 日志**不记录系统负载**，而这台机器常在 18–90。毫秒数偏高可能是负载造成的；用受控基准（经 `timing-run.mjs`）复现后再下结论 |
| 只有一个用户、一台机器、主要是 Pi | 不代表其他 Provider（尤其主路径 Claude）和其他用户 |
| 未观测的路径 | 输出 `unobserved paths`。没观测到不等于不慢，列为盲区 |
| p95/p50 大 | 长尾通常来自资源争用、锁、冷缓存、大输入；值得单独查 |

## 交付

慢点表每行写：路径、操作、指标、p50/p95、样本数与会话数、是否阻塞用户、归属（Scry/Provider）、已有计数或基准覆盖（有/无）、与上次快照的趋势（若有归档）。最后列数据局限和盲区。
