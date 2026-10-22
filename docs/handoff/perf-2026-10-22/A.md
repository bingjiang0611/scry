# 批次 A：主进程快修（#1、#2、#6a）

分支：`perf/handoff`（直接在此分支继续提交）。先读 [README.md](README.md) 的共同约束，再读 [review.md](review.md) 对应小节。

## A1（#1）进程身份采集不再同步扫全表

**先测**：为 `captureProcessIdentity` 增加计数/耗时观测（或受控基准），记录一次 Claude/Qoder 启动中 `ps` 调用次数与耗时，单独提交。

**改法方向**：只查询目标 PID（例如 `/bin/ps -o pid=,ppid=,stat=,lstart=,command= -p <pid>`，保持 `LC_ALL=C` 与 `lstart` 固定格式，使采集与复核格式一致）；改为异步并设超时。`agent-runner.ts:298` 的 `spawnClaudeCodeProcess` 与 `qoder.ts:369` 的 `spawnQoderCLIProcess` 都必须同步返回 child，因此身份应作为 Promise 保存：
- `agent-runner.ts:422-427` 强杀前 await 身份；
- Qoder 的 `onPid(child.pid, identity)` 回调与 abort 监听（`qoder.ts:378-380`）要改为接收/等待 Promise，并检查 `onPid` 的调用方。
- 仍在 spawn 后立即发起采集（进程存活时的启动时间才可作为核对基准）；进程在采集前已退出时，身份为未知，按红线处理。

**红线**
- 身份用于防止 PID/PGID 复用时误杀进程。发信号前必须拿到身份并复核；**身份未知、超时、采集失败 → 拒绝发信号**（现有语义，fail closed）。
- 采集与复核必须用同一种输出格式（`process-diagnostics.ts` 顶部注释）。
- `readProcessSnapshot` 的诊断用途（全表）保持不变，只改“单 PID 身份”路径。
- 覆盖 `qoder.ts:377` 与 `agent-runner.ts:314` 两处；检查是否还有其他调用点。

**测试**：`src/main/process-diagnostics.test.ts`、`src/main/agent-runner-options.test.ts`，Qoder 相关 focused；补一条回归：身份 Promise 未完成/失败时 stop 不发送信号。

## A2（#2）store 读缓存与避免重复写

**先测**：在一次“发送一轮 + 结束”的受控流程中计数 `app-store` 的文件读、写、fsync 次数（L1），单独提交。

**改法方向**
- `recentStore` / `projectStore` 改为单例，并像 `createAppSessionStore`（`app-store.ts:339-375`）一样以 `dev:ino:size:mtimeMs` 为键缓存读取结果。
- `record()` / `recordPending()`：结果与当前内容一致时不写。
- 可选：一轮内多次 record 若可安全合并再做；不确定就不做。

**红线**
- **不删除、不延后 fsync，不去掉 `.bak` 机制**；持久性降低需要用户另行同意。
- 缓存必须在外部修改（mtime/ino 变化）时失效；返回值仍是副本，调用方不能改到缓存。
- catalog health（ready/degraded/unavailable）语义不变。

**测试**：`src/main/app-store.test.ts`；补“外部改写文件后缓存失效”“内容不变不写”回归。

## A3（#6a）renderer 轮询在窗口隐藏时暂停

**范围**：`RemoteChat.tsx:472`、`useRemoteCatalogs.ts:75`、`useDesktopConnections.ts:30`、`RemotePairing.tsx:59`。

**先测**：受控场景下隐藏窗口 60 s 内各 IPC 调用次数（L1），单独提交。

**改法方向**：`document.hidden` 时停止定时器；`visibilitychange` 回到可见时立即刷新一次再恢复定时。保持“同一时刻只有一个请求”。共享一个可见性 hook 即可，不必每处各写一套。

**红线**
- 恢复可见时旧数据不能被当作当前事实：保留现有 loading/error 语义；连接状态、活动徽标在刷新完成前不得显示为“已确认在线”。
- RemotePairing 配对流程若有服务端超时依赖持续轮询，先确认再改；拿不准就跳过并在报告说明。
- 本次**只做暂停**，不改 trace 协议（那是批次 E）。

**测试**：受影响组件/hook 的单测；`npm run test:remote-queue-ui`、`node scripts/desktop-remote-ui-smoke.mjs`；完整 `npm run test:renderer:ui` 在提交前跑一次。

## 完成后

写 `reports/A.md`，更新 [STATUS.md](STATUS.md) 三行为 `待核验`，push `perf/handoff`。批次 B 等 A 核验通过后再开始。
