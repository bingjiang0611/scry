# MCP 安全扫描与认证执行方案

访问日期：2026-07-03

本文面向 scry 的第二个产品方向：**MCP 安全扫描与认证 / MCP 生态信任层**。结论先行：最稳的路径不是一上来做“官方认证平台”，而是先做一个开源、可本地运行、默认不信任任何 server 的 MCP 安全扫描 CLI；再把扫描结果、策略、审计、沙箱和认证标签逐步产品化为团队与企业可用的信任层。

## 0. 信息充分性清单

| 信息项 | 状态 | 依据 |
| --- | --- | --- |
| MCP 官方协议范围 | 已覆盖 | [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) 定义 tools/resources/prompts/sampling/elicitation/roots、JSON-RPC、传输、OAuth 授权等协议面。 |
| MCP 官方安全建议 | 已覆盖 | [Understanding Authorization in MCP](https://modelcontextprotocol.io/docs/tutorials/security/authorization) 与 [Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) 覆盖 token passthrough、session hijacking、confused deputy、SSRF、DNS rebinding、本地 server compromise、OAuth URL validation、scope minimization、stdio proxy 等风险。 |
| MCP Registry 的边界 | 已覆盖 | [MCP Registry about](https://modelcontextprotocol.io/registry/about) 说明 Registry 处于 preview，聚焦 server 元数据、命名空间与来源，安全扫描由包管理器或聚合器负责。 |
| MCP 专项安全分类 | 已覆盖 | [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) 覆盖 prompt injection、tool poisoning、权限过宽、凭证与网络暴露等 MCP 风险。 |
| 已有 MCP 扫描产品 | 已覆盖 | [Snyk Agent Scan](https://github.com/snyk/agent-scan)、[Cisco MCP Scanner](https://github.com/cisco-ai-defense/mcp-scanner)、[Ramparts](https://github.com/getjavelin/ramparts) 等已覆盖 MCP / agent component 扫描。 |
| 经典安全扫描生态 | 已覆盖 | [Semgrep](https://github.com/semgrep/semgrep)、[Trivy](https://github.com/aquasecurity/trivy)、[Gitleaks](https://github.com/gitleaks/gitleaks)、[OSV-Scanner](https://github.com/google/osv-scanner)、[OpenSSF Scorecard](https://github.com/ossf/scorecard)。 |
| LLM / Prompt injection 防护生态 | 已覆盖 | [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)、[OWASP Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)、[NVIDIA garak](https://github.com/NVIDIA/garak)、[Microsoft PyRIT](https://github.com/microsoft/PyRIT)。这些是可复用 red-team/eval 框架，不是 MCP server scanner。 |
| 企业化 MCP 网关/目录做法 | 已覆盖 | [Docker MCP Catalog and Toolkit](https://docs.docker.com/ai/mcp-catalog-and-toolkit/)、[Docker MCP Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/)、[Kong Enterprise MCP Gateway](https://konghq.com/blog/product-releases/enterprise-mcp-gateway)、[Kong MCP Tool ACLs](https://konghq.com/blog/product-releases/mcp-tool-acls-ai-gateway)。 |
| 策略、签名、供应链信任基础 | 已覆盖 | [Open Policy Agent](https://www.openpolicyagent.org/)、[Sigstore](https://www.sigstore.dev/)、[SLSA v1.2](https://slsa.dev/spec/v1.2/)。 |
| 产品/商业可落地性 | 已覆盖 | 明确第一年 beachhead ICP、MVP wedge、采购触发、部署模式、数据边界、PMF 闸门和定价假设。 |

缺口说明：本文没有引用付费报告、私有企业事故数据或官方 MCP 认证授权。所有“认证标签”均是产品侧 trust label 设计，不是 MCP 官方认证。

## 1. 核心判断

### 1.1 为什么这个方向成立

MCP 把 agent 和外部能力连接起来，风险不再只在模型输入输出，而在 **server 配置、tool 权限、命令执行、凭证注入、数据外传、依赖供应链、提示词与工具描述** 之间传播。传统 SAST/SCA/secret scanner 能覆盖一部分代码和依赖风险，但不理解 MCP 的核心对象：tool、resource、prompt、roots、sampling、elicitation、client-side consent / approval UI、server transport、OAuth client metadata、server command、环境变量和 agent 执行上下文。

官方 Registry 当前更像“可发现的 server 元数据层”，不是完整安全评估层。Registry 文档明确其目标是让 client 和 package registry 发现 MCP server，并把安全扫描责任交给 package manager、aggregator 或 installer。这意味着生态需要一个介于“package scanner”和“企业 AI gateway”之间的新层：**MCP-specific trust intelligence**。

### 1.2 不该怎么做

不要第一版就做云端认证市场。原因很硬：

1. 没有官方授权时，任何“认证”都只能是第三方标签，不能叫官方认证。
2. 企业采用前会先要求可解释扫描项、离线运行、CI 兼容、审计记录和可导出报告。
3. MCP server 的风险经常依赖本地配置、运行参数和 client 权限，不只是 npm/PyPI 包元数据。
4. MCP 生态仍在快速变化，过早绑定平台会让规则、schema、认证语义被协议演进打穿。

第一版应该像 `gitleaks`、`osv-scanner`、`trivy`、`scorecard` 一样：**本地、开源、可 CI、可解释、输出结构化结果**。云端是结果聚合和策略治理，不是扫描可信度的起点。

真正的 wedge 不是“又一个 MCP scanner”，而是：

> **open rules + deterministic local evidence + install-time policy gate + private registry admission workflow**。

这四件事共同构成差异化：规则公开、证据可复现、默认静态不执行 server、能作为企业私有 MCP registry / AI tool 准入门禁。

### 1.3 产品定位

一句话定位：

> MCPGuard 是面向正在引入 MCP 的研发组织 AppSec / Platform Security 团队的本地优先准入扫描工具：先用开源 CLI 产出可复现 evidence bundle，阻断高风险 MCP server 配置、tool 定义漂移、危险命令、敏感凭证和 prompt injection；再把这些 evidence 汇总成团队策略、审计、私有 registry admission 和第三方 trust attestation。

可替代名称：

- `mcpguard`
- `mcp-sentinel`
- `mcp-trust`
- `scry mcp audit`

本文使用 `mcpguard` 作为占位名。

## 2. 目标用户与任务

### 2.1 第一付费 ICP

第一年只打一个 beachhead：

> 100-2000 人研发组织中，已经允许或准备允许 Claude Code、Cursor、VS Code、Codex、Windsurf、Gemini CLI、Amazon Q 等 agent client 接入 MCP 的 AppSec / Platform Security 团队。

| 角色 | 任务 | 购买/采用触发 |
| --- | --- | --- |
| 日常使用者 | AppSec engineer、platform security engineer、developer productivity engineer。 | 发现员工本机或 CI 中接入未知 MCP server；准备开放 MCP registry；安全团队被要求给准入标准。 |
| 技术买家 | Head of AppSec、AI platform owner、developer platform lead。 | 需要 MCP inventory、policy-as-code、CI gate、审计证据和例外审批。 |
| 经济买家 | CISO / VP Engineering / Head of Platform。 | MCP 进入企业 AI 工具采购或内控范围，需要证明准入、审计和数据边界。 |
| 替代方案 | 手工审查 config、禁用 MCP、使用 Snyk/Cisco/Enkrypt/StepSecurity/Docker/Kong 等更宽产品。 | 如果只靠手工或禁用 MCP，开发效率受损；如果买大平台，成本/部署/数据出境门槛更高。 |

### 2.2 非第一付费对象

这些用户重要，但不是第一年付费 ICP：

- **MCP server 开发者**：作为开源 CLI 分发人群，使用 prepublish scan、CI check、报告和修复建议。
- **AI 工具 / Agent 平台团队**：作为集成伙伴，后续接 risk summary、policy decision API、audit event schema。
- **安全研究者**：贡献规则、fixture 和 bypass case。

这能避免 MVP 同时服务开发者 adoption、安全准入和平台 SDK 三条线。

### 2.3 核心任务

ICP 要完成的任务是：

- 建立本组织 MCP server inventory。
- 在安装或合并前阻断高风险 MCP 配置。
- 对例外审批保留可审计证据。
- 为私有 MCP registry / catalog 生成准入结果。
- 在不上传源码、secret 或 prompt 的前提下，把风险摘要汇总给团队。

## 3. 问题定义

### 3.1 要解决的核心问题

完整问题空间覆盖以下风险；当前 P1 只实现 7.4 表中标记“已实现”的本地静态规则，其余保留为路线图：

1. **MCP server 配置风险**：命令、参数、env、transport、网络 endpoint、workspace roots。
2. **tool 权限风险**：文件系统、shell、网络、数据库、浏览器、云资源、身份系统。
3. **危险命令与隐性执行风险**：`bash -c`、`python -c`、`curl | sh`、包管理器安装、容器挂载、shell glob、外部脚本。
4. **数据暴露风险**：env secrets、home 目录、SSH/Git 凭证、浏览器 profile、workspace 全读、日志与缓存。
5. **prompt injection / tool poisoning 风险**：tool/resource/prompt 描述中包含覆盖系统指令、诱导泄漏、隐藏指令、过宽描述。
6. **依赖与供应链风险**：CVE、恶意包、低维护度、未锁版本、无签名或 provenance。
7. **transport / 认证风险**：stdio env credential exposure、HTTP server 暴露在 `0.0.0.0`、缺少 Origin/Host 校验迹象、危险 OAuth URL scheme、过宽 scopes。token passthrough、session 绑定和 confused deputy 只有在源码、metadata 或 conformance test 有证据时才给 high；纯 config 推断降为 `possible` / medium。
8. **MCP 特有组合风险**：tool shadowing、tool definition drift / rug pull、toxic flow、tool output prompt injection、multi-server isolation。

第一阶段不解决：

- 不做真实官方认证。
- 不做法律合规背书。
- 不扫描企业私有 MCP 调用内容，除非用户主动提供本地日志文件。
- 不做生产 server 的主动攻击扫描。
- 不自动执行未信任 MCP server 的业务 tool。
- 不把静态证据不足的 OAuth/session 推断写成确定漏洞。

### 3.2 成功指标

CLI MVP 的成功不是“能扫所有漏洞”，而是：

1. 对本地 MCP client 配置和 server 包能生成稳定 JSON/SARIF 报告。
2. 对高危风险给出低误报 P0/P1 命中：shell wrapper、remote install、敏感 env 注入、home/root/workspace 全读、危险 HTTP 暴露、明显 prompt injection、tool definition drift。
3. 能在 CI 或私有 registry admission 中作为阻断门禁运行。
4. 规则结果可解释：每条 finding 有证据、置信度、影响、修复建议和可复现 rule version。
5. 不需要云账号、不上传代码、不默认执行 server。
6. 在 10 个真实组织配置样本中，至少发现 1 个被客户认可的 high-risk issue；否则说明 PMF 证据不足，不进入云端化。

## 4. 已有生态与空位

### 4.1 MCP 官方与基础设施

| 项目/来源 | 已有能力 | 对本方案的启发 | 空位 |
| --- | --- | --- | --- |
| MCP specification | 规定 tools/resources/prompts、sampling、roots、elicitation、authorization 等协议对象。 | 扫描器应把这些对象作为一等分析目标，而不是只扫 package。 | 规范本身不定义具体安全评分或第三方认证体系。 |
| MCP Registry | preview 阶段的 server 元数据 registry，强调 namespace trust、package metadata、ecosystem integration。 | 后续 trust feed 可和 registry 元数据、包来源、version 对齐。 | Registry 文档明确 security scanning 属于下游 installer/aggregator/host 责任。 |
| MCP Authorization / Security Best Practices | 对 token passthrough、session hijacking、confused deputy、SSRF、DNS rebinding、OAuth URL validation、stdio proxy、scope minimization 等给出要求。 | 认证/授权规则要按 transport 和证据等级拆分，不能把静态推断写成确定漏洞。 | 不能替代本地配置、tool 权限、tool drift、prompt 注入和运行期数据流检测。 |

### 4.2 MCP 专项安全工具

| 项目 | 已有能力 | 对本方案的压力 | 差异化必须更硬 |
| --- | --- | --- | --- |
| [Snyk Agent Scan](https://github.com/snyk/agent-scan) / [Invariant mcp-scan](https://github.com/invariantlabs-ai/mcp-scan) lineage | 扫描 AI agent、MCP server、tools/prompts/resources；支持大量 client/agent config discovery；README 对执行 stdio server command 有明确风险提示；企业侧已有 background / fleet 叙事。 | 不能再把“本地 CLI + MCP scan”当空位。 | 默认静态不执行、airgap 规则包、稳定 SARIF contract、公开 rule schema、可复现 evidence bundle、self-hosted policy engine。 |
| [Cisco MCP Scanner](https://github.com/cisco-ai-defense/mcp-scanner) | 面向 MCP server/tools 的 scanner，覆盖 tools/prompts/resources/server instructions、离线 JSON、REST API、多引擎、依赖漏洞等。 | 已覆盖“扫描 MCP 对象 + API”大块能力。 | 避免直接拼功能数量，转向 private registry admission、policy-as-code、evidence governance。 |
| [Ramparts](https://github.com/getjavelin/ramparts) | 扫描 MCP servers 和 agent skills，覆盖 prompt injection、tool poisoning、secret leakage、path traversal、command injection、cross-origin escalation、OSV CVE 等。 | 证明“agent skill + MCP”组合扫描已经有人做。 | scry 可聚焦“安装前准入 + 审计 + 私有 catalog”，不是单点漏洞枚举。 |
| [Proximity](https://www.helpnetsecurity.com/2025/10/29/proximity-open-source-mcp-security-scanner/) | 公开报道的开源 MCP scanner，枚举 prompts/tools/resources，并结合规则检测 prompt injection/jailbreak 等风险。 | 进一步证明“枚举 MCP 对象 + 检测描述风险”不是空位。 | 不把 tool enumeration 当 moat，转向 evidence bundle、policy gate、registry admission。 |
| [MCPProxy / smart-mcp-proxy](https://github.com/smart-mcp-proxy/mcpproxy-go) | 本地 MCP proxy + quarantine/security workflow；文档提供 scanner plugin system、Docker 化扫描、Cisco/Snyk/Ramparts/Proximity/Semgrep/Trivy 集成、SARIF 归一化、`security approve/reject`。 | 它已经很接近“准入流”，直接冲撞 install-time policy gate。 | 本方案必须避开 proxy/control-plane 正面战场，定位为独立 CLI/evidence bundle、开放 rule schema、默认静态不执行、airgap/self-host policy engine、scanner evidence standard。 |
| OWASP MCP Security Cheat Sheet | 不只是分类，还覆盖 tool definition hashing/pinning、rug pull、tool shadowing、message signing/replay、multi-server isolation、monitoring/audit、installation consent。 | 如果只引用 taxonomy，会漏掉最 MCP-specific 的 trust controls。 | 把 OWASP 控制点直接映射成 rule backlog 与 trust evidence 字段。 |
| OWASP ZAP MCP add-on / DAST 相邻能力 | 可作为动态/DAST 相邻案例，说明安全工具开始理解 MCP endpoint。 | 运行期扫描和 fuzz 不是 CLI 静态准入能覆盖的全部。 | P1 不抢动态 DAST，P3/P4 接入 gateway/runtime evidence。 |

### 4.3 通用扫描器与可复用能力

| 类别 | 代表项目 | 可复用做法 | 不能直接覆盖 |
| --- | --- | --- | --- |
| SAST / 规则扫描 | Semgrep | 规则以 YAML/AST pattern 表达；适合扫 server 源码、tool 描述、危险 API。 | 不理解本地 MCP client config 和 runtime approval。 |
| SCA / CVE | OSV-Scanner、Trivy | 对 lockfile、SBOM、container image、dependency graph 做漏洞映射。 | 不判断 tool schema、transport、roots、prompt injection。 |
| Secret scanning | Gitleaks、Trivy secret scan | 对 config/env/log/fixtures 扫 token、key、凭证模式。 | 不知道 secret 是否被注入 MCP server。 |
| OSS 信任健康 | OpenSSF Scorecard | repo 级维护健康、分支保护、依赖更新、CI、签名等信号。 | repo health 不是 server/tool 级风险。 |
| LLM red-team/eval | garak、Microsoft PyRIT、OWASP LLM Top 10 | prompt injection、jailbreak、tool misuse 的测试框架和语料。 | 它们不是 MCP server scanner，不能发现本地 config、server package trust、tool manifest drift。 |
| 策略引擎 | Open Policy Agent / Rego | 企业策略可表达为规则：禁止某类 server、tool、scope 或 transport。 | 需要 scanner 产出稳定 input schema。 |
| 供应链信任 | Sigstore、SLSA | 长期可接入签名、attestation、provenance 与构建等级。 | provenance 不能证明 tool 权限安全。 |

### 4.4 企业产品做法

| 产品/来源 | 已有做法 | 不正面硬拼的原因 | 本方案边界 |
| --- | --- | --- | --- |
| Docker MCP Catalog / Toolkit / Gateway | Catalog、Gateway、Toolkit；Gateway 侧重容器隔离、受限权限、网络访问、资源使用、logging/call tracing、server lifecycle、credential injection。 | Docker 站在 runtime/container 入口，强在运行和分发。 | 本方案先做准入扫描和 evidence，不抢 runtime gateway 第一入口。 |
| Kong Enterprise MCP Gateway / MCP Tool ACLs | MCP gateway、auth、policy/plugin engine、tool-level ACL/default-deny、OAuth/OIDC、traffic log、guardrail。 | Kong 站在 API gateway / enterprise gateway 入口。 | 本方案做 policy-as-code 输入、扫描报告、registry admission，可与 gateway 集成。 |
| Snyk Agent Scan / Evo | 安全厂商把 MCP/agent scan 放进 developer / endpoint workflow。 | 安全厂商有企业分发和 telemetry 优势。 | 差异化在 airgap/self-host、公开规则、deterministic evidence、私有 registry workflow。 |
| Cisco AI Defense / MCP Scanner | 直接 MCP scanner + 企业 AI defense 叙事。 | 覆盖扫描和企业产品两端。 | 以 open rules 和轻量 CI/registry gate 抢 developer trust。 |
| Enkrypt / Qualys / StepSecurity 等相邻产品 | 覆盖 agent/MCP security、endpoint telemetry、AI security posture 或 runtime policy。 | 平台化产品会吞掉泛泛 dashboard。 | 避免做泛 AI security posture，聚焦 MCP install-time admission。 |

### 4.5 竞品矩阵结论

| 能力轴 | 已有竞品强点 | 本方案应做 | 本方案不应做 |
| --- | --- | --- | --- |
| Client config discovery | Snyk/Invariant、StepSecurity 等已覆盖多 client。 | 支持主流 client，但只作为入口。 | 不把“发现 config”当核心 moat。 |
| 执行 server introspection | 多数工具会提示风险后执行或提供动态扫描。 | 默认静态，dynamic fail-closed experimental。 | 不默认执行未 pin server。 |
| Rules | 安全厂商规则通常不完全开放。 | 公开 rule schema、rule version、test fixtures。 | 不做黑盒神秘 trust score。 |
| Quarantine / approve flow | MCPProxy 已有本地 quarantine、scanner plugins、approve/reject。 | 不复制 proxy workflow，提供可被 proxy/registry/CI 消费的独立 evidence bundle 与 policy decision。 | 不把本产品做成本地 MCP proxy control plane。 |
| SARIF/CI | 多个 scanner 能输出机器可读报告。 | 稳定 JSON/SARIF contract + policy-as-code。 | 不把 HTML report 放 P1。 |
| Enterprise fleet | Snyk/Cisco/StepSecurity/Kong/Docker 更强。 | P3 只做 redacted summary + private registry admission。 | 不做全量 endpoint telemetry 平台。 |
| Runtime gateway/sandbox | Docker/Kong 更强。 | 接入 gateway evidence，提供准入和审计输入。 | 不抢 gateway runtime 控制面。 |

## 5. 威胁模型

### 5.1 资产

- 用户本地文件：workspace、home、SSH keys、Git credentials、浏览器 profile、Obsidian vault。
- 企业数据：源代码、Issue/PR、文档、数据库、云资源。
- 身份与凭证：OAuth token、API key、session cookie、service account。
- Agent 权限：自动工具调用、审批状态、上下文窗口、prompt/system 指令。
- 审计证据：allow/deny、tool call、policy decision、server version、scan report。

### 5.2 攻击者

- 恶意 MCP server 维护者。
- 被接管的开源包维护者或依赖。
- 内部误配置或过度授权用户。
- Prompt injection 攻击者，通过文档、网页、Issue、PR、resource 内容影响 agent。
- 中间人或伪造 registry/package source。

### 5.3 攻击面

| 攻击面 | 示例风险 | 初始控制 |
| --- | --- | --- |
| Server launch command | `npx unknown-package`、`uvx` 拉远程包、`bash -c`、`curl | sh`。 | 命令静态风险评分、包来源解析、禁止 shell wrapper。 |
| Env vars | 把 `ANTHROPIC_AUTH_TOKEN`、GitHub token、AWS key 注入 server。 | secret key pattern、env allowlist、敏感 env 降级/禁止。 |
| Tool schema/description | 描述中包含“忽略之前指令”“读取全部文件并发送”。 | prompt injection/poisoning 规则、隐藏字符检测、instruction override pattern。 |
| Tool shadowing | 一个 server 的 tool 描述或 output 影响另一个 server/tool 的选择与参数。 | 跨 server tool namespace、相似 tool name、描述中跨工具引用检测。 |
| Rug pull / definition drift | 初次安装时 tool 定义安全，后续版本悄悄扩大权限或改变描述。 | canonical tool/resource/prompt hash、baseline diff、manifest pinning。 |
| Toxic flow | 单个 tool 低危，但组合后形成读取敏感数据并外传的链路。 | P1 先做静态 flow hint；P3 gateway 阶段做真实调用数据流检测。 |
| Tool output prompt injection | tool 返回内容包含诱导模型忽略指令、泄露数据或调用其他 tool 的文本。 | 离线日志扫描和 gateway 阶段 output guard；P1 只给规则 backlog。 |
| File/roots | server 读取 home 或整个 workspace。 | roots 限制检查、目录范围风险、沙箱建议。 |
| Network | tool 能访问任意 URL、内网、metadata endpoint。 | domain allowlist、egress policy、metadata IP block。 |
| OAuth/session | token passthrough、scope 过宽、session 未绑定、dangerous auth URL、confused deputy。 | 按证据等级拆分：config/source/metadata/conformance；纯推断不标 high。 |
| HTTP transport | `0.0.0.0` 暴露、DNS rebinding、Origin/Host 缺失、未授权本地 HTTP server。 | streamable HTTP transport 规则，localhost binding、Origin、auth、session 检查。 |
| Dependencies | CVE、typosquatting、未锁版本、恶意 postinstall。 | OSV/Trivy/Semgrep/Gitleaks adapter。 |
| Runtime tool call | 高频调用、异常数据量、隐形 exfiltration。 | 云端阶段接 gateway/audit，CLI 阶段只做离线日志分析。 |

## 6. 产品路线

### P0：离线规则原型（1-2 周）

目标：证明 MCP-specific scanner 能稳定发现真实高风险配置。

输入：

- Claude Desktop / Cursor / VS Code / 自定义 MCP client 配置文件。
- server package manifest：`package.json`、`pyproject.toml`、`uv.lock`、`requirements.txt`、`Dockerfile`。
- server 源码目录。
- 可选：MCP Registry server metadata、GitHub repo URL。

输出：

- `mcpguard scan --format json`
- `mcpguard scan --format sarif`
- `mcpguard scan --fail-on high`

不做：

- 不执行 server。
- 不连接真实 OAuth。
- 不上传报告。

### P1：开源 CLI MVP（4-6 周）

P1 必须极窄，只做一个可交付 wedge：

> 扫本机 MCP config + command/env/root/tool description/tool definition hash 五类高置信规则 + JSON/SARIF + `--fail-on high`。

P1 不做 HTML report、Semgrep/OSV/Scorecard adapter、动态 introspection、trust feed、云端 dashboard。

核心能力：

1. **配置发现**
   - 自动发现 Claude Desktop、Claude Code、Cursor、VS Code、Codex、Windsurf、Gemini CLI、Amazon Q 等主流 agent/client 的 user/project/extension scope config。
   - 支持显式 `--config`、`--server-dir`、`--package`。
   - 输出 server inventory：name、command、args、env key names、transport、scope、source、version。
   - P1 当前实现中的 `--server-dir` 是浅层 inventory 入口：读取目录名 / `package.json.name` 并构造待扫描 target，不做源码 AST、依赖图或动态 server introspection。

2. **静态风险扫描**
   - command risk：shell wrapper、inline interpreter、`npx` / `uvx` / `bunx` / `npm exec` / `pnpm dlx` / `yarn dlx`、`curl|sh` / `wget|sh`。
   - secret risk：敏感 env key name、env literal token、命令参数里的 token/header、URL/package/repository 中的 credential。
   - filesystem risk：root/home/workspace 全读、filesystem server 的宽泛 roots、`~/.ssh` / `.aws` / `.kube` / browser profile / keychain 等敏感 home 子目录。
   - transport risk：HTTP/streamable HTTP 绑定 wildcard interface，例如 `0.0.0.0` 或 `[::]`。
   - tool definition risk：静态 manifest 或 baseline 中 tool canonical hash drift、tool description 的 prompt injection pattern。
   - 未实现但保留在路线图中的能力：container privileged/mount、wildcard env forwarding、network/browser/cloud/database capability 推断、HTTP auth/origin 证据、overbroad schema、tool shadowing、toxic flow、dependency CVE、source-level auth conformance。

3. **CI 与策略**
   - `mcpguard scan --fail-on high`
   - 输出 SARIF，方便 GitHub code scanning 或企业扫描管线接入。
   - 内置 `enterprise-default` profile，不做任意 Rego 插件系统。

4. **报告**
   - 每条 finding 包含 evidence、risk、confidence、source、fix。
   - summary 给出 block/warn/pass。
   - 输出 evidence bundle，可作为私有 registry admission 证据。

### P2：规则库、adapter 与开发者报告（6-10 周）

目标：让 CLI 从“一次性门禁”变成可维护的生态基础设施。

能力：

- HTML report。
- GitHub Action。
- `mcpguard policy test --policy policy.rego`。
- OSV / Gitleaks / Semgrep / Scorecard adapter。
- `mcpguard rules update` 拉取公开规则库。
- `mcpguard trust fetch` 拉取公开 trust feed：已知恶意包、已知高危配置、verified maintainer 信号、known-good baseline。
- 支持组织自定义规则包。
- 发布 `mcpguard-rules` 独立仓库。
- 提供 MCP server self-report schema，让开发者主动声明 tool capabilities。

注意：trust feed 是第三方情报，不是官方认证。

### P3：团队/云端仪表盘（季度级）

目标：从“扫一次”升级为“持续治理”。

能力：

- Fleet inventory：团队中有哪些 MCP server、版本、来源、风险。
- Policy management：组织策略、例外审批、到期时间、owner。
- Audit log：scan event、policy decision、tool call evidence、user approval。
- Session auth posture：每个 agent 会话展示 MCP server 授权状态，明确哪些 server 缺少 OAuth/token/本地授权、影响哪些 tool、建议用户运行 `/mcp` 或对应 client 授权流程。
- Dashboard：高危 server、风险趋势、最常见 rule、未处理 exception。
- Gateway integration：可接入 MCP gateway / AI gateway，获取真实调用日志和工具调用上下文。
- IDE/client plugin：安装前显示风险摘要。

部署模式矩阵：

| 模式 | 适用 | 数据离开本机 | 保留期 | 集成 |
| --- | --- | --- | --- | --- |
| local-only | 开源用户、敏感代码库 | 无；只生成本地 JSON/SARIF/evidence bundle。 | 用户自管。 | CI、pre-commit、private registry script。 |
| SaaS redacted | 中小团队 | finding metadata、server/package id、rule id、severity、redacted evidence hash；默认不上传源码、prompt、secret value。 | 默认 30-90 天可配。 | GitHub/GitLab、Slack、Jira、SIEM export。 |
| self-hosted / VPC | 企业 | 数据留在企业租户/VPC。 | 由企业策略控制。 | SSO/RBAC、OPA、SIEM、ServiceNow、private registry。 |
| gateway inline | 已有 MCP/AI gateway 的企业 | policy decision、tool call metadata、redacted output hash；完整 payload 可本地留存。 | 按企业审计策略。 | Docker/Kong/Cisco/自研 gateway。 |

云端不是扫描可信度的来源，而是 inventory、policy、exception、audit 和 PMF 数据的汇总层。

### P4：Trust evidence / attestation 标签体系（长期）

目标：建立可验证 trust evidence，但避免假装官方认证或“安全无漏洞”。

标签层级：

| 标签 | 含义 | 必须绑定的证据 |
| --- | --- | --- |
| `scanned` | 已用某版本规则扫描，报告可复现。 | scanner version、rule version、server digest、package digest、timestamp、report hash。 |
| `policy-pass` | 通过某组织或公开 policy profile。 | policy id/version、decision id、exception list、expiry、revocation feed。 |
| `sandbox-ready` | 可在某个 sandbox profile 中运行。 | sandbox profile、fs/network/env/proc/fd/cpu/mem/time 限制、sandbox attestation。 |
| `supply-chain-reviewed` | 依赖、secret、repo health、provenance 信号达到阈值。 | OSV/Gitleaks/Scorecard/Sigstore/SLSA evidence、source span、confidence。 |
| `enterprise-reviewed` | 企业内部人工审查完成。 | 仅做私有标签；绑定 reviewer identity、scope、date、expiration、appeal/revocation。 |

严禁：

- 不叫 `official MCP certified`。
- 不承诺“安全无漏洞”。
- 不给永久标签，必须有过期时间和规则版本。
- 不把 `enterprise-reviewed` 作为公开 marketplace 标签 MVP。

## 7. CLI MVP 详细设计

### 7.1 命令设计

```bash
mcpguard scan
mcpguard scan --config ~/.config/claude_desktop_config.json
mcpguard scan --server-dir ./my-mcp-server --format json
mcpguard scan --format sarif --fail-on high
mcpguard inventory --config-dir ~/.config
mcpguard baseline write ./mcpguard-report.json --out mcpguard-baseline.json
```

### 7.2 默认安全原则

1. 默认不执行 server。
2. P1 默认只做静态扫描；CI 默认禁用动态 introspection。
3. 当前 CLI 不提供动态 introspection；未来如增加，必须显式 `--introspect --experimental`，且 fail-closed。
4. 报告默认 redaction：secret value 只保留 hash 或占位脱敏，不输出原值。
5. 当前 P1 不发网络请求；未来如果增加公开 package/repo metadata 请求，必须提供 `--offline`，且企业环境可默认禁用。
6. 不对证据不足的 OAuth/session 问题给 high；除非有源码、metadata、conformance test 或 runtime log 证据。
7. 静态模式下 tool definition / hash 只来自 manifest 或 baseline；拿不到时 target introspection 输出 `not_observed`，并在 `skipped` 里记录 `dynamic_introspection_disabled`，不得当作 pass。已拿到静态 manifest 或 disabled target 时输出 `not_run`。

### 7.3 Finding schema

P1 的 JSON 报告字段使用 TypeScript / JavaScript 生态常见的 camelCase；SARIF 输出保持 SARIF 2.1.0 标准字段。下面示例只展示当前 P1 已实现语义：`sessionAuthPosture` 只标记 `not_analyzed`，不输出会话授权详情；dynamic introspection 未运行时写入 `skipped`。

```json
{
  "schemaVersion": "0.1",
  "scan": {
    "id": "scan_20260703_150000",
    "tool": "mcpguard",
    "toolVersion": "0.1.0",
    "ruleVersion": "2026.07.03",
    "startedAt": "2026-07-03T15:00:00+08:00",
    "mcpSpecVersion": "2025-11-25",
    "mode": "static",
    "offline": true,
    "redactionPolicy": "hash_secret_values_keep_key_names",
    "analyzers": [
      {
        "name": "config-static",
        "version": "0.1.0"
      }
    ]
  },
  "targets": [
    {
      "targetId": "srv_example",
      "serverName": "example",
      "client": "Claude Desktop",
      "scope": "user",
      "transport": "stdio",
      "sourceType": "local_config",
      "sourcePath": "~/.config/claude_desktop_config.json",
      "sourceSpan": {
        "jsonPointer": "/mcpServers/example"
      },
      "command": "bash",
      "args": [
        "-lc",
        "echo boot"
      ],
      "package": "npm:example-mcp-server",
      "version": "1.2.3",
      "repository": "https://github.com/example/example-mcp-server",
      "envKeys": [
        "GITHUB_TOKEN"
      ],
      "roots": [],
      "serverDigest": "sha256:...",
      "toolFingerprints": [
        {
          "name": "read_file",
          "kind": "tool",
          "canonicalHash": "sha256:...",
          "previousHash": "sha256:...",
          "changed": true
        }
      ],
      "introspection": {
        "status": "not_run",
        "reason": "static_manifest_available"
      }
    }
  ],
  "summary": {
    "status": "warn",
    "critical": 0,
    "high": 2,
    "medium": 5,
    "low": 3,
    "info": 0
  },
  "sessionAuthPosture": {
    "status": "not_analyzed",
    "missingAuthCount": null,
    "items": []
  },
  "findings": [
    {
      "findingInstanceId": "fnd_01H_command_shell_srv_example",
      "dedupeKey": "MCP-CMD-001:srv_example:/mcpServers/example/command",
      "fingerprint": "sha256:stable-occurrence-hash",
      "title": "Server launch command uses shell interpreter",
      "severity": "high",
      "confidence": "high",
      "affectedTargets": [
        {
          "targetId": "srv_example",
          "role": "subject"
        }
      ],
      "rule": {
        "id": "MCP-CMD-001",
        "version": "2026.07.03",
        "source": "mcpguard-rules"
      },
      "category": "command_execution",
      "firstSeen": null,
      "baselineSeen": null,
      "evidence": [
        {
          "evidenceId": "ev_01",
          "kind": "config",
          "targetId": "srv_example",
          "path": "/Users/example/project/.mcp.json",
          "sourceSpan": {
            "jsonPointer": "/mcpServers/example/command"
          },
          "snippetHash": "sha256:...",
          "redacted": true
        }
      ],
      "relationships": [],
      "impact": "The server launch path can execute arbitrary shell logic before the MCP handshake.",
      "recommendation": "Use an explicit executable and pinned package version; avoid shell wrappers.",
      "references": [
        "https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html"
      ],
      "policy": {
        "profile": "enterprise-default",
        "decision": "block",
        "exceptionId": null,
        "allowException": true
      }
    }
  ],
  "audit": {
    "reportHash": "sha256:...",
    "signedBundle": null,
    "generatedFor": "local-only"
  },
  "errors": [],
  "skipped": [
    {
      "targetId": "srv_example",
      "reason": "dynamic_introspection_disabled"
    }
  ]
}
```

### 7.4 扫描规则设计

P1 代码只阻断高置信、可由本地静态证据复现的规则。下表把“当前已实现”和“路线图规则”分开，避免把计划项误读成已经交付。

| Rule ID | 类别 | 状态 | 规则 |
| --- | --- | --- | --- |
| MCP-CMD-001 | Command | 已实现 | shell wrapper / inline interpreter。 |
| MCP-CMD-002 | Command | 已实现 | runtime package manager / remote install / `curl | sh` / `wget | sh`。 |
| MCP-ENV-001 | Secrets | 已实现 | 高风险 env var key name 注入 server。 |
| MCP-SECRET-001 | Secrets | 已实现 | env literal、args/header、command/url/package/repository 中出现 credential。 |
| MCP-FS-001 | Filesystem | 已实现 | home/root/workspace 全读、宽泛 roots、敏感 home 子目录。 |
| MCP-HTTP-001 | Transport | 已实现 | streamable HTTP / HTTP server 暴露 `0.0.0.0`、`[::]` 等 wildcard interface。 |
| MCP-TOOL-001 | Tool schema | 已实现 | tool 描述包含 override/ignore previous/exfiltrate pattern。 |
| MCP-TOOL-003 | Tool integrity | 已实现 | tool canonical hash 与 baseline 不一致，疑似 rug pull / definition drift。 |
| MCP-ENV-002 | Secrets | Backlog | wildcard env forwarding。 |
| MCP-NET-001 | Network | Backlog | 任意 egress、metadata IP、内网网段访问。 |
| MCP-TOOL-002 | Tool schema | Backlog | tool capability 描述过宽但 input schema 无约束。 |
| MCP-TOOL-004 | Tool shadowing | Backlog | 多 server 存在相似 tool name / description，或描述中跨 tool/server 指令。 |
| MCP-TOOL-005 | Tool output PI | Backlog | 离线日志或 fixture 中出现 tool output prompt injection pattern。 |
| MCP-FLOW-001 | Toxic flow | Backlog | 静态能力组合显示“读敏感数据 + 网络外传”链路；P3 用 gateway log 验证。 |
| MCP-AUTH-001 | Auth evidence | Backlog | 源码/metadata/conformance test 证明 token passthrough。纯 config 推断不标 high。 |
| MCP-AUTH-002 | Auth evidence | Backlog | OAuth scope 过宽、dangerous redirect/auth URL、session 未绑定。按证据等级标 confidence。 |
| MCP-LOCAL-001 | Local compromise | Backlog | 本地 stdio proxy 暴露敏感 env、真实 home mount、未 pin 远程包。 |
| MCP-SCOPE-001 | Scope minimization | Backlog | tool/resource scope 与声明用途不匹配，违反最小权限。 |
| MCP-SUPPLY-001 | Supply chain | Backlog | dependency CVE / malicious package signal。 |
| MCP-SUPPLY-002 | Supply chain | Backlog | low trust repo/package metadata。 |
| MCP-AUDIT-001 | Audit | Backlog | server 无 version/source/owner，难以审计。 |

### 7.5 策略 profile

当前实现只有固定 `enterprise-default` profile：每条 finding 都带 `policy.profile = "enterprise-default"`；`critical` / `high` 默认 decision 为 `block`，其它 severity 默认 `warn`。CLI gate 通过 `--fail-on <severity>` 做阈值阻断。

以下 profile 属于 P2+ backlog，当前 CLI 尚未实现 profile 选择或多策略 evaluator：

- `developer-local`：允许 medium，阻断 critical/high。
- `ci-publish`：面向 MCP server 开发者，阻断 secret、CVE high、prompt injection high。
- `strict-offline`：禁止任何 network/server execution。

自定义策略建议在 P2 用 Rego；当前 CLI 没有 `policy test` 子命令：

```rego
package mcpguard

deny[msg] {
  finding := input.findings[_]
  finding.severity == "high"
  finding.category == "command_execution"
  msg := sprintf("high-risk command execution: %s", [finding.id])
}
```

## 8. 技术架构

### 8.1 CLI 架构

```text
Config Discoverer
  -> Target Normalizer
  -> Static Analyzer
      -> Command Analyzer
      -> Env/Secret Analyzer
      -> MCP Object Analyzer
      -> Tool Fingerprint Analyzer
      -> Transport/Auth Evidence Analyzer
      -> Optional Adapter Layer(P2: OSV/Gitleaks/Semgrep/Scorecard)
  -> Policy Evaluator
  -> Reporter(JSON/SARIF/Evidence Bundle)
```

### 8.2 M3 未来动态 introspection 沙箱

当前实现无 `--introspect` flag、无动态执行、不会启动 MCP server。未来如果进入 M3，动态 introspection 只能在用户显式选择时运行，且 P1/P2 静态准入不依赖它通过：

1. `--introspect` 必须显式加 `--experimental`，CI 默认禁用。
2. 未 pin 的 `npx` / `uvx` / remote install 命令禁止 introspect，除非用户先执行下载/锁定步骤。
3. 下载/构建和运行分离：先解析包与 lock，再在隔离 runtime 中启动。
4. 创建 fake workspace，不挂载真实 home，不传真实 token，只注入 allowlist env。
5. 默认无网络；如需要 registry metadata，必须单独 metadata phase，运行 phase 仍无网络。
6. 限制 fs/network/proc/fd/cpu/mem/time/stdout/stderr，防 fork bomb、日志炸弹和隐性外传。
7. 只允许 initialize、tools/list、resources/list、prompts/list；拒绝 sampling、roots、elicitation 和业务 tool call。
8. 处理 pagination / list_changed，把 tool/resource/prompt canonical hash 写入 evidence。
9. 报告记录 sandbox attestation：runtime、profile、limits、started command digest、exit status。

macOS 本地可优先用容器或受限 sandbox；跨平台可用 Docker 或 `bubblewrap`。若无法提供上述限制，就不提供 dynamic introspection，只输出 `not_introspected`。

### 8.3 云端架构

```text
CLI / CI / IDE Plugin
  -> Upload redacted scan summary
  -> API Gateway
  -> Scan Store
  -> Policy Engine
  -> Risk Intelligence Feed
  -> Dashboard / Audit / Badge
```

数据最小化：

- 默认上传 finding metadata，不上传源码。
- secret evidence 只存 hash 和类型。
- tool description 可配置是否上传；企业版默认本地留存，云端只存 canonical hash。
- audit log 存 policy decision、decision id、rule id、target digest、exception id，不存完整 prompt。
- 支持 signed report bundle：本地保存完整证据包，云端保存报告 hash、签名和最小索引。
- 企业版提供 retention、tenant isolation、SIEM export、ServiceNow/Jira/Slack workflow。

## 9. 商业化路径

### 开源免费层

- CLI 扫描。
- 本地 JSON/SARIF/evidence bundle。
- 基础规则库。
- `--fail-on high` CI gate。

目标：拿 AppSec 和开发者信任，不要求账号，不收集遥测。

### Pro / Team

- 私有 registry admission workflow。
- 私有规则。
- 团队 dashboard。
- 风险趋势。
- GitHub/GitLab PR 注释。
- MCP server inventory。
- 例外审批。

目标：100-2000 人研发组织的 AppSec / Platform Security。

定价假设：按组织 + 扫描 seat / 开发者端点混合计费，早期可从 49-199 美元/月团队包验证支付意愿；企业 POC 以私有部署和 SIEM/ServiceNow 集成为主要付费点。价格只是验证假设，不在未访谈前写死。

### Enterprise

- Self-hosted / VPC。
- SSO/RBAC。
- OPA policy sync。
- SIEM export。
- Gateway integration。
- 自定义 trust evidence / attestation 标签。
- 私有 trust feed。
- 审计保留策略。
- MDM / endpoint / CI rollout 指南。

目标：准备引入 MCP 的企业。

### 采用路径

1. **无账号 CLI**：安全工程师扫自己的机器或一份匿名配置，第一次发现 high risk。
2. **CI / private registry gate**：把 `--fail-on high` 放进 MCP server 引入流程。
3. **例外审批**：记录为什么允许某个 high-risk server 进入组织。
4. **团队 inventory**：收集 redacted report，形成 fleet view。
5. **gateway/runtime integration**：接 Docker/Kong/Cisco/自研 gateway 的运行期证据。

### PMF 闸门

30 天验证期必须满足大部分条件，才继续投入 P3 云端：

- 20 个真实组织试用 CLI。
- 10 个组织把 CLI 接入 CI、MDM、private registry 或安全审查脚本。
- 10 份真实匿名配置中，每份至少扫出 1 个客户认可的 high/medium issue，或明确证明“没有问题”的报告被安全团队接受。
- 5 个组织愿意上传 redacted report。
- 3 个设计伙伴愿意为 dashboard / exception workflow / SIEM integration 付费或签 POC。
- high finding 修复率超过 30%，否则说明报告不可操作。
- time-to-first-finding 小于 5 分钟。
- 误报导致卸载率低于 20%。

## 10. 里程碑

### M0：调研与规则草案（1 周）

- 固化 taxonomy：MCP-CMD / ENV / FS / NET / TOOL / FLOW / HTTP / AUTH / LOCAL / SCOPE / SUPPLY / AUDIT。
- 选 20 个真实开源 MCP server 和 10 份匿名企业/个人 MCP config 做手工样本。
- 写 30 条 baseline rules。

### M1：CLI 静态扫描 MVP（4 周）

- 解析常见 client config，区分 user/project/extension scope。
- 生成 inventory。
- 命令/env/secret/filesystem/transport/tool description/tool hash 静态规则。
- JSON/SARIF 输出。
- `--fail-on` 支持。

### M2：开发者报告与 CI（6 周）

- HTML report。
- GitHub Action。
- OSV/Gitleaks/Semgrep adapter。
- 初版 rules docs。
- Rego policy test。

### M3：Sandbox introspection（8-10 周）

- 实验性 `--introspect`。
- tools/resources/prompts list 采集。
- 沙箱 profile。
- dynamic evidence 合并到 report。

### M4：团队版 prototype（季度）

- 上传 redacted report。
- Dashboard inventory。
- policy profile。
- exception workflow。

### M5：Trust label beta（半年+）

- scan badge。
- policy-pass label。
- sandbox-ready label。
- supply-chain-reviewed label。
- expiration / revocation / versioned rules。

## 11. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| MCP 协议持续演进 | 规则和 schema 失效 | 版本化 rule/schema，按 spec release 做 compatibility matrix。 |
| 误报过多 | 开发者不信任 scanner | MVP 只阻断高置信 P0/P1，medium 默认 warn。 |
| 动态 introspection 执行风险 | 扫描器反而成为攻击面 | 默认关闭；沙箱；只调用 list；限制 env/network/fs/time。 |
| trust label 措辞风险 | 被误解为官方认证 | 文案统一使用 third-party attestation / trust evidence，不使用 official certified。 |
| 与 Snyk/Cisco/Docker/Kong 等竞争 | 进入成本升高 | 差异化在 open rules、deterministic evidence、install-time policy gate、private registry admission。 |
| 企业不愿上传数据 | 云端采用受阻 | 支持 redaction、signed local evidence bundle、self-hosted、local-only policy evaluation。 |
| 供应链信号不完整 | trust score 被质疑 | 报告 confidence/source，不给单一神秘分。 |
| P1 范围膨胀 | MVP 变成不可交付平台 | P1 只保留静态准入 wedge；adapter、HTML、dynamic introspection、cloud 后移。 |

## 12. 验证计划

### 样本集

- 10 个官方或高星 MCP server。
- 10 个社区 server。
- 5 个故意有漏洞的 fixture server。
- 5 个企业配置样例：filesystem、browser、database、GitHub、cloud。
- 10 份真实匿名 client config，覆盖 Claude Desktop/Code、Cursor、VS Code、Codex、Windsurf、Gemini CLI、Amazon Q。

### 评价指标

- 高危 fixture 召回率：目标 90%+。
- 高置信 high finding 误报率：目标 <10%。
- CLI 扫描 20 个 server 总耗时：目标 <60s（不含动态 introspection）。
- JSON schema 稳定性：所有 fixture 快照测试通过。
- CI 可用性：CLI 可在 CI 中通过 `--fail-on high` 阻断 high risk；GitHub Action 封装为 M2 交付。
- tool definition drift fixture：能检测 canonical hash 变化和 rug pull。
- transport/auth 证据等级：纯推断不得输出 high。

### 用户验证

- AppSec / Platform Security：报告是否足够做准入、阻断、例外审批。
- MCP server 开发者：能否按报告修复。
- AI tool 团队：risk summary 是否能嵌入安装/调用决策。
- PMF 指标采用第 9 节的 30 天闸门；未达标则继续 CLI/rules，不进入云端 dashboard。

## 13. 初版文档与产品呈现建议

scry 内可先做两个只读能力：

1. **MCP 风险观察页**：导入 scanner JSON 后展示 server、tool、finding、policy decision、evidence。
2. **Trust evidence 预览**：展示 scanned / policy-pass / sandbox-ready / supply-chain-reviewed，但明确标注“第三方证据标签，非官方认证”。
3. **会话级 MCP 授权提示**：在每个会话顶部或右侧面板展示类似 `6 MCP servers need authentication · run /mcp` 的轻量 warning；展开后列出 server 名称、授权类型（OAuth/API token/local permission）、缺失原因、受影响 tools、最近一次失败时间和建议动作。这个提示只读展示当前 client/session 的 auth posture，不自动触发授权、不收集 secret value、不把未授权当安全漏洞，只作为“当前会话能力不可用/需用户处理”的可见状态。

不要在 scry 第一版里直接做真实扫描执行。扫描器 CLI 和观察 UI 解耦：CLI 负责安全边界，scry 负责可视化和审计体验。

## 14. 子 agent 审查记录

第一轮只读审查已完成，3 个子 agent 初始结论均为“不通过”，无 P0，但存在 P1/P2。已按以下方式修订：

| 审查方向 | 初始 P1/P2 | 修订动作 |
| --- | --- | --- |
| 产品/商业落地 | ICP 过宽、MVP 范围过大、竞品压力低估、云端采购/部署/数据边界不足、PMF 指标缺失。 | 明确第一年 ICP 为 100-2000 人研发组织 AppSec / Platform Security；P1 收窄为静态准入 wedge；新增部署模式矩阵、采用路径、定价假设和 30 天 PMF 闸门。 |
| 竞品/开源对标 | 漏 Cisco/Ramparts/Proximity/ZAP 等直接或相邻工具；Snyk/Docker/Kong 对标过浅；PyRIT 链接过期；OWASP MCP 控制点未转规则。 | 扩展 4.2/4.4/4.5 竞品矩阵；修正 PyRIT 到 `microsoft/PyRIT`；新增 Docker/Kong runtime/gateway 边界；把 OWASP hashing/rug pull/tool shadowing 等映射成规则。 |
| 安全/技术可行性 | 缺 MCP 特有攻击链、Auth/transport 过度承诺、动态 introspection 沙箱不足、schema 不足以支撑审计/标签。 | 新增 tool shadowing、rug pull、toxic flow、tool output prompt injection；按 transport/证据等级拆 auth；`--introspect` 改为 fail-closed experimental；扩展 schema 为 `targets[]`、rule version、fingerprints、policy decision、sandbox attestation、errors/skipped。 |

第二轮复审结果：

| 审查方向 | 结论 | 剩余 P0/P1/P2 | 说明 |
| --- | --- | --- | --- |
| 安全/技术可行性 | 通过 | 无 | 复审确认 MCP 特有攻击链、transport/auth 证据等级、fail-closed introspection、跨 server / 多证据 finding schema 已消除阻塞。 |
| 产品/商业落地 | 通过 | 无 | 复审确认 ICP、MVP wedge、竞品压力、部署/数据边界、trust evidence、PMF 闸门均达到可落地标准。 |
| 竞品/开源对标 | 通过 | 无 | 复审先指出漏掉 MCPProxy；补充 MCPProxy / quarantine / approve flow / evidence standard 边界后，确认无 P0/P1/P2。 |

仍保留的 P3/P4 建议：

- 对外材料建议把标题中的“认证”进一步降级为 trust evidence / attestation。
- P1 client discovery 执行验收可先支持 Claude Desktop/Code、Cursor、VS Code，其余 best-effort。
- 后续可补 buyer battlecard，逐一回答为什么不是直接买 Snyk/Cisco/Docker/Kong/MCPProxy。
- OWASP 控制点可在 rules backlog 中继续扩展 message signing/replay、installation consent、human-in-the-loop。

## 15. 主要来源

- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Understanding Authorization in MCP](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [MCP Registry about](https://modelcontextprotocol.io/registry/about)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)
- [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/)
- [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [OWASP Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [Snyk Agent Scan](https://github.com/snyk/agent-scan)
- [Invariant mcp-scan](https://github.com/invariantlabs-ai/mcp-scan)
- [Cisco MCP Scanner](https://github.com/cisco-ai-defense/mcp-scanner)
- [Ramparts](https://github.com/getjavelin/ramparts)
- [Proximity MCP security scanner coverage](https://www.helpnetsecurity.com/2025/10/29/proximity-open-source-mcp-security-scanner/)
- [MCPProxy / smart-mcp-proxy](https://github.com/smart-mcp-proxy/mcpproxy-go)
- [MCPProxy security scanner plugins](https://docs.mcpproxy.app/features/security-scanner-plugins/)
- [MCPProxy security commands](https://docs.mcpproxy.app/cli/security-commands)
- [OWASP ZAP MCP add-on coverage](https://www.zaproxy.org/blog/2026-05-21-scanning-mcp-servers-with-zap/)
- [StepSecurity Dev Machine Guard](https://github.com/step-security/dev-machine-guard)
- [Enkrypt MCP Security](https://www.enkryptai.com/solutions/mcp-security)
- [Semgrep](https://github.com/semgrep/semgrep)
- [Trivy](https://github.com/aquasecurity/trivy)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
- [OSV-Scanner](https://github.com/google/osv-scanner)
- [OpenSSF Scorecard](https://github.com/ossf/scorecard)
- [NVIDIA garak](https://github.com/NVIDIA/garak)
- [Microsoft PyRIT](https://github.com/microsoft/PyRIT)
- [Docker MCP Catalog and Toolkit](https://docs.docker.com/ai/mcp-catalog-and-toolkit/)
- [Docker MCP Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/)
- [Kong AI Gateway MCP support](https://developer.konghq.com/index/ai-gateway/)
- [Kong Enterprise MCP Gateway](https://konghq.com/blog/product-releases/enterprise-mcp-gateway)
- [Kong MCP Tool ACLs](https://konghq.com/blog/product-releases/mcp-tool-acls-ai-gateway)
- [Open Policy Agent](https://www.openpolicyagent.org/)
- [Sigstore](https://www.sigstore.dev/)
- [SLSA v1.2](https://slsa.dev/spec/v1.2/)
