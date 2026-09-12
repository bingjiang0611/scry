# G0 设备密钥 / CSR 互操作证据

2026-09-12。此增量验证证书库和 Keychain 路径，**不是完成首次配对**。一次性秘密、Mac 人类确认、原子 grant/消耗、撤销/续期、公网和 iPhone 仍待完成；没有接入业务或新增远程签发接口。

## 当前实现

- `RemoteTransport/Enrollment.swift`：Apple Crypto 生成软件 P-256 私钥，X509 生成标准 CSR 和短时自签名 bootstrap client certificate。恢复只接受自身规范 PKCS#8 导出，避免混合 PEM 或其他曲线的标量被宽松导入器重新解释。
- `G0Service.prepareEnrollment()`：私钥留在 credential actor；Keychain insert-only 写入并读回后，才返回公有 CSR、bootstrap certificate 和 SPKI SHA-256。不同 actor 读空后竞争创建也不会覆盖现有设备密钥；只有明确清除才删除。该方法尚未连到配对 UI/网络。
- `enrollment.mjs`：有界 ASN.1 解析；只接受 P-256 + ECDSA/SHA-256 CSR，验证签名；签发时重新校验 CSR/hash 绑定。host 分配 subject/UUID、有效期和 clientAuth，用途不继承客户端请求的 CA/serverAuth/SAN。
- 签发器是本地 crypto adapter，不是授权入口。后续 authority 必须先验证短时秘密、活跃通道私钥证明和本机确认；grant 与凭证消费落盘后才能把证书交给手机。CSR 签名自身不证明当前通道持有私钥，更不证明人类同意。
- `scry-enrollment-fixture` 仅供测试：只能在已存在的 mode-0700 OS 临时 `scry-g0-*` 目录创建排他 mode-0600 文件。App 不调用此 executable，原生私钥不通过它落明文文件。

## 实际验证

- Node：19 tests 通过（14 wire + 5 CSR/签发测试）；覆盖篡改、非法/超大 CSR、错误曲线/hash、请求 CA/serverAuth 不生效、批准指纹变化、CA key 不匹配、CA 过期。
- Swift：4 XCTest methods 通过，含 CSR 签名/公钥相等、自签 bootstrap 非 CA、NIOSSL PEM 接受、密钥恢复和非法输入。
- `node experiments/remote-g0/enrollment-smoke.mjs`：Swift 生成密钥/CSR → Node 验签与签发 → 同一 Swift 私钥经 NIOSSL 建立双层 TLS 回声，真实通过；Swift/Node 的标准 SPKI SHA-256 一致。
- 同一 smoke 的自签 bootstrap 负例：认证主机拒绝，0 个 application request，非 runner timeout。此负例不替代未来 pairing-only 接口的隔离测试。
- 原有 7 场景 TLS-over-WSS smoke 再次通过。
- 真实 iOS Simulator App：4 个 XCTest，0 fail / 0 skip，含生成设备密钥后 Keychain 保存、跨 actor 不替换、清除、fixture TLS。`xcresulttool` 读回结果；当前本机证据目录 `scry-g0-ios-result-P22q8O`（系统临时目录）。
- 新依赖下 arm64/x86_64 Simulator App + Tests build-for-testing 通过。64 MB 是含 XCTest 的双架构 Debug 测试 bundle，**不是 IPA/发行体积**；Release/真机包成本未测。构建仍有不剥离 Apple 已签名 XCTest 组件和缺少 AppIntents metadata 的警告，不代表使用了这些私有测试组件进行发布。

所有材料为新建测试身份，临时目录由各 harness 清理；不读取真实 Provider token、项目记录或用户账号。没有云部署/扣费、真机安装或人工确认的成功声明。

## 锁定依赖与核对来源

- [swift-certificates 1.20.0](https://github.com/apple/swift-certificates/tree/1.20.0)，Apache-2.0；[CSR 签名 API](https://github.com/apple/swift-certificates/blob/1.20.0/Sources/X509/CSR/CertificateSigningRequest.swift)、[certificate 签名 API](https://github.com/apple/swift-certificates/blob/1.20.0/Sources/X509/Certificate.swift)。
- [swift-crypto 4.5.2](https://github.com/apple/swift-crypto/tree/4.5.2)，Apache-2.0；P-256 software key / PEM，iOS 13+ 基础 API。两库 tools 最低 6.1；本工程锁定的 collections 仍要求 6.2+ 工具链。
- [@peculiar/x509 2.1.0](https://github.com/PeculiarVentures/x509/tree/v2.1.0)，MIT，Node >=20；[CSR verify](https://github.com/PeculiarVentures/x509/blob/v2.1.0/src/pkcs10_cert_req.ts)、[certificate generator](https://github.com/PeculiarVentures/x509/blob/v2.1.0/src/x509_cert_generator.ts)、有界 `berOptions` 解析。
- 必需 Reflect polyfill 使用固定 `reflect-metadata 0.2.2`；显式传 Node 标准 `webcrypto`，不用自写签名/加密。
- 默认 npm 镜像缺少该版本的一项传递依赖。核对官方 registry 确有对应版本后，以单次命令的 `--registry=https://registry.npmjs.org --ignore-scripts` 安装；未修改全局 registry。安装审计报告 0 已知漏洞，**不等于独立安全评审**。
- Node 与 Swift lockfiles 已更新；App workspace 和 Swift package 的版本 pin 一致。正式冻结、完整第三方 notices、发布包和独立安全评审仍属于 G0/G5 后续 gate。
