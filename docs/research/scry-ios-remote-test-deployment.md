# G0 公网测试入口评估（未获部署/扣费授权）

2026-09-12。用户允许在自己的 iPhone 安装隔离 G0 测试 App，并选择“可评估付费测试资源”。这只授权评估，不授权现在开通、绑定支付或扣费。

## 候选：Render 单实例 Web Service

本次通过 curl 实际读取官方 [Pricing](https://render.com/pricing) 和 [WebSocket 文档](https://render.com/docs/websocket)：

- Hobby workspace：$0/月，另计 compute。
- 最小付费 compute：0.5 CPU / 512 MB，$7/月。
- 官方说明 compute 按秒折算；按 30 天估算，48 小时约 $0.47，未计税费或其他费用。
- Hobby 月度含 5 GB 带宽，超出 $0.15/GB；是否已有其他服务消耗额度，须登录用户指定账号后核对。
- 支持平台 HTTPS/WSS 入口，无固定 WebSocket 时长上限；维护、部署、网络故障仍会断开。每次连接可能被分配到不同实例，因此本次只考虑单实例，不宣称当前内存路由可横向扩容。

优点：可用托管域名/HTTPS，不先购买域名或运维整台服务器；适合只有加密 echo/配对的短期 G0 测试。缺口：未检查用户 Render 账号、支付要求、具体地区可用性、硬消费上限、平台 TLS/容量实测、大陆可达性，不承诺公网可用或固定总价。

## 拟议边界（创建前仍需用户确认）

- 仅一个 G0 测试服务，最长 48 小时；不用数据库、磁盘、autoscaling、生产域名或 Provider 凭证。
- 基础计算费目标低于 $1；总费用预算由用户确认，不能把应用限流当作平台账单硬上限。若无法满足用户给定的费用约束，不创建资源。
- **不能直接部署当前 `loopback-relay.mjs`**。必须先实现认证的短时路由票据、固定 host/device 绑定、重放/过期/限流/缓冲预算、退出与日志脱敏，并通过测试。
- 端到端 TLS 不降级；公网 relay 不持有宿主/设备私钥或配对秘密。测试期间不连接真实 workspace 或运行 Provider。
- 完成后通过平台暂停/删除服务，并读回确认无运行实例；仅进程退出或本地断连不代表停止计费。保留最小账单/清理回执，不留测试密钥。
- 部署前再次提交具体账号、区域、服务规格、成本风险和清理方式给用户确认。没有这次确认，不创建服务或推送代码到部署入口。

## 真机当前证据

系统有一个有效 Apple Development 签名身份；`devicectl` 能识别已登记物理 iPhone，但 2026-09-12 首次预检为 unavailable。已请求用户通过 USB 连接、解锁并完成信任/开发者模式。

签名证书存在不等于 provisioning、iPhone 安装或锁屏/蜂窝已通过。Personal Team 也不替代后续 APNs/TestFlight/App Store 所需的付费 Apple 开发者准备。

## 真机 → CF → Mac 端到端：已验证部分与真机 Runbook（2026 更新）

中继已上线（`wss://scry-relay.<...>.workers.dev`），设备侧已实现公网 wss 的 `.system` 外层 TLS 信任（系统根 + 主机名校验；内层 TLS 1.3 mTLS 仍固定 host anchor，是唯一信任根）。

### 沙箱内已验证（`smoke:cf-pair`）

`experiments/remote-g0/cf-relay-pair-smoke.mjs`：**真实 Swift iOS relay transport** 对 **实际 relay Worker + Durable Object 代码**（本地 `workerd`，与已部署构件字节一致）完成完整 **deny/pending/grant** 配对对话——经 reverse tunnel → 生产 `PairingTransport` → `PairingAuthority`，内层 TLS 1.3 mTLS 端到端，含 warm-pool 交会。回环无需代理，故这是沙箱内可达的最强证据。稳定通过（复跑两次）。

### 仍未验证（诚实边界，需真机 + 真实网络）

- **已部署公网边缘**：沙箱出网被强制走代理，生产 `createRelayConnectWS` 用全局 `WebSocket` 不穿代理，故无法从沙箱跑生产栈打到线上 CF。真机直连公网不受此限。
- 设备 `.system` 外层 TLS 对 Cloudflare 公共根的真实握手（已编译 + 解析自测，未对线上握手）。
- 物理 iPhone 上的人工扫码 / 确认；蜂窝、锁屏、APNs。
- 签名与 keychain entitlement 的真机形态（Personal Team 受限；完整路径需付费账号）。

### 真机 Runbook（在你自己的 Mac + iPhone 上，脱离本沙箱代理）

1. **Mac 宿主**（真实网络，直连公网）：
   ```sh
   SCRY_REMOTE_HOST=1 \
   SCRY_REMOTE_RELAY_WS='{"url":"wss://scry-relay.<subdomain>.workers.dev","token":"<RELAY_TOKEN>"}' \
   <启动 Scry>
   ```
   宿主会拨出 run/pair 两条 warm leg 到线上中继。`index.ts` 从该 URL 推导设备侧广告（`wss ⇒ tls:system`），无需另配。
2. 在 Scry 配对界面点“生成配对码”，得到 `scry1:` 码（内含中继坐标 + hostId + 一次性 secret + anchor PEM；仅在真的已拨号中继时才生成）。
3. **iPhone**（`apps/ios/ScryRemote`，签名安装）：扫码 → 设备用 `.system` 信任公网 wss 到达中继 → 内层 mTLS 到宿主 `PairingTransport` 完成 prove。
4. Mac 上核对指纹一致后确认；设备获得签发证书，之后经 run leg 走已授权操作。

