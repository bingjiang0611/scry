# W12 · 部署 W10 的中继修复到线上

执行方 A。**维护者 2026-11-20 已授权**：把 `experiments/remote-g0/cf-relay/src/worker.js`（W10 提交 `c44c929d`，核验见 [reports/W10-review.md](../reports/W10-review.md)）部署到线上 `scry-relay` Worker。线上入口 `wss://scry-relay-pages.pages.dev` 经 service binding 转发到这个 Worker。

授权只覆盖这一次部署和一次按需回滚。不改 `wrangler.toml`、路由、secret、Pages 项目、Durable Object 迁移与地域设置。

## 部署前

1. 合并分支最新提交。确认自上次线上部署（`fcaf1c72`，2026-11-11）以来，`worker.js` 只有 `c44c929d` 这一次改动（`git log -- experiments/remote-g0/cf-relay/src/worker.js`）。如果还有其他改动，停下报告。
2. 在本地 workerd 上再跑一次 `npm --prefix experiments/remote-g0 run smoke:cf` 与 `node --test experiments/remote-g0/cf-relay-worker.test.mjs`，都要全部通过。
3. 用 `npx --prefix experiments/remote-g0 wrangler whoami` 确认已登录 Cloudflare。**没登录就停下，请维护者自己执行 `wrangler login`**：执行方不发起登录，也不打开浏览器。
4. 用 `wrangler deployments list` 记下当前线上版本 id，作为回滚目标，写进报告。
5. 先跑只读探针 `node experiments/remote-g0/relay-path-probe.mjs --samples=2`，记下部署前的基线。

## 部署

```
cd experiments/remote-g0/cf-relay && npx --prefix .. wrangler deploy
```

只部署这一次。如果输出提示要新增 Durable Object 迁移或修改配置，立即停下，不要确认。

## 部署后

1. 再跑一次只读探针（`--samples=2`），未知房间仍应返回 `4001 host_offline`。
2. 本机 App 与 iPhone 13（工作区 `~/scry-w1-ios-test`）：
   - 部署会让中继房间重建，确认主机在 30 s 内自动重连。
   - iPhone 侧栏没有告警，能发送一轮并收到回复。
   - 30 分钟后再发一轮，仍然正常。
3. **回滚条件**：主机 2 分钟内重连不上，或 iPhone 连续两次发送失败。满足任一条就执行 `wrangler rollback <部署前的版本 id>`，然后重复上面第 1、2 步确认恢复，并在报告里写明。

## 报告

写 `reports/W12.md`，第一行写状态。内容包括：
- 部署前后的版本 id。
- 两次探针的结果。
- 真机检查结果。
- 是否回滚。

部署 id 以外的账号信息（邮箱、账号 id）不写进仓库。
