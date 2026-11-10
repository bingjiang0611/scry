# iOS remote local verification

Verdict: **fail**

| Rule | Required | Status | Detail |
|---|---|---|---|
| R1-checks | yes | pass | all ran stages passed; known-baseline: ios-checks (logs/control-base-ios-checks.tail.txt) |
| R2-netbench-clean:wifi-auto | yes | pass | failures=0 |
| R2-netbench-clean:wifi-relay | yes | pass | failures=0 |
| R3-transport:wifi-auto | yes | pass | multiplexed, all capabilities |
| R3-transport:wifi-relay | yes | pass | multiplexed, all capabilities |
| R4-relay-only | yes | pass | routes=relay |
| R5-direct | yes | blocked | the Mac advertised no LAN/overlay address: it is not on a local network the phone can share (check the LAN listener with lsof before accepting this) |
| R5b-no-blocking-unproven-route:wifi-auto | yes | pass | failed direct attempts on the open path=0 |
| R5b-no-blocking-unproven-route:wifi-relay | yes | pass | failed direct attempts on the open path=0 |
| R6-catalog:wifi-auto | yes | pass | confirmed 3/3; full=1061.3ms (31 sessions) refresh median=1289.5ms of 3 |
| R6-catalog:wifi-relay | yes | pass | confirmed 3/3; full=929.1ms (31 sessions) refresh median=810.3ms of 3 |
| R7-offline-fast | yes | fail | samples=2 allHostOffline=true slowestMs=3478 sample={"error":"Mac 当前不在线（中继未看到它的连接）：可能已休眠、断网或 Scry 未运行。唤醒 Mac 后会自动重连。","event":"offline-probe","hostOffline":true,"label":"wifi-auto","ms":3478} |
| I1-direct-vs-relay | no | info | warm median relay=1210.2ms direct=1022.7ms; cold median relay=2369.7ms auto=2459.3ms |
| I3-relay-path:mac | no | info | colos=ORD,PIT generations=heartbeat-aware median={"dns":3,"tcp":7.2,"tls":528.3,"upgrade":1561.9,"upgradeExcludingWait":961.9,"close":1562,"total":1562.1} |

| Scenario | Cold median/p90 ms | Warm median/p90 ms | Catalog full→refresh median ms | History ms | Routes | Colos | Phase medians ms |
|---|---|---|---|---|---|---|---|
| wifi-auto | 2459.3/2854.9 | 1022.7/2350.5 | 1061.3→1289.5 | 2679.3 | relay | ORD,PIT,EWR | {"tcpMs":8.102791,"outerTLSMs":729.843083,"upgradeMs":1189.743917,"innerTLSMs":2148.461,"pingMs":null,"totalMs":2148.480041} |
| wifi-relay | 2369.7/3742.8 | 1210.2/1530.1 | 929.1→810.3 | 2587.9 | relay | PIT,ORD,EWR | {"tcpMs":8.418458,"outerTLSMs":831.393583,"upgradeMs":1216.78025,"innerTLSMs":2148.677041,"pingMs":null,"totalMs":2148.691458} |
