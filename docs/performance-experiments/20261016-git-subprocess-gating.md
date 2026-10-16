# 2026-10-16 git 子进程数升为门禁
- 假设：git 子进程数可代表 source-control 操作耗时。
- 结果：受控测量中 git 子进程占操作耗时 98.2%–98.9%（2 轮 × 15 次）；注入一次多余 git 调用，计数 8→9，`check` 判 `regressed`。
- 结论：成立（L1 门禁）。注意：门禁守的是次数，真实仓库中单次 git 成本随规模增长，次数不变也可能变慢。
- 锁定：`source-control.diff/subprocess.git` ≤ 8，`source-control.service.status-diff/subprocess.git` ≤ 11。
- 补充：同日把子进程计数扩展到 `execFileSync`/`spawnSync`/`exec`/`execSync`/`fork`，对照测试中旧计数只看到 6 次 git 调用里的 2 次。门禁值 8/11 不变。
