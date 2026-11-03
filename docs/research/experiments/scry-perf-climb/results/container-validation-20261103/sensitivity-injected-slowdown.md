# 性能 A/B：REGRESSION

基线 2 份、候选 2 份。计数（L1）任何增加即变差。耗时/资源（L2）要同时满足才算变化：幅度至少为基线的 10%、5 ms（仅耗时）和 A/A 校准变化的 2 倍；候选每次运行都落在基线每次运行的同一侧；有原始样本时 Mann-Whitney 检验 p < 0.01。测不到的不算通过。

汇总：变好 0（计数 0，耗时 0）；变差 29（未豁免 29）；计数不稳定 0；无明确变化 31；相同 18；测不到 2

## 阶段

```json
{
  "recorder": {
    "compared": true,
    "base": [
      "baseline-2026-11-03T17-49-58-170Z.json",
      "baseline-2026-11-03T18-04-55-061Z.json"
    ],
    "cand": [
      "baseline-2026-11-03T17-54-52-638Z.json",
      "baseline-2026-11-03T17-59-52-091Z.json"
    ],
    "excluded": [],
    "versions": {
      "base": {
        "scry": [
          "0.2.52"
        ]
      },
      "cand": {
        "scry": [
          "0.2.52"
        ]
      }
    }
  }
}
```

## 变差（29）

| 指标 | 类别 | 基线 | 候选 | 变化 | 需要超过 | p | 各次（基线 / 候选） | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| recorder / daemon fast path / clean, 0 tools / turnStart | time | 223.4 ms | 380.3 | 156.9 (70.2%) | 57.2 | 0.000157 | 198.3, 248.5 / 402.9, 357.6 |  |
| recorder / daemon fast path / clean, 0 tools / hookTotalPerTurn | time | 544.7 ms | 720.2 | 175.5 (32.2%) | 127.6 | 0.000157 | 492.6, 596.8 / 735.5, 704.9 |  |
| recorder / daemon fast path / clean, 0 tools / gitCalls.stop | count | 55 count | 56 | 1 | 任何变化 | – | 55, 55 / 56, 56 |  |
| recorder / daemon fast path / clean, 0 tools / gitCalls.total | count | 87 count | 88 | 1 | 任何变化 | – | 87, 87 / 88, 88 |  |
| recorder / daemon fast path / clean, 5 tools / turnStart | time | 190.9 ms | 369.5 | 178.6 (93.6%) | 47.4 | 0.000157 | 188.9, 192.8 / 365.9, 373 |  |
| recorder / daemon fast path / clean, 5 tools / hookTotalPerTurn | time | 820.2 ms | 1046.5 | 226.3 (27.6%) | 82 | 0.000881 | 825.6, 814.7 / 1036.2, 1056.7 |  |
| recorder / daemon fast path / clean, 5 tools / gitCalls.stop | count | 55 count | 56 | 1 | 任何变化 | – | 55, 55 / 56, 56 |  |
| recorder / daemon fast path / clean, 5 tools / gitCalls.total | count | 87 count | 88 | 1 | 任何变化 | – | 87, 87 / 88, 88 |  |
| recorder / daemon fast path / clean, 30 tools / turnStart | time | 220.8 ms | 396.1 | 175.3 (79.4%) | 39.4 | 0.000157 | 221.1, 220.5 / 394.1, 398.1 |  |
| recorder / daemon fast path / clean, 30 tools / gitCalls.stop | count | 55 count | 56 | 1 | 任何变化 | – | 55, 55 / 56, 56 |  |
| recorder / daemon fast path / clean, 30 tools / gitCalls.total | count | 87 count | 88 | 1 | 任何变化 | – | 87, 87 / 88, 88 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / turnStart | time | 234.1 ms | 372.7 | 138.6 (59.2%) | 32.8 | 0.000157 | 235, 233.2 / 354.5, 390.9 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / hookTotalPerTurn | time | 1131.9 ms | 1332.2 | 200.3 (17.7%) | 113.2 | 0.00067 | 1166.7, 1097 / 1332.3, 1332.1 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / gitCalls.stop | count | 76 count | 77 | 1 | 任何变化 | – | 76, 76 / 77, 77 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / gitCalls.total | count | 108 count | 109 | 1 | 任何变化 | – | 108, 108 / 109, 109 |  |
| recorder / CLI fallback / clean, 0 tools / turnStart | time | 512.6 ms | 661.4 | 148.9 (29%) | 69.8 | 0.000157 | 490.2, 534.9 / 680.6, 642.2 |  |
| recorder / CLI fallback / clean, 0 tools / hookTotalPerTurn | time | 1146.6 ms | 1307.4 | 160.8 (14%) | 114.7 | 0.000285 | 1127.1, 1166 / 1321.1, 1293.6 |  |
| recorder / CLI fallback / clean, 0 tools / gitCalls.stop | count | 55 count | 56 | 1 | 任何变化 | – | 55, 55 / 56, 56 |  |
| recorder / CLI fallback / clean, 0 tools / gitCalls.total | count | 87 count | 88 | 1 | 任何变化 | – | 87, 87 / 88, 88 |  |
| recorder / CLI fallback / clean, 5 tools / turnStart | time | 555.6 ms | 643.3 | 87.7 (15.8%) | 55.6 | 0.000507 | 571.6, 539.6 / 650.9, 635.7 |  |
| recorder / CLI fallback / clean, 5 tools / gitCalls.stop | count | 55 count | 56 | 1 | 任何变化 | – | 55, 55 / 56, 56 |  |
| recorder / CLI fallback / clean, 5 tools / gitCalls.total | count | 87 count | 88 | 1 | 任何变化 | – | 87, 87 / 88, 88 |  |
| recorder / CLI fallback / clean, 30 tools / turnStart | time | 535.7 ms | 709.5 | 173.8 (32.4%) | 141.4 | 0.000157 | 549.8, 521.6 / 712.5, 706.5 |  |
| recorder / CLI fallback / clean, 30 tools / gitCalls.stop | count | 55 count | 56 | 1 | 任何变化 | – | 55, 55 / 56, 56 |  |
| recorder / CLI fallback / clean, 30 tools / gitCalls.total | count | 87 count | 88 | 1 | 任何变化 | – | 87, 87 / 88, 88 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / turnStart | time | 582.1 ms | 752.2 | 170.1 (29.2%) | 74.4 | 0.000157 | 611.3, 552.9 / 717.7, 786.6 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / gitCalls.stop | count | 76 count | 77 | 1 | 任何变化 | – | 76, 76 / 77, 77 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / gitCalls.total | count | 108 count | 109 | 1 | 任何变化 | – | 108, 108 / 109, 109 |  |
| recorder / daemon / cpuSecondsDuringRun | resource | 13.5 s | 17 | 3.5 (25.9%) | 1.4 | – | 13, 14 / 17, 17 |  |

## 计数不稳定（0）

无

## 变好（0）

无

## 测不到（2）

| 指标 | 类别 | 基线 | 候选 | 变化 | 需要超过 | p | 各次（基线 / 候选） | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| recorder / daemon fast path / clean, 0 tools / toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-49-58-170Z.json: no tool events in this scenario; baseline-2026-11-03T18-04-55-061Z.json: no tool events in this scenario; baseline-2026-11-03T17-54-52-638Z.json: no tool events in this scenario; baseline-2026-11-03T17-59-52-091Z.json: no tool events in this scenario |
| recorder / CLI fallback / clean, 0 tools / toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-49-58-170Z.json: no tool events in this scenario; baseline-2026-11-03T18-04-55-061Z.json: no tool events in this scenario; baseline-2026-11-03T17-54-52-638Z.json: no tool events in this scenario; baseline-2026-11-03T17-59-52-091Z.json: no tool events in this scenario |

## 无明确变化（31）

| 指标 | 类别 | 基线 | 候选 | 变化 | 需要超过 | p | 各次（基线 / 候选） | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| recorder / daemon fast path / clean, 0 tools / stop | time | 315 ms | 321.8 | 6.8 (2.1%) | 39.2 | 0.45 | 293.2, 336.8 / 328.4, 315.1 |  |
| recorder / daemon fast path / clean, 0 tools / stopToRecordVisible | time | 315.2 ms | 321.9 | 6.7 (2.1%) | 39.2 | 0.45 | 293.4, 337 / 328.6, 315.2 |  |
| recorder / daemon fast path / clean, 5 tools / toolEvent | time | 31.7 ms | 35.8 | 4.1 (12.8%) | 5 | 0.00000457 | 31.5, 31.9 / 36.7, 34.8 |  |
| recorder / daemon fast path / clean, 5 tools / stop | time | 307.8 ms | 316.3 | 8.6 (2.8%) | 30.8 | 0.0587 | 314.3, 301.2 / 304.1, 328.5 |  |
| recorder / daemon fast path / clean, 5 tools / stopToRecordVisible | time | 307.9 ms | 316.5 | 8.6 (2.8%) | 30.8 | 0.0588 | 314.4, 301.4 / 304.2, 328.7 |  |
| recorder / daemon fast path / clean, 30 tools / toolEvent | time | 36.2 ms | 35.5 | -0.6 (-1.8%) | 5 | 0.16 | 35, 37.3 / 36.8, 34.2 |  |
| recorder / daemon fast path / clean, 30 tools / stop | time | 331.7 ms | 369.3 | 37.5 (11.3%) | 37.2 | 0.0191 | 321.3, 342.1 / 361.7, 376.8 | p=0.0191 >= 0.01 |
| recorder / daemon fast path / clean, 30 tools / hookTotalPerTurn | time | 2730.9 ms | 2892.1 | 161.3 (5.9%) | 273.1 | 0.112 | 2625.9, 2835.8 / 2918.2, 2866.1 |  |
| recorder / daemon fast path / clean, 30 tools / stopToRecordVisible | time | 331.8 ms | 369.4 | 37.6 (11.3%) | 37.2 | 0.0191 | 321.4, 342.2 / 361.9, 376.9 | p=0.0191 >= 0.01 |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / toolEvent | time | 36.7 ms | 37.5 | 0.8 (2%) | 5.2 | 0.157 | 38, 35.4 / 36.7, 38.2 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stop | time | 521.3 ms | 574.2 | 52.9 (10.1%) | 52.1 | 0.345 | 542.8, 499.9 / 598.4, 550 | p=0.345 >= 0.01 |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stopToRecordVisible | time | 521.6 ms | 574.5 | 52.9 (10.1%) | 52.2 | 0.345 | 543, 500.1 / 598.7, 550.2 | p=0.345 >= 0.01 |
| recorder / CLI fallback / clean, 0 tools / stop | time | 620.1 ms | 637.2 | 17 (2.7%) | 62 | 0.496 | 612, 628.2 / 643.8, 630.5 |  |
| recorder / CLI fallback / clean, 0 tools / stopToRecordVisible | time | 620.3 ms | 637.4 | 17.1 (2.7%) | 62 | 0.496 | 612.2, 628.4 / 644, 630.7 |  |
| recorder / CLI fallback / clean, 5 tools / toolEvent | time | 267.5 ms | 270.2 | 2.6 (1%) | 31.4 | 0.977 | 264.4, 270.6 / 270.7, 269.6 |  |
| recorder / CLI fallback / clean, 5 tools / stop | time | 641.9 ms | 597.8 | -44.1 (-6.9%) | 64.2 | 0.151 | 637.9, 645.9 / 577.9, 617.6 |  |
| recorder / CLI fallback / clean, 5 tools / hookTotalPerTurn | time | 3982 ms | 4022 | 40.1 (1%) | 398.2 | 0.705 | 3981, 3982.9 / 4009.9, 4034.1 |  |
| recorder / CLI fallback / clean, 5 tools / stopToRecordVisible | time | 642.2 ms | 598 | -44.2 (-6.9%) | 64.2 | 0.151 | 638.2, 646.1 / 578.1, 617.9 |  |
| recorder / CLI fallback / clean, 30 tools / toolEvent | time | 277.9 ms | 274.2 | -3.7 (-1.3%) | 27.8 | 0.651 | 285.8, 270 / 272.2, 276.2 |  |
| recorder / CLI fallback / clean, 30 tools / stop | time | 618.3 ms | 630.3 | 12 (1.9%) | 112 | 0.88 | 609.4, 627.1 / 635.6, 624.9 |  |
| recorder / CLI fallback / clean, 30 tools / hookTotalPerTurn | time | 18499.5 ms | 18462.9 | -36.5 (-0.2%) | 1849.9 | 0.65 | 18802, 18196.9 / 18388.8, 18537 |  |
| recorder / CLI fallback / clean, 30 tools / stopToRecordVisible | time | 618.5 ms | 630.5 | 12 (1.9%) | 112 | 0.88 | 609.7, 627.3 / 635.8, 625.2 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / toolEvent | time | 284.8 ms | 294.5 | 9.7 (3.4%) | 29.8 | 0.0459 | 292.9, 276.6 / 292.2, 296.7 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stop | time | 804.8 ms | 889.5 | 84.7 (10.5%) | 80.5 | 0.151 | 834.6, 774.9 / 905.8, 873.1 | p=0.151 >= 0.01 |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / hookTotalPerTurn | time | 4366.6 ms | 4680.2 | 313.6 (7.2%) | 436.7 | 0.0025 | 4531.8, 4201.3 / 4601.7, 4758.6 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stopToRecordVisible | time | 805 ms | 889.7 | 84.6 (10.5%) | 80.5 | 0.151 | 834.9, 775.1 / 906, 873.3 | p=0.151 >= 0.01 |
| recorder / daemon / rssMiB.afterWarmup | resource | 76 MiB | 76 | 0 (0%) | 7.6 | – | 76, 76 / 76, 76 |  |
| recorder / daemon / rssMiB.afterRun | resource | 80.5 MiB | 80.5 | 0 (0%) | 8.1 | – | 81, 80 / 80, 81 |  |
| recorder / daemon / rssMiB.after30sIdle | resource | 80.5 MiB | 80.5 | 0 (0%) | 8.1 | – | 81, 80 / 80, 81 |  |
| recorder / daemon / cpuSecondsIn30sIdle | resource | 0 s | 0 | 0 | 0 | – | 0, 0 / 0, 0 |  |
| recorder / disk / kibPerRecord | resource | 79 KiB | 79 | 0 (0%) | 7.9 | – | 79, 79 / 79, 79 |  |

## 仅供参考（派生指标，不参与判定）（0）

无

相同的计数 18 项未列出。只能宣称已达到的级别：计数变好是 L1，受控耗时变好是 L2；日常使用（L3）需要发布后另行对比。
