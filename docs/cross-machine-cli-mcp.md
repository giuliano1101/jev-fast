# 跨机器 CLI / MCP：合成任务原型

本地协调服务负责浏览器、会话、持久账本和执行前校验。远程网关只返回带签名的决策，不能操作浏览器或 Shell。现有六工具保持不变：`open_session`、`observe`、`run_goal`、`cancel`、`status`、`close_session`；MCP 工具名增加 `jev.` 前缀。

当前实现**仅支持合成任务（synthetic-only）**，整体约束等级为 **advisory-only**。它不会限制宿主上的其他工具，也不构成操作系统级安全边界。`required_jev` 配置要求本 Engine 管理的动作持有有效的 Jev 路由回执，但不代表电脑上的所有操作都经过 Jev。真实应用执行、生产部署、多设备迁移及 D/E 阶段验收仍未支持或未验证。下文的 mock 示例无需调用付费托管模型。

## 离线 mock 快速开始

在目标机器上安装 Node **24.19 或更新版本**，进入项目目录后安装依赖与 Playwright Chromium，再构建并运行：

```sh
node --version
npm ci
npx playwright install chromium
npm run build
node dist/src/cli/index.js service start --runtime /tmp/jev-s10-demo --json
node dist/src/cli/index.js doctor --runtime /tmp/jev-s10-demo
node dist/src/cli/index.js policy status --runtime /tmp/jev-s10-demo
node dist/src/cli/index.js demo --runtime /tmp/jev-s10-demo --json
node dist/src/cli/index.js service stop --runtime /tmp/jev-s10-demo --json
```

安装依赖和浏览器需要联网下载；安装完成后的本地 mock 演示不向远程决策服务发请求。Linux 如缺少浏览器系统依赖，需按 Playwright 对应平台的安装要求准备环境。仓库中的 `scripts/env.sh` 包含原开发 Mac 的本机路径，不是跨机器通用安装步骤，不应在其他机器上直接套用。

不传配置文件时，服务使用本地 mock 决策。显式的私有 JSON 配置可只包含 `{"mode":"mock"}`，通过 `service start --config /absolute/mock.json` 选择。Mock 模式保留本地客户端 `a`、`b`；可选 `--share-a-with-b` 开启测试用的显式共享访问规则。远程模式拒绝这个参数。

`schemas --json` 输出六工具定义。工具调用接受 `--args` JSON、可选 `--credential FILE` 和 `--json`；默认凭据为 `RUNTIME/client-a.json`。未知参数及不适用于当前命令的参数会被拒绝。错误以非零退出码结束；使用 `--json` 时，错误格式为稳定的 `{ "error": { "code": "..." } }`。

## 私有文件与本地身份

这些命令读取的配置、证书、CA、签名密钥、回执密钥、token 和操作说明文件，都必须是当前用户拥有的普通文件，权限为 **0600**，硬链接计数为 1，且路径最后一项不能是符号链接。读取大小有上限。服务运行目录与网关存储目录应为私有目录（0700）。公开证书和公钥也使用 0600，因为配置加载器统一执行私有文件规则。

证书、信任根及 Ed25519 签名密钥应通过你已批准的流程准备。本文不会创建或安装生产凭据。建议回执签名和 token 签名使用不同密钥对。不要把私钥或 token 放进命令参数或日志。

一个远程配置**只将本地客户端 `a`** 绑定到指定的 owner/device/agent 身份。它不会创建 `client-b.json`，也不会把多个本地客户端静默映射到同一个远程身份。独立 agent 应使用独立私有配置、运行目录和登记身份。

## 网关配置与操作员命令

操作员入口与普通 agent 工具分开：

```sh
node dist/src/remote/main.js --help
node dist/src/remote/main.js serve --config /absolute/gateway.json
node dist/src/remote/main.js enroll --config /absolute/gateway.json --spec /absolute/enrollment.json
node dist/src/remote/main.js mint --config /absolute/gateway.json --spec /absolute/token-spec.json --out /absolute/agent-token.new
node dist/src/remote/main.js revoke --config /absolute/gateway.json --spec /absolute/revocation.json
```

`serve` 在前台运行，收到 SIGINT/SIGTERM 后关闭。以上是配置和运行方法，不表示网关已经部署。验证测试只使用临时本机回环监听地址。

离线 mock 网关配置：

```json
{
  "mode": "mock",
  "certFile": "server.pem",
  "keyFile": "server.key",
  "caFile": "client-ca.pem",
  "receiptPrivateKeyFile": "receipt-signing.key",
  "tokenPublicKeyFile": "token-signing.pub",
  "tokenPrivateKeyFile": "token-signing.key",
  "storageDir": "state",
  "issuer": "gateway",
  "audience": "executor",
  "bindHost": "127.0.0.1",
  "port": 8443
}
```

路径相对于配置文件所在目录解析。`mode` 默认为 `mock`，`bindHost` 默认为 `127.0.0.1`，`port` 默认为 `8443`。监听地址只能在这份私有服务器配置中指定。跨机器访问还需要单独确认可达的监听地址、TLS 主机名/SAN 以及网络访问控制，程序不会自动安装或配置这些条件。`tokenPrivateKeyFile` 仅签发 token 时需要；只用于运行网关的配置可省略它。网关运行时需要回执私钥和 token 公钥。

登记身份与签发 token 的说明文件只接受以下字段：

```json
{
  "identity": {"owner_id":"owner","device_id":"device-a","agent_id":"agent-a"},
  "certFile": "agent.pem",
  "expiresAt": 0
}
```

使用前，必须把 `expiresAt: 0` 替换为预期的未来 Unix 时间，单位为**毫秒**；保留占位值会被拒绝。这里的 `certFile` 相对于说明文件所在目录解析，不是相对于网关配置文件。登记有效期不能超过证书有效期。签发 token 要求身份已经登记、尚未吊销且证书匹配；所请求的到期时间必须晚于当前时间、不超过一小时，并且处于证书有效期内。Token 只具有 `decide:synthetic` 权限范围，并与证书绑定。如果登记更早到期或被吊销，token 即使尚未到期也不能通过认证。

签发命令只写入独占新建、权限为 0600 的输出文件，不打印 token，也不覆盖已有路径。它还会验证配置中的 token 私钥、公钥是否匹配。网关运行期间可以执行登记或吊销命令，使用同一 SQLite 存储目录。

吊销说明文件只接受：

```json
{"identity":{"owner_id":"owner","device_id":"device-a","agent_id":"agent-a"}}
```

网关没有 HTTP 登记、签发 token、浏览器或 Shell 接口。需要认证的接口只有 `GET /health` 和 `POST /v1/decisions`。吊销会阻止后续请求通过认证；已经签发的短期执行回执仍按本地期限到期。这不等于瞬时全局撤回所有已签发回执。

## 本地服务的远程配置

必须显式配置本地协调服务；普通 CLI 工具参数与 MCP 工具参数都不能选择 provider：

```json
{
  "mode": "remote",
  "endpoint": "https://gateway.example:8443",
  "caFile": "server-ca.pem",
  "certFile": "agent.pem",
  "keyFile": "agent.key",
  "tokenFile": "agent-token.new",
  "receiptPublicKeyFile": "receipt-signing.pub",
  "issuer": "gateway",
  "audience": "executor",
  "identity": {"owner_id":"owner","device_id":"device-a","agent_id":"agent-a"},
  "enforcementMode": "test_mock"
}
```

路径相对于这份配置文件所在目录解析。服务地址必须使用 HTTPS，不能包含用户名/密码、查询参数、片段或根路径以外的路径。服务器信任根、客户端证书/私钥、token、回执公钥均需明确配置；issuer、audience、identity 和 enforcementMode 都是必填项。`test_mock` 用于合成任务的 mock 网关测试；`required_jev` 会拒绝 mock 路由回执，需要另行批准的托管模型网关。远程失败不会自动降级为本地 mock 决策。

```sh
node dist/src/cli/index.js service start --config /absolute/remote.json --runtime /tmp/jev-agent-a --json
node dist/src/cli/index.js doctor --runtime /tmp/jev-agent-a
node dist/src/cli/index.js policy status --runtime /tmp/jev-agent-a
node dist/src/cli/index.js demo --runtime /tmp/jev-agent-a --json
node dist/src/cli/index.js service stop --runtime /tmp/jev-agent-a --json
```

网关不可达时，本地服务仍可启动，以便进行本地诊断和停止操作；这不表示远程执行可用。`service stop` 使用本地操作员凭据，不依赖网关健康状态。在完成关闭前，应保留运行目录中的私有 `operator.json`。

运行模式和凭据内容在服务启动时固定。`service start` 会将运行中服务的配置指纹与本次请求的配置、凭据内容比较；不一致时返回 `SERVICE_PROFILE_MISMATCH`。例如，已有远程服务时，再用默认 mock 参数启动，会返回不匹配错误。匹配时返回 `already_running: true`。指纹也覆盖 mock 共享配置和已读取凭据内容的哈希；它不是授权 token，也不是运行程序的真实性证明。

当前没有热重载或 token 自动续期。续期时，先通过操作员 `mint` 命令写入一个新的输出文件，再停止本地服务，更新远程配置中的 `tokenFile`，然后重新启动。续期或重启时，不要删除账本或重新执行历史动作。

## MCP

先启动同一个本地协调服务，再将宿主配置为运行：

```sh
node /absolute/checkout/dist/src/mcp/index.js --credential /tmp/jev-agent-a/client-a.json
```

MCP 服务名为 `jev-local`，只提供现有六工具，与 CLI 共用同一套本地协调服务和 Engine。连接时会查询健康状态；远程不可达会通过本地健康信息报告，不会阻止连接或查询本地状态。登记、吊销、签发 token 和停止服务属于操作员 CLI 功能，不是新增的 MCP 工具。

## 诊断与当前限制

`doctor` 和 `policy status` 默认输出 JSON。运行中的服务提供实际 provider/model、协议/策略、执行校验模式、`enforcement: "advisory-only"`、构建来源及配置指纹。远程健康检查验证 TLS、Bearer token 和当前登记状态，并返回 `authenticatedIdentity`；`identityMatches` 比较它与本地配置，身份不符时 `routeCompatible` 为 false。网关不可达时，模型标为 `unknown`，不会猜测已加载的 provider。`ready: true` 只表示本地服务正在运行。

`doctor` 还提供 `installation`：当前 Node 版本及是否满足 24.19+、按实际执行器规则找到的 Chromium 是否可执行、运行目录是否为本人所有的 0700 目录，以及本地 socket 是否为本人所有的 0600 socket。服务尚未启动时仍能诊断并报告 `LOCAL_SERVICE_UNAVAILABLE`，不会创建目录或自动修复。诊断发现问题仍返回可读 JSON，调用方应检查字段，不能只看退出码。Chromium 检查不启动浏览器，`launchVerified` 始终为 false；实际 `demo` 才验证启动和动作。

`npm run build` 嵌入 Git revision、工作区是否有未提交修改，以及构建输入的 SHA-256 摘要。直接运行 `tsc` 或从无 Git 的源码包构建时，来源可能为 unknown。构建字段用于追溯，不是二进制签名或认证凭据。诊断不检查 DNS/防火墙配置，也不能证明宿主禁用了其他工具。`JEV_CHROMIUM_PATH` 可显式指定 Chromium，其余路径使用 Playwright/已有测试缓存解析。诊断不会打印密钥或 token。

## 显式托管模型配置：本文不会执行

托管模型网关需要 `mode: "live"`，同时提供 `live: {"keyFile":"hosted-key","approvalFile":"approval.json"}`。Mock 模式拒绝 `live` 配置块；live 模式缺少该配置块也会被拒绝。托管模型密钥只从指定私有文件读取，不读取环境变量中的隐式凭据。

批准文件恰好包含两个对象：

- `authorization`：`approval_id`（字符串）、`expires_at`（未来 Unix 毫秒时间）、`synthetic_only: true`、`max_requests`（1–1000 的整数）、`max_cost_usd`（大于 0 且不超过 10）。
- `approval`：相同的 `approval_id`、`expires_at`、`max_requests`、`max_cost_usd`，另加 `reservation_usd`（大于 0、不超过 1，且足以覆盖 provider 每次尝试的预留金额）。

两个对象的对应值必须一致。网关持久存储会在每次托管请求尝试前预留预算，重试也计入。只有用户明确批准设备、期限、请求上限和成本上限后，才能配置这些文件。需要强制 Jev 路由时，本地配置必须使用 `required_jev`。具备这项配置能力，不表示已经完成 live 验收、付费调用或部署。
