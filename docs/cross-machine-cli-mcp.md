# 跨机器 CLI / MCP：当前工具与操作员配置

更新：2026-11-02。[当前共享公网](public-service-quickstart.md)已经配置真实 remote Jev/usage-only，已启用 autoAdmitAi、allowContinuations 和 android host。其他 AI 直接使用[接入手册](other-ai-real-testing.md)，不索取用户 Key/profile/新审批，不在共享 `/tmp/jev-501` 停服或另起 mock。下文安装、证书和网关命令用于操作员的新部署。

本地 coordinator 执行真实浏览器与已配置 MCP host 操作，远程网关返回验签的 Jev 决策。CLI/stdio 提供 13 个工具：六个兼容 fixture、choose_action、browser_open/observe/act/close、host_tools/act；网络版另有 network_status/request_status/release_connection，共16个。browser_* 在隔离无头 Chromium 中访问任意 HTTP/HTTPS URL，独立于日常 Chrome；host_* 仅访问操作员绑定的 backend，不提供任意 Shell/桌面接管。

当前部署不设置付费次数/金额/到期封顶、固定步骤、全局会话总数、队列长度或默认 AI/业务交付 TTL。显式调用者预算、同会话动作租约、实体 host 顺序执行、TLS/owner/代次/幂等和 UNKNOWN 仍有效。整体为 advisory-only，不限制宿主的其他工具，也不是操作系统级安全边界。

网络工具使用 `{request_id, params, continuation_token?}`；状态/释放也支持 token。宿主自动私密缓存 network_status 返回的 continuation_token，跨短连接保持同一 owner/结果；不按名称恢复身份。正常结束 release_connection，UNKNOWN 保留原键。实际网页/手机调用与已验证范围见[当前服务报告](reports/2026-11-02-unrestricted-service.md)。

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

`schemas --json` 输出当前13个本地工具定义。工具调用接受 `--args` JSON、可选 `--credential FILE` 和 `--json`；默认凭据为 `RUNTIME/client-a.json`。未知参数及不适用于当前命令的参数会被拒绝。错误以非零退出码结束；使用 `--json` 时，错误格式为稳定的 `{ "error": { "code": "..." } }`。

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

使用前，必须把 `expiresAt: 0` 替换为预期的未来 Unix 时间，单位为**毫秒**；保留占位值会被拒绝。这里的 `certFile` 相对于说明文件所在目录解析，不是相对于网关配置文件。登记有效期不能超过证书有效期。签发 token 要求身份已经登记、尚未吊销且证书匹配；所请求的到期时间必须晚于当前时间、不超过一小时，并且处于证书有效期内。Token 与证书绑定；签发 spec 可设置 `scope: "decide:actions"` 以访问通用 choice 路由，省略时仍为兼容 fixture 的 `decide:synthetic`。两种 scope 不互相冒用，browser/host 通用决策需要 actions scope。如果登记更早到期或被吊销，token 即使尚未到期也不能通过认证。

签发命令只写入独占新建、权限为 0600 的输出文件，不打印 token，也不覆盖已有路径。它还会验证配置中的 token 私钥、公钥是否匹配。网关运行期间可以执行登记或吊销命令，使用同一 SQLite 存储目录。

吊销说明文件只接受：

```json
{"identity":{"owner_id":"owner","device_id":"device-a","agent_id":"agent-a"}}
```

网关没有 HTTP 登记、签发 token、浏览器或 Shell 接口。模型网关的鉴权接口包括 `GET /health`、fixture 的 `POST /v1/decisions` 及通用 `POST /v1/choices`，它们不是公网 MCP 地址。吊销会阻止后续请求通过认证；已经签发的短期执行回执仍按本地期限到期。这不等于瞬时全局撤回所有已签发回执。

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

默认静态配置仍按上述规则固定 token。需要轮换时，可信私有 profile 可设置 `"tokenReload": true`：每次健康检查/决策请求前重新读取同一路径的 0600、当前用户所有的私有 token 文件；空值、格式错误、权限错误、读取失败均拒绝请求，不使用旧 token。文件读取计入原请求截止时间。此模式的指纹绑定绝对 profile 路径、完整配置与固定证书/密钥/回执材料，排除可替换 token 字节，因此原路径原身份的 token 轮换不要求重启。其他信任材料、身份或配置变化仍不匹配。

`tokenReload` 不会签发或续期 token。操作员需使用既有签发权限，将短期证书绑定 token 原子替换到配置路径；不扩大权限或预算。S17 私有 runner 原先受预算到期日约束；S18 只计费 runner 每 20 分钟刷新一次、单个 token 最长 55 分钟，仅遵循现有客户端证书有效期，不再绑定旧预算到期日。静态配置仍可按旧方式签发新文件并安全停启；两种方式均不得删除账本或重放历史动作。

## 真实浏览器与配置 host

remote profile 的 actions-scope 决策提供 choose_action 与真实浏览器服务；健康信息含 general_choice_available、real_browser_available、configured_hosts。这些字段加实际工具结果用于确认能力，ready 本身只证明 coordinator 运行。

操作员可在私有 remote profile 设置 `"hostConfigs":{"android":"/absolute/private/android-host.json"}`，该私有文件使用 `{serverCommand, serverArgs, serverEnv?, device?}` schema 指向已知 MCP backend。AI 不传 serverCommand、私有路径或 device；host_tools 会隐藏 device 参数，host_act 在服务端注入配置设备。共享部署已有 android，不要求 AI 再安装/选设备。host 操作以真实观察构造候选、真实 Jev 选择、backend 执行后回读验证；同一个实体 host 串行，独立浏览器可以并行。

browser_open 返回 `{session_id, browser, observation}`，后续 act 的 snapshot_id/control_id 来自最新 observation。若 navigation_pending，先 observe；执行回执并不证明页面目标已达成。通用图像/状态经过16 MiB技术 transport 边界，不能据此公开原始设备/账号数据。

## MCP

先启动同一个本地协调服务，再将宿主配置为运行：

```sh
node /absolute/checkout/dist/src/mcp/index.js --credential /tmp/jev-agent-a/client-a.json
```

MCP 服务名为 `jev-local`，提供当前13个业务工具，与 CLI 共用同一个 coordinator、身份和执行审计；具体 backend 是否可用由实际 profile 决定。连接时会查询健康状态；远程不可达会通过本地健康信息报告，不会阻止连接或查询本地状态。登记、吊销、签发 token 和停止服务属于操作员 CLI 功能，不是新增的 MCP 工具。

## 诊断与当前限制

`doctor` 和 `policy status` 默认输出 JSON。运行中的服务提供实际 provider/model、协议/策略、执行校验模式、`enforcement: "advisory-only"`、构建来源及配置指纹。远程健康检查验证 TLS、Bearer token 和当前登记状态，并返回 `authenticatedIdentity`；`identityMatches` 比较它与本地配置，身份不符时 `routeCompatible` 为 false。网关不可达时，模型标为 `unknown`，不会猜测已加载的 provider。`ready: true` 只表示本地服务正在运行。

`doctor` 还提供 `installation`：当前 Node 版本及是否满足 24.19+、按实际执行器规则找到的 Chromium 是否可执行、运行目录是否为本人所有的 0700 目录，以及本地 socket 是否为本人所有的 0600 socket。服务尚未启动时仍能诊断并报告 `LOCAL_SERVICE_UNAVAILABLE`，不会创建目录或自动修复。诊断发现问题仍返回可读 JSON，调用方应检查字段，不能只看退出码。Chromium 检查不启动浏览器，`launchVerified` 始终为 false；实际 `demo` 才验证启动和动作。

`npm run build` 嵌入 Git revision、工作区是否有未提交修改，以及构建输入的 SHA-256 摘要。直接运行 `tsc` 或从无 Git 的源码包构建时，来源可能为 unknown。构建字段用于追溯，不是二进制签名或认证凭据。诊断不检查 DNS/防火墙配置，也不能证明宿主禁用了其他工具。`JEV_CHROMIUM_PATH` 可显式指定 Chromium，其余路径使用 Playwright/已有测试缓存解析。诊断不会打印密钥或 token。

## 显式托管模型配置：本文不会执行

当前共享部署已经由操作员配置，不要求其他 AI 再次审批。新部署的托管模型网关需要 `mode: "live"`，同时提供 `live: {"keyFile":"hosted-key","approvalFile":"approval.json"}`。Mock 模式拒绝 `live` 配置块；live 模式缺少该配置块也会被拒绝。托管模型密钥只从指定私有文件读取，不读取环境变量中的隐式凭据。

usage-only 策略文件可以仅为 `{"metering":{"policy_id":"operator-usage-only"}}`，不含金额/累计次数/预算到期拦截；每次 HTTP 尝试的 usage/已知费用仍持久计量。该策略与下述可选 capped approval 互斥，不应把旧实验 caps 恢复到当前共享服务。操作员可用 `node dist/src/remote/main.js usage --config /absolute/gateway.json` 查询，不调用 hosted API。

若新安装明确采用有上限策略，其历史兼容审批文件包含两个对象：

- `authorization`：`approval_id`（字符串）、`expires_at`（未来 Unix 毫秒时间）、`synthetic_only: true`、`max_requests`（1–1000 的整数）、`max_cost_usd`（大于 0 且不超过 10）。
- `approval`：相同的 `approval_id`、`expires_at`、`max_requests`、`max_cost_usd`，另加 `reservation_usd`（大于 0、不超过 1，且足以覆盖 provider 每次尝试的预留金额）。

两个对象的对应值必须一致。网关持久存储会在每次托管请求尝试前预留预算，重试也计入。这些 capped 字段只适用于操作员明确选择的有上限部署；usage-only 不要求额外创建限额审批。需要强制 Jev 路由时，本地配置必须使用 `required_jev`。共享公网的当前 live 验收见本轮报告，新安装不能凭示例假设自己已经完成该配置。

## 历史 S10 hosted 小测（不是当前能力清单）

用户批准后的 C 阶段测试见 [实测报告](../artifacts/cross-machine/pilot/report.md)：正式题 3/9 成功，低置信度仍会停止。网关许可计时已修复重复扣减模型耗时的问题，并通过离线回归；实测成绩未用修复后的离线结果替换。这是当时的合成任务成绩；当前真实网页与配置 Android 的验证见本轮服务报告，任意桌面 App 和所有宿主兼容性不在当前保证范围。

`bench/remote/pilot.ts` 是受批准的试验工具，不属于当前13个 MCP 业务工具。它要求已存在的私有审批文件、固定同目录预算、独占输出和单次标记；不自动创建新批准或重置预算。`--continue-unstarted` 只允许旧正式题全未开始、失败预热零动作且账本已安全关闭的情形，最多一次，另存结果。该历史轮次已经完成正式题，不能用此入口重放它。`bench/remote/diagnose.ts` 只做一次不执行动作的模型耗时诊断，同样使用原预算，其 10 秒诊断超时不会改变执行器的许可。
