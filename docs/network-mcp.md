# 网络 MCP 与本机主动连接器

> 本文保留 S14 **旧 Bearer 模式**的接线和恢复约定。当前默认模板已改为[免 Key、逐连接手动开关](manual-admission.md)，旧配置参考 `deploy/network/*.bearer.example.json`。两个模式的长断线/重新授权策略不同，请按实际 accessMode 使用。

这是新增的 HTTPS 接入层：AI 连接网络 MCP，Mac 连接器主动连接同一个服务器，再经现有私有 Unix socket 调用本机执行器。Mac 不需要开放入站控制端口。云端不执行浏览器点击，也不会收到本机 operator 凭据。

当前版本每个 relay 固定一个 `deviceId + agentId`，连接器固定本机 `client-a.json`。多设备需要独立 profile/relay，不提供任意设备选择。正式执行范围仍是 `standard` 合成 fixture 的十二类任务；本轮未将真实网页、App 和安卓研究适配器通用化，也未调用付费模型。

## 安装和启动

依赖 Node24.19+，安装和构建同 README。服务器只需要 Node 依赖，不需要安装 Chromium；Mac 作为执行机需要独立 Chromium。原开发 Mac 可在项目根目录先运行 `. scripts/env.sh`，其他机器使用自己的 Node。

```sh
npm ci --ignore-scripts
npm run build
npm run network:server -- --help
npm run network:connector -- --help
```

由操作员按[部署说明](server-deployment.md)准备私有配置、TLS、两份不同的网络 token。配置及引用的 TLS、CA、token 文件均为当前运行用户拥有、0600、单链接普通文件，直接父目录0700，不接受末端符号链接。所有路径为绝对路径。SQLite 数据目录是0700，数据库/锁文件0600。

服务器前台启动：

```sh
node dist/src/network/main.js server --config /absolute/private/server.json
```

Mac 前台启动：

```sh
node dist/src/network/main.js connector --config /absolute/private/connector.json
```

两者的 `deviceId/agentId` 和 connector token 必须一致。服务器只暴露 `/mcp`、`/connector/sync` 和无设备信息的 `/health`；不存在远程 Shell、服务开启/关闭、provider 或预算修改接口。

连接器启动不会启动本地协调服务。先用[本机面板](control-panel.md)启动相同 runtime 的协调服务，再连接 AI。连接器每次派发前检查本机服务实例，并在同一次操作中使用同一份新读取的客户端凭据，防止跨停止/重启切换执行。

## AI 如何连接

使用 MCP **Streamable HTTP**，地址如 `https://jev.example.com/mcp`，请求头 `Authorization: Bearer <操作员提供的MCP令牌>`。本版本是私有预配 Bearer 接入，尚未实现 OAuth 登录、自动发现和 token 自动续期。已验证官方 SDK 的 HTTP 客户端；需要 OAuth 登录的宿主仍需后续适配，不能声称已经兼容全部商业 AI 产品。[传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)与[鉴权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

服务器拒绝错误或过期 token、错误 Host、存在但不在 allowlist 内的 Origin。普通非浏览器 MCP 客户端可以不发送 Origin。没有 CORS 通配放行。TLS 保持证书和主机名验证；连接器不跟随带凭据的重定向。

本地 stdio 的六工具参数保持不变。**网络版本的六工具增加外层封装**：

```json
{
  "request_id": "open-001",
  "params": {"fixture_id": "standard"}
}
```

将该对象作为 `jev.open_session` 的 arguments。`request_id` 为1–100位字母、数字、下划线或短横线，每个新意图使用在本 profile 中唯一的编号（推荐 UUID），执行前由调用者固定；示例编号不供不同任务重复使用。它独立于 JSON-RPC ID 和 MCP 连接，断线重连继续使用同一个编号。`params` 按原来的严格 schema，未知字段、任意 URL/selector/脚本/坐标和非规范合成文本都拒绝；provided goal.values 和 field 成功条件也校验对应 seed 的固定值。

六工具为 `jev.open_session/observe/run_goal/cancel/status/close_session`，网络额外提供两个不派发执行动作的工具：

| 网络工具 | 参数 | 用途 |
| --- | --- | --- |
| `jev.network_status` | `{}` | 查看连接器在线、本机是否就绪及实例编号 |
| `jev.request_status` | `{"request_id":"open-001"}` | 查询该网络请求的持久状态与原始本地结果 |

调用会先返回网络受理状态，不会阻塞到整个任务完成：

```json
{"request_id":"open-001","delivery_status":"QUEUED"}
```

随后调用 `jev.request_status` 获取终态。打开会话完成后的 `reply.result.session_id` 用于后续操作：

```json
{
  "request_id": "form-001",
  "params": {
    "session_id": "返回的会话编号",
    "goal_id": "goal-001",
    "idempotency_key": "goal-key-001",
    "goal": {"task":"form","language":"zh","seed":1},
    "success": {"kind":"task_complete"}
  }
}
```

同一 request_id 加同一规范化工具/参数只返回已有记录。修改工具或参数返回 `IDEMPOTENCY_CONFLICT`。同一 run_goal 还要保留 goal_id 和 idempotency_key；不能因网络层返回 UNKNOWN 而换编号重做。读取当前新状态时使用新的 request_id，重用旧读取编号会获得旧读取结果；`request_status` 本身直接查询网络账本。

## 状态与断线恢复

| delivery_status | 含义 | 后续动作 |
| --- | --- | --- |
| QUEUED | 已持久受理，绑定当前本机实例，尚未交付 | 查询原编号 |
| DISPATCHED | 已持久交付，禁止重新派发 | 查询原编号 |
| COMPLETED | 已取得本机的权威 reply | 检查 reply.ok 和实际 goal.status |
| REJECTED | 离线/未就绪或队列过期等导致拒绝 | 先查明原因；重新执行需明确的新请求意图 |
| UNKNOWN | 网络交付/结果不确定，禁止重放 | 等待原结果回传或检查本地账本 |

`COMPLETED` 不是任务成功率：reply 可以是错误，也可以包含本机 GoalStatus `FALLBACK/CANCELLED/UNKNOWN`。本机 goal UNKNOWN 仍隔离会话，不会因网络请求完成而解除。为给 MCP JSON 封装留出空间，连接器只回传规范化后不超过24,000字节的 outcome；更大的 IPC 结果保守标为网络 UNKNOWN，不截断或重放。HTTP 请求/响应另有64KiB边界。每个私有 store 最多10,000条记录，达到上限拒绝新记录，不自动删除历史；初版未实现长期归档。

断网时，已接收的有界本地任务可以继续执行并落账，不把 TCP 断开当作自动取消。连接器先保存本地结果，再上传；网络恢复只重传同一份结果。已交付却丢失的请求不再交付。连接器重启时，只有已保存的结果可重传；只有 claim 而没有保存结果的记录成为网络 UNKNOWN。后续到达的匹配权威结果可澄清网络 UNKNOWN，不重复动作。

默认连接器每250ms同步、每个连接器最多4个本地在途调用，网络失败退避至1秒；本地核心仍执行会话/目标租约仲裁，冲突可以返回 BUSY。relay 默认连接器租约3秒、未交付队列有效期5秒、交付结果等待上限70秒，均有代码上限。network_status 是最后一次心跳的租约快照，断网或本机刚刚切换时可能短暂显示旧实例/旧就绪；每次执行前还会以实际本机实例重新校验。超时只改变交付状态，不代表撤销本地物理动作。

服务关闭或重启会改变本机实例；旧排队任务不能跨实例执行。服务器已观测到离线或本机未开启时，提交的请求会持久拒绝，不会在稍后开启后自动执行。心跳尚未更新的短窗口内可能仍受理为 QUEUED；短队列期限、租约及执行前实例校验共同限制这类请求，不能把缓存就绪视为实时授权。同 profile 的第二连接器会被 fencing 拒绝；正常切换连接器进程时，先停止旧进程，等待旧在线租约消失，再启动新进程。

## 本机开关与停止

面板的“停止服务”继续使用本地操作员 kill/cancel/drain，不经过网络服务器。即使云端断网，它仍能阻止新动作并收尾。云端没有开启本机服务的工具。关闭浏览器面板标签页本身不会停止协调服务。

停止连接器用其终端 Ctrl+C；它会等待当前本地 IPC 收尾，保存结果并尝试上传，失败保留私有 journal。它不会停止协调服务。停止 relay 用对应终端 Ctrl+C，保留网络账本。MCP 请求丢失时保持原 request_id，重连后调用 request_status，不盲目重复。

不提供任意崩溃后的自动删锁恢复。relay 和 connector 的 `owner.lock` 是排他所有权标记。若被 SIGKILL/掉电：先确认原进程已退出且没有第二实例，备份整个私有状态目录，再仅移除确定残留的 owner.lock，保留 network.sqlite 和 WAL/SHM；然后启动原配置。新 relay 对旧 QUEUED 拒绝、旧 DISPATCHED 标为 UNKNOWN；新 connector 对没有结果的 claim 标 UNKNOWN。数据库、身份/端点绑定或文件权限损坏时保持拒绝，不能清空账本绕过。

## 仍未验收的范围

本机可重复运行全部网络专项验证（临时 TLS/账本和隔离浏览器，不调用付费 API）：

```sh
npm run build
node --test --test-concurrency=1 dist/tests/unit/network-*.test.js dist/tests/integration/network-*.test.js
```

relay/connector 的 token、租约和交付 TTL 使用系统墙钟；要求主机保持正常时间同步。运行中回拨系统时间可能延长网络层的名义窗口，本阶段未实现网络层时钟回拨防护；发现此类操作时应停止连接器/relay，保留账本并核对后重启。本机核心动作预算仍使用原有单调时钟边界。

本机回环 HTTPS + 实际 SDK + 隔离浏览器验证不等于已部署公网或实体双机验收。本次不启用真实网站/App/Android，不启动 hosted Jev，不改变旧预算。初版只支持每 relay 一组预配身份；OAuth、自动续期、多设备选择与互联网长期稳定性留待后续部署阶段。
