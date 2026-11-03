# 性能 A/B：NO CLEAR CHANGE

基线 2 份、候选 2 份。计数（L1）任何增加即变差。耗时/资源（L2）要同时满足才算变化：幅度至少为基线的 10%、5 ms（仅耗时）；候选每次运行都落在基线每次运行的同一侧；有原始样本时 Mann-Whitney 检验 p < 0.01。测不到的不算通过。

汇总：变好 0（计数 0，耗时 0）；变差 0（未豁免 0）；计数不稳定 0；无明确变化 81；相同 69；测不到 8

## 阶段

```json
{
  "recorder": {
    "compared": true,
    "base": [
      "baseline-2026-11-03T17-20-23-498Z.json",
      "baseline-2026-11-03T17-41-05-860Z.json"
    ],
    "cand": [
      "baseline-2026-11-03T17-27-25-236Z.json",
      "baseline-2026-11-03T17-34-10-538Z.json"
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
  },
  "hookwrap": {
    "compared": true,
    "base": [
      "baseline-2026-11-03T17-20-23-498Z.json",
      "baseline-2026-11-03T17-41-05-860Z.json"
    ],
    "cand": [
      "baseline-2026-11-03T17-27-25-236Z.json",
      "baseline-2026-11-03T17-34-10-538Z.json"
    ],
    "excluded": [],
    "versions": {
      "base": {
        "scry": [
          "0.2.52"
        ],
        "uploader": [
          "0.2.7"
        ]
      },
      "cand": {
        "scry": [
          "0.2.52"
        ],
        "uploader": [
          "0.2.7"
        ]
      }
    }
  }
}
```

## 变差（0）

无

## 计数不稳定（0）

无

## 变好（0）

无

## 测不到（8）

| 指标 | 类别 | 基线 | 候选 | 变化 | 需要超过 | p | 各次（基线 / 候选） | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| recorder / daemon fast path / clean, 0 tools / toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: no tool events in this scenario; baseline-2026-11-03T17-41-05-860Z.json: no tool events in this scenario; baseline-2026-11-03T17-27-25-236Z.json: no tool events in this scenario; baseline-2026-11-03T17-34-10-538Z.json: no tool events in this scenario |
| recorder / CLI fallback / clean, 0 tools / toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: no tool events in this scenario; baseline-2026-11-03T17-41-05-860Z.json: no tool events in this scenario; baseline-2026-11-03T17-27-25-236Z.json: no tool events in this scenario; baseline-2026-11-03T17-34-10-538Z.json: no tool events in this scenario |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: no tool events in this scenario; baseline-2026-11-03T17-41-05-860Z.json: no tool events in this scenario; baseline-2026-11-03T17-27-25-236Z.json: no tool events in this scenario; baseline-2026-11-03T17-34-10-538Z.json: no tool events in this scenario |
| hookwrap / daemon fast path / clean, 0 tools / plain.toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: no tool events in this scenario; baseline-2026-11-03T17-41-05-860Z.json: no tool events in this scenario; baseline-2026-11-03T17-27-25-236Z.json: no tool events in this scenario; baseline-2026-11-03T17-34-10-538Z.json: no tool events in this scenario |
| hookwrap / daemon fast path / clean, 0 tools / overhead.toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: plain unavailable, wrapped unavailable; baseline-2026-11-03T17-41-05-860Z.json: plain unavailable, wrapped unavailable; baseline-2026-11-03T17-27-25-236Z.json: plain unavailable, wrapped unavailable; baseline-2026-11-03T17-34-10-538Z.json: plain unavailable, wrapped unavailable |
| hookwrap / CLI fallback / clean, 0 tools / wrapped.toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: no tool events in this scenario; baseline-2026-11-03T17-41-05-860Z.json: no tool events in this scenario; baseline-2026-11-03T17-27-25-236Z.json: no tool events in this scenario; baseline-2026-11-03T17-34-10-538Z.json: no tool events in this scenario |
| hookwrap / CLI fallback / clean, 0 tools / plain.toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: no tool events in this scenario; baseline-2026-11-03T17-41-05-860Z.json: no tool events in this scenario; baseline-2026-11-03T17-27-25-236Z.json: no tool events in this scenario; baseline-2026-11-03T17-34-10-538Z.json: no tool events in this scenario |
| hookwrap / CLI fallback / clean, 0 tools / overhead.toolEvent |  |   |  |  |  | – |  /  | baseline-2026-11-03T17-20-23-498Z.json: plain unavailable, wrapped unavailable; baseline-2026-11-03T17-41-05-860Z.json: plain unavailable, wrapped unavailable; baseline-2026-11-03T17-27-25-236Z.json: plain unavailable, wrapped unavailable; baseline-2026-11-03T17-34-10-538Z.json: plain unavailable, wrapped unavailable |

## 无明确变化（81）

| 指标 | 类别 | 基线 | 候选 | 变化 | 需要超过 | p | 各次（基线 / 候选） | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| recorder / daemon fast path / clean, 0 tools / turnStart | time | 235.5 ms | 206.9 | -28.6 (-12.1%) | 23.6 | 0.0588 | 220.8, 250.2 / 192.4, 221.4 | runs overlap; p=0.0588 >= 0.01 |
| recorder / daemon fast path / clean, 0 tools / stop | time | 330 ms | 310.5 | -19.6 (-5.9%) | 33 | 0.00815 | 321.2, 338.9 / 305.4, 315.5 |  |
| recorder / daemon fast path / clean, 0 tools / hookTotalPerTurn | time | 588.9 ms | 525.2 | -63.8 (-10.8%) | 58.9 | 0.0156 | 564.2, 613.6 / 509.2, 541.1 | p=0.0156 >= 0.01 |
| recorder / daemon fast path / clean, 0 tools / stopToRecordVisible | time | 330.2 ms | 310.7 | -19.6 (-5.9%) | 33 | 0.00815 | 321.4, 339 / 305.7, 315.6 |  |
| recorder / daemon fast path / clean, 5 tools / turnStart | time | 242.7 ms | 218.9 | -23.7 (-9.8%) | 24.3 | 0.199 | 237.9, 247.4 / 224.8, 213 |  |
| recorder / daemon fast path / clean, 5 tools / toolEvent | time | 36.1 ms | 38.4 | 2.4 (6.5%) | 5 | 0.479 | 35.2, 36.9 / 34.8, 42 |  |
| recorder / daemon fast path / clean, 5 tools / stop | time | 323 ms | 316.6 | -6.3 (-2%) | 32.3 | 0.88 | 313.9, 332 / 281.5, 351.7 |  |
| recorder / daemon fast path / clean, 5 tools / hookTotalPerTurn | time | 941.1 ms | 924 | -17.1 (-1.8%) | 94.1 | 0.88 | 915.8, 966.3 / 870.4, 977.5 |  |
| recorder / daemon fast path / clean, 5 tools / stopToRecordVisible | time | 323.3 ms | 316.8 | -6.5 (-2%) | 32.3 | 0.88 | 314.2, 332.3 / 281.6, 351.9 |  |
| recorder / daemon fast path / clean, 30 tools / turnStart | time | 230.3 ms | 249.9 | 19.7 (8.5%) | 23 | 0.29 | 226.9, 233.6 / 253.9, 245.9 |  |
| recorder / daemon fast path / clean, 30 tools / toolEvent | time | 36.3 ms | 36.7 | 0.5 (1.2%) | 5 | 0.0663 | 34.5, 38 / 35.3, 38.1 |  |
| recorder / daemon fast path / clean, 30 tools / stop | time | 328.8 ms | 347.4 | 18.6 (5.7%) | 32.9 | 0.151 | 314.4, 343.2 / 338.2, 356.6 |  |
| recorder / daemon fast path / clean, 30 tools / hookTotalPerTurn | time | 2726 ms | 2838.1 | 112.1 (4.1%) | 272.6 | 0.364 | 2603.4, 2848.6 / 2769.7, 2906.4 |  |
| recorder / daemon fast path / clean, 30 tools / stopToRecordVisible | time | 328.9 ms | 347.5 | 18.6 (5.7%) | 32.9 | 0.151 | 314.5, 343.3 / 338.4, 356.7 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / turnStart | time | 253.6 ms | 237.2 | -16.4 (-6.5%) | 25.4 | 0.29 | 249.6, 257.6 / 232.4, 242 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / toolEvent | time | 32.7 ms | 35.3 | 2.6 (8%) | 5 | 0.00358 | 32.5, 32.9 / 34, 36.6 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stop | time | 519.1 ms | 524.3 | 5.2 (1%) | 51.9 | 0.762 | 488.1, 550 / 447.5, 601 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / hookTotalPerTurn | time | 1096.9 ms | 1146.2 | 49.3 (4.5%) | 109.7 | 0.545 | 1058.7, 1135.1 / 1049.7, 1242.6 |  |
| recorder / daemon fast path / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stopToRecordVisible | time | 519.2 ms | 524.4 | 5.1 (1%) | 51.9 | 0.762 | 488.3, 550.1 / 447.6, 601.1 |  |
| recorder / CLI fallback / clean, 0 tools / turnStart | time | 520.6 ms | 485.6 | -34.9 (-6.7%) | 52.1 | 0.151 | 553.4, 487.7 / 486.1, 485.1 |  |
| recorder / CLI fallback / clean, 0 tools / stop | time | 574.6 ms | 591.8 | 17.2 (3%) | 57.5 | 0.496 | 574.3, 574.9 / 581.5, 602.1 |  |
| recorder / CLI fallback / clean, 0 tools / hookTotalPerTurn | time | 1103.4 ms | 1074.1 | -29.3 (-2.7%) | 110.3 | 0.406 | 1144.3, 1062.6 / 1062.5, 1085.7 |  |
| recorder / CLI fallback / clean, 0 tools / stopToRecordVisible | time | 574.8 ms | 592 | 17.3 (3%) | 57.5 | 0.496 | 574.4, 575.1 / 581.8, 602.2 |  |
| recorder / CLI fallback / clean, 5 tools / turnStart | time | 555.5 ms | 528.9 | -26.6 (-4.8%) | 55.6 | 0.496 | 566.3, 544.7 / 517.2, 540.5 |  |
| recorder / CLI fallback / clean, 5 tools / toolEvent | time | 283.3 ms | 267.6 | -15.7 (-5.5%) | 28.3 | 0.00133 | 277, 289.5 / 254.9, 280.2 |  |
| recorder / CLI fallback / clean, 5 tools / stop | time | 636 ms | 641.8 | 5.8 (0.9%) | 63.6 | 0.821 | 620.7, 651.2 / 627.2, 656.4 |  |
| recorder / CLI fallback / clean, 5 tools / hookTotalPerTurn | time | 4091.8 ms | 3936.3 | -155.5 (-3.8%) | 409.2 | 0.226 | 3973.5, 4210.1 / 3780, 4092.6 |  |
| recorder / CLI fallback / clean, 5 tools / stopToRecordVisible | time | 636.2 ms | 642 | 5.8 (0.9%) | 63.6 | 0.821 | 620.9, 651.5 / 627.4, 656.6 |  |
| recorder / CLI fallback / clean, 30 tools / turnStart | time | 590.1 ms | 519.3 | -70.7 (-12%) | 59 | 0.257 | 541.6, 638.5 / 521.3, 517.3 | p=0.257 >= 0.01 |
| recorder / CLI fallback / clean, 30 tools / toolEvent | time | 278.5 ms | 268.9 | -9.6 (-3.5%) | 27.9 | 1.19e-9 | 280.4, 276.6 / 264.1, 273.6 |  |
| recorder / CLI fallback / clean, 30 tools / stop | time | 633 ms | 577 | -56 (-8.9%) | 63.3 | 0.199 | 661.3, 604.7 / 583, 570.9 |  |
| recorder / CLI fallback / clean, 30 tools / hookTotalPerTurn | time | 18282.7 ms | 17461.5 | -821.2 (-4.5%) | 1828.3 | 0.0412 | 18172.3, 18393.1 / 16944.4, 17978.6 |  |
| recorder / CLI fallback / clean, 30 tools / stopToRecordVisible | time | 633.3 ms | 577.3 | -56 (-8.8%) | 63.3 | 0.199 | 661.5, 605 / 583.4, 571.2 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / turnStart | time | 584.3 ms | 547.1 | -37.2 (-6.4%) | 58.4 | 0.0191 | 596.4, 572.1 / 514.6, 579.5 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / toolEvent | time | 287 ms | 272.1 | -14.9 (-5.2%) | 28.7 | 0.00388 | 287.1, 286.9 / 262.7, 281.5 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stop | time | 830.2 ms | 839.1 | 8.9 (1.1%) | 83 | 0.29 | 835.3, 825 / 753.9, 924.2 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / hookTotalPerTurn | time | 4281.6 ms | 4163 | -118.6 (-2.8%) | 428.2 | 0.199 | 4339.3, 4223.9 / 3916.3, 4409.7 |  |
| recorder / CLI fallback / dirty (20 modified + 50 new files + 3 nested repos), 5 tools / stopToRecordVisible | time | 830.4 ms | 839.2 | 8.8 (1.1%) | 83 | 0.29 | 835.6, 825.2 / 754.1, 924.3 |  |
| recorder / daemon / rssMiB.afterWarmup | resource | 76 MiB | 76 | 0 (0%) | 7.6 | – | 76, 76 / 76, 76 |  |
| recorder / daemon / rssMiB.afterRun | resource | 80 MiB | 80 | 0 (0%) | 8 | – | 80, 80 / 80, 80 |  |
| recorder / daemon / rssMiB.after30sIdle | resource | 80 MiB | 80 | 0 (0%) | 8 | – | 80, 80 / 80, 80 |  |
| recorder / daemon / cpuSecondsDuringRun | resource | 14 s | 14 | 0 (0%) | 2 | – | 13, 15 / 13, 15 |  |
| recorder / daemon / cpuSecondsIn30sIdle | resource | 0 s | 0 | 0 | 0 | – | 0, 0 / 0, 0 |  |
| recorder / disk / kibPerRecord | resource | 79 KiB | 79 | 0 (0%) | 7.9 | – | 79, 79 / 79, 79 |  |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.turnStart | time | 724.8 ms | 873.4 | 148.6 (20.5%) | 72.5 | 0.0588 | 737.9, 711.7 / 949.6, 797.2 | p=0.0588 >= 0.01 |
| hookwrap / daemon fast path / clean, 0 tools / plain.turnStart | time | 195.8 ms | 177.1 | -18.7 (-9.6%) | 19.6 | 0.762 | 167.7, 223.9 / 173.2, 181 |  |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.stop | time | 826.3 ms | 824.8 | -1.5 (-0.2%) | 82.6 | 0.88 | 727.2, 925.3 / 861.7, 787.9 |  |
| hookwrap / daemon fast path / clean, 0 tools / plain.stop | time | 283.5 ms | 254 | -29.6 (-10.4%) | 28.4 | 0.226 | 257.7, 309.4 / 259.7, 248.2 | runs overlap; p=0.226 >= 0.01 |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.hookTotalPerTurn | time | 1577.6 ms | 1670.9 | 93.4 (5.9%) | 157.8 | 0.174 | 1527.1, 1628 / 1854.5, 1487.3 |  |
| hookwrap / daemon fast path / clean, 0 tools / plain.hookTotalPerTurn | time | 476.5 ms | 436.7 | -39.9 (-8.4%) | 47.7 | 0.496 | 419.3, 533.7 / 433.6, 439.7 |  |
| hookwrap / daemon fast path / clean, 0 tools / wrapped.stopToRecordVisible | time | 826.4 ms | 825 | -1.4 (-0.2%) | 82.6 | 0.88 | 727.3, 925.5 / 861.9, 788 |  |
| hookwrap / daemon fast path / clean, 0 tools / plain.stopToRecordVisible | time | 283.7 ms | 254.4 | -29.3 (-10.3%) | 28.4 | 0.226 | 257.9, 309.5 / 259.9, 248.9 | runs overlap; p=0.226 >= 0.01 |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.turnStart | time | 475.5 ms | 525.1 | 49.6 (10.4%) | 47.5 | 0.94 | 443.4, 507.5 / 548.4, 501.7 | runs overlap; p=0.94 >= 0.01 |
| hookwrap / daemon fast path / clean, 5 tools / plain.turnStart | time | 178.5 ms | 175.9 | -2.6 (-1.4%) | 17.8 | 0.29 | 176.5, 180.4 / 192.1, 159.7 |  |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.toolEvent | time | 41.6 ms | 45.7 | 4.1 (9.9%) | 5 | 0.0785 | 39.5, 43.7 / 46.6, 44.8 |  |
| hookwrap / daemon fast path / clean, 5 tools / plain.toolEvent | time | 34 ms | 33.4 | -0.6 (-1.8%) | 5 | 0.72 | 31.9, 36 / 33.7, 33 |  |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.stop | time | 436.2 ms | 453.4 | 17.2 (3.9%) | 43.6 | 0.364 | 435.6, 436.7 / 477.4, 429.3 |  |
| hookwrap / daemon fast path / clean, 5 tools / plain.stop | time | 261 ms | 260.6 | -0.4 (-0.2%) | 26.1 | 1 | 255, 267 / 250.1, 271.1 |  |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.hookTotalPerTurn | time | 1335.9 ms | 1456.1 | 120.2 (9%) | 133.6 | 0.597 | 1289.5, 1382.2 / 1527.4, 1384.7 |  |
| hookwrap / daemon fast path / clean, 5 tools / plain.hookTotalPerTurn | time | 780.7 ms | 766.3 | -14.5 (-1.9%) | 78.1 | 0.597 | 751.1, 810.3 / 757, 775.5 |  |
| hookwrap / daemon fast path / clean, 5 tools / wrapped.stopToRecordVisible | time | 436.4 ms | 453.5 | 17.1 (3.9%) | 43.6 | 0.364 | 435.9, 436.8 / 477.6, 429.4 |  |
| hookwrap / daemon fast path / clean, 5 tools / plain.stopToRecordVisible | time | 261.2 ms | 260.7 | -0.5 (-0.2%) | 26.1 | 1 | 255.2, 267.2 / 250.2, 271.2 |  |
| hookwrap / CLI fallback / clean, 0 tools / wrapped.turnStart | time | 721.5 ms | 720.2 | -1.4 (-0.2%) | 72.2 | 0.762 | 694.8, 748.2 / 759.5, 680.8 |  |
| hookwrap / CLI fallback / clean, 0 tools / plain.turnStart | time | 445.7 ms | 432.5 | -13.2 (-3%) | 44.6 | 0.326 | 414.9, 476.5 / 472.7, 392.2 |  |
| hookwrap / CLI fallback / clean, 0 tools / wrapped.stop | time | 1026.8 ms | 1031.7 | 4.9 (0.5%) | 102.7 | 0.88 | 999.1, 1054.4 / 1078.9, 984.4 |  |
| hookwrap / CLI fallback / clean, 0 tools / plain.stop | time | 574.1 ms | 559.5 | -14.5 (-2.5%) | 57.4 | 0.597 | 525.1, 623 / 578.5, 540.5 |  |
| hookwrap / CLI fallback / clean, 0 tools / wrapped.hookTotalPerTurn | time | 1760.6 ms | 1706.6 | -54 (-3.1%) | 176.1 | 1 | 1708.1, 1813 / 1810.8, 1602.3 |  |
| hookwrap / CLI fallback / clean, 0 tools / plain.hookTotalPerTurn | time | 1019.8 ms | 986.9 | -32.9 (-3.2%) | 102 | 0.151 | 940, 1099.5 / 1054.4, 919.3 |  |
| hookwrap / CLI fallback / clean, 0 tools / wrapped.stopToRecordVisible | time | 1026.9 ms | 1031.9 | 4.9 (0.5%) | 102.7 | 0.88 | 999.2, 1054.6 / 1079.1, 984.6 |  |
| hookwrap / CLI fallback / clean, 0 tools / plain.stopToRecordVisible | time | 574.3 ms | 559.8 | -14.5 (-2.5%) | 57.4 | 0.597 | 525.3, 623.2 / 578.8, 540.7 |  |
| hookwrap / CLI fallback / clean, 5 tools / wrapped.turnStart | time | 706.8 ms | 681.5 | -25.2 (-3.6%) | 70.7 | 0.705 | 749.5, 664 / 686.7, 676.3 |  |
| hookwrap / CLI fallback / clean, 5 tools / plain.turnStart | time | 448.3 ms | 398 | -50.3 (-11.2%) | 44.8 | 0.0156 | 480.9, 415.7 / 392.4, 403.5 | p=0.0156 >= 0.01 |
| hookwrap / CLI fallback / clean, 5 tools / wrapped.toolEvent | time | 256.4 ms | 241 | -15.4 (-6%) | 25.6 | 0.000584 | 259.7, 253 / 241.6, 240.3 |  |
| hookwrap / CLI fallback / clean, 5 tools / plain.toolEvent | time | 233.7 ms | 220.3 | -13.3 (-5.7%) | 23.4 | 0.00235 | 232.1, 235.2 / 220.8, 219.8 |  |
| hookwrap / CLI fallback / clean, 5 tools / wrapped.stop | time | 966.5 ms | 932.3 | -34.2 (-3.5%) | 96.6 | 0.406 | 952.9, 980 / 943.3, 921.3 |  |
| hookwrap / CLI fallback / clean, 5 tools / plain.stop | time | 535.8 ms | 529.8 | -6.1 (-1.1%) | 53.6 | 0.364 | 545.3, 526.4 / 519.5, 540 |  |
| hookwrap / CLI fallback / clean, 5 tools / wrapped.hookTotalPerTurn | time | 4245.4 ms | 4128.5 | -116.8 (-2.8%) | 424.5 | 0.0963 | 4291.7, 4199 / 4146.4, 4110.7 |  |
| hookwrap / CLI fallback / clean, 5 tools / plain.hookTotalPerTurn | time | 3346.8 ms | 3154.8 | -192 (-5.7%) | 334.7 | 0.0756 | 3355.8, 3337.8 / 3137.7, 3171.9 |  |
| hookwrap / CLI fallback / clean, 5 tools / wrapped.stopToRecordVisible | time | 966.7 ms | 932.6 | -34.1 (-3.5%) | 96.7 | 0.406 | 953.1, 980.2 / 943.5, 921.6 |  |
| hookwrap / CLI fallback / clean, 5 tools / plain.stopToRecordVisible | time | 536.1 ms | 529.9 | -6.2 (-1.2%) | 53.6 | 0.364 | 545.4, 526.8 / 519.6, 540.1 |  |
| hookwrap / wakeup launcher | time | 184.2 ms | 167.2 | -17 (-9.2%) | 18.4 | 0.507 | 160, 208.3 / 165.5, 168.8 |  |

## 仅供参考（派生指标，不参与判定）（18）

| 指标 | 类别 | 基线 | 候选 | 变化 | 需要超过 | p | 各次（基线 / 候选） | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hookwrap / daemon fast path / clean, 0 tools / overhead.turnStart | derived | 529 ms | 696.3 | 167.3 |  | – | 570.2, 487.8 / 776.4, 616.2 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 0 tools / overhead.stop | derived | 542.7 ms | 570.9 | 28.1 |  | – | 469.5, 615.9 / 602, 539.7 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 0 tools / overhead.hookTotalPerTurn | derived | 1101.1 ms | 1234.3 | 133.2 |  | – | 1107.8, 1094.3 / 1420.9, 1047.6 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 0 tools / overhead.stopToRecordVisible | derived | 542.7 ms | 570.6 | 27.8 |  | – | 469.4, 616 / 602, 539.1 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 5 tools / overhead.turnStart | derived | 297 ms | 349.2 | 52.1 |  | – | 266.9, 327.1 / 356.3, 342 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 5 tools / overhead.toolEvent | derived | 7.7 ms | 12.4 | 4.7 |  | – | 7.6, 7.7 / 12.9, 11.8 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 5 tools / overhead.stop | derived | 175.1 ms | 192.8 | 17.6 |  | – | 180.6, 169.7 / 227.3, 158.2 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 5 tools / overhead.hookTotalPerTurn | derived | 555.2 ms | 689.8 | 134.6 |  | – | 538.4, 571.9 / 770.4, 609.2 | derived from other metrics, not judged on its own |
| hookwrap / daemon fast path / clean, 5 tools / overhead.stopToRecordVisible | derived | 175.1 ms | 192.8 | 17.7 |  | – | 180.7, 169.6 / 227.4, 158.2 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 0 tools / overhead.turnStart | derived | 275.8 ms | 287.7 | 11.9 |  | – | 279.9, 271.7 / 286.8, 288.6 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 0 tools / overhead.stop | derived | 452.7 ms | 472.2 | 19.4 |  | – | 474, 431.4 / 500.4, 443.9 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 0 tools / overhead.hookTotalPerTurn | derived | 740.8 ms | 719.7 | -21.1 |  | – | 768.1, 713.5 / 756.4, 683 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 0 tools / overhead.stopToRecordVisible | derived | 452.7 ms | 472.1 | 19.5 |  | – | 473.9, 431.4 / 500.3, 443.9 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 5 tools / overhead.turnStart | derived | 258.5 ms | 283.6 | 25.1 |  | – | 268.6, 248.3 / 294.3, 272.8 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 5 tools / overhead.toolEvent | derived | 22.7 ms | 20.7 | -2.1 |  | – | 27.6, 17.8 / 20.8, 20.5 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 5 tools / overhead.stop | derived | 430.6 ms | 402.6 | -28.1 |  | – | 407.6, 453.6 / 423.8, 381.3 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 5 tools / overhead.hookTotalPerTurn | derived | 898.6 ms | 973.8 | 75.2 |  | – | 935.9, 861.2 / 1008.7, 938.8 | derived from other metrics, not judged on its own |
| hookwrap / CLI fallback / clean, 5 tools / overhead.stopToRecordVisible | derived | 430.6 ms | 402.7 | -27.8 |  | – | 407.7, 453.4 / 423.9, 381.5 | derived from other metrics, not judged on its own |

相同的计数 69 项未列出。只能宣称已达到的级别：计数变好是 L1，受控耗时变好是 L2；日常使用（L3）需要发布后另行对比。
