# 最终对比重跑（2026-11-04，结论可用）

最初基线 `0ae5cf95`（0.2.56）对候选 `38686164`，`--phases recorder,hookwrap --pairs 2 --rounds 7`，同一份 A/A 校准 `../aa-20261104/AB-2026-11-04T07-30-40-178Z.json`。运行顺序 base-1 / cand-1 / cand-2 / base-2，每轮之间没有别的测量在跑。

```sh
for f in *.gz; do gunzip -k "$f"; done
node ../../../../scry-rollout-check/perf-ab.mjs \
  --base baseline-2026-11-04T17-23-54-534Z.json baseline-2026-11-04T18-13-38-610Z.json \
  --cand baseline-2026-11-04T17-40-44-084Z.json baseline-2026-11-04T17-57-10-068Z.json \
  --phases recorder,hookwrap --calibration ../aa-20261104/AB-2026-11-04T07-30-40-178Z.json --out .
```

## 结论

`perf-ab`：**IMPROVED**——变好 49（计数 32，耗时 17），变差 0，计数不稳定 0，无明确变化 59，测不到 13。计数四次运行完全一致，耗时的 Mann-Whitney p 都在 1e-5 量级。

| 指标 | 基线 | 候选 | 变化 |
| --- | --- | --- | --- |
| `recorder / daemon fast path / clean, 0 tools / gitCalls.stop` | 47 | 36 | −11（每个仓库一次） |
| 同上 `gitCalls.total` | 75 | 64 | −11 |
| `recorder / daemon fast path / dirty / gitCalls.stop` | 68 | 57 | −11 |
| 同上 `gitCalls.total` | 96 | 85 | −11 |
| `recorder / daemon fast path / clean, 0 tools / stop` | 1161.7 ms | 996.2 ms | −165.5（−14.3%，p ≈ 1.6e-5） |
| `recorder / daemon fast path / clean, 5 tools / stop` | 1174.1 ms | 1009.4 ms | −164.7（−14%） |
| `recorder / daemon fast path / dirty, 5 tools / stop` | 1506.7 ms | 1347.7 ms | −159（−10.6%） |
| `recorder / CLI fallback / clean, 0 tools / stop` | 1653.9 ms | 1479.2 ms | −174.7（−10.6%） |
| `hookwrap / daemon fast path / clean, 0 tools / plain.stop` | 1187.1 ms | 985.8 ms | −201.3（−17%） |
| `hookwrap / daemon fast path / clean, 5 tools / plain.stop` | 1166.8 ms | 984.2 ms | −182.6（−15.7%） |
| `recorder / daemon fast path / clean, 0 tools / hookTotalPerTurn` | 1925.2 ms | 1734.4 ms | −190.8（−9.9%，低于 10% 门槛，不算数） |

## 候选身份

- 候选提交：`386861644022de73e9e97cafc4617da5be9b3287`（标签 `cand-ea2-index-reuse`）。
- 复现构建：在该提交的干净 worktree 里 `npm run build:cli`，与远端候选二进制的 105 个 `dist` 文件 sha256 全部一致，入口 `dist/cli/scry.js` 为 `0293acfceebe44afbd828ed37b7ded9a7723bbfdc59dee1992fdbaaae1fa0f1c`。
- `git diff 38686164 <本轮分支 HEAD> -- src` 为空；也就是说 `src` 侧没有比该提交更新的改动参与测量。

## 与 `../final-20261104/` 的关系

那一组 4 次运行（`results/final-20261104/`）因测量机负载被打断（`base 2` 先等了两轮门槛、第三次检查仍 4.56 ≥ 4 而中止，事后单独补跑；同侧 `turnStart` 两次相差 485 ms），判 REGRESSION 但变差项落在轮次开始，与本改动无关。本目录是同一组参数在安静窗口的重跑，取代它的结论。
