> 历史归档：此文件记录 2026-11-04 之前的集中服务设计。CLI/MCP/relay 代码已移除；下列地址、命令和操作步骤不再是当前使用说明。请看[本机接入](../../quickstart-agent.md)。

# 网络 MCP 与本机主动连接器

更新：2026-11-02。当前公网使用[免 Key 手动接入协议及操作员自动策略](../../manual-admission.md)，入口和真实示例见[其他 AI 手册](../../other-ai-real-testing.md)。本文保留可选 Bearer 模式的安装与交付语义；不要让当前共享服务的用户配置旧 Bearer 网络 Key。

## 架构与安装

AI → HTTPS Streamable HTTP relay → Mac 主动 connector → 私有 Unix socket → 本机 browser/host 执行器。云 relay 不执行浏览器点击，不接收本机 operator 凭据；Mac 不开放入站控制端口。当前每 relay 选择一台执行设备，不是多机任务调度器。

执行能力包括隔离无头 Chromium 的任意 HTTP/HTTPS 页面、操作员配置的外部 MCP host（当前共享部署为 android）、通用签名决策及兼容 fixture。模型决策与物理后验分开检查，不能把选择回执当成任务完成。

新安装需要 Node24.19+、锁定依赖与构建。仅执行机需要独立 Chromium；新安装默认 mock，真实 Jev 由操作员配置。共享部署已经配置 remote Jev/usage-only，其他 AI 不重复安装/启动/重启服务。

```sh
npm ci --ignore-scripts
npm run build
node dist/src/network/main.js server --config /absolute/private/server.json
node dist/src/network/main.js connector --config /absolute/private/connector.json
```

Bearer 安装使用 `deploy/network/*.bearer.example.json`：两份不同的 MCP/connector token，deviceId/agentId 与连接器匹配；AI 带 `Authorization: Bearer <私有MCP令牌>`。手动模式无需网络 token。两种模式的 TLS/CA/私有文件规则不变：当前用户拥有、0600、单链接普通文件、0700 直接父目录和绝对路径。配置 provider/设备/策略不是普通工具参数。

服务拒绝错误 Host、非法 Origin、无效/过期 Bearer，连接器验证证书/主机名且不跟随带凭据重定向。管理台仅 loopback。连接器不会自动启动协调器，执行前核对本机实例，并用同一次读取的客户端凭据完成预检和执行。

## 工具与网络 wrapper

本地 13 个业务工具：六个 fixture、choose_action、browser_open/observe/act/close、host_tools/act。网络增加 network_status、request_status、release_connection，共 16 个。以 tools/list 的实际 schema 为准。

业务 arguments：

```json
{"request_id":"caller-stable-uuid","params":{"url":"https://example.com"},"continuation_token":"TOKEN_FROM_STATUS"}
```

上例用于 browser_open；token 仅在手动模式允许 continuation 时使用，初次可省略。request_id 为 1–100 位字母/数字/下划线/短横线，推荐 UUID。params 是具体工具严格 schema；URL 属于 browser_open/navigate，fixture 的合成值约束不变。未知字段、任意脚本、伪造身份仍不合法。

手动模式在 enabled 的 network_status 返回 continuation_token，宿主自动私密缓存；所有后续业务、状态查询和 release 可携带它，跨新建/DELETE transport 保持原逻辑 owner。名称或猜测 CID 不能恢复上下文。Bearer 模式不签发 continuation；它依靠既有私有 profile 共享交付范围，不能拿手动模式 token 扩权，release_connection 返回不可用。

| 网络工具 | 参数 |
| --- | --- |
| network_status | `{continuation_token?}` |
| request_status | `{request_id, continuation_token?}` |
| release_connection | `{continuation_token?}`；手动模式释放原逻辑 owner |

业务调用返回交付信封：

```json
{"request_id":"caller-stable-uuid","delivery_status":"QUEUED"}
```

QUEUED/DISPATCHED 用 request_status 查原编号。COMPLETED 检查 reply.ok 后再判断实际 execution/后验/目标状态。读新的网页状态需新的 request_id，旧读取编号返回旧快照。响应不确定不改请求/幂等键；UNKNOWN 不允许重放。

## 持久交付与恢复

| 状态 | 含义 |
| --- | --- |
| QUEUED | 已持久受理，绑定当前执行器实例，尚未交付 |
| DISPATCHED | 已持久交付，不能再次派发 |
| COMPLETED | 已取得本地权威 reply，业务仍可能失败或未知 |
| REJECTED | 离线、未就绪、撤销或显式排队期限等拒绝 |
| UNKNOWN | 交付/结果不确定；只接受匹配原 nonce 的权威结果澄清 |

连接器先保存 claim 再执行，保存结果后上传；上传断线只重传原结果。只有 claim 没有结果的重启记录成为 UNKNOWN，不能重新执行。relay 重启拒绝旧 QUEUED，将旧 DISPATCHED 标 UNKNOWN。手动模式 continuation 只存在内存，relay 重启后旧 token 不可用，审计仍保留，须核对原编号而非换键重做。

没有固定排队数、历史记录数、同时在途数或业务默认队列/结果 TTL。新行 expires_at/result_deadline 可以为 null，旧数字期限仍可解析；显式操作员 queueTtlMs/responseTtlMs 实验配置仍生效。调用者 time_budget_ms/timeout_ms 被保留，省略不强加旧 65/70 秒上限。没有因删除 transport 就重放或取消已交付动作的规则；逻辑 release/off/失联 fencing 仍触发收尾。

connector 默认约250ms同步，失败退避；设备心跳租约默认约3秒，本地 owner 续租及代次规则仍负责失联 fencing。状态快照可能略滞后，实际执行前重新验证实例。独立浏览器可以并行，同会话动作和同物理 host 的串行规则属于一致性，不是全局单会话限额。

HTTP/IPC、通用 params、connector outcome 和网络审计行的技术字节边界为 **16 MiB**；JSON 深度与协议封装也有资源校验，不截断原始结果或绕过 UNKNOWN。provider 专用 fixture 决策/签名回执的独立 schema 边界不等于通用 host 截图上限。历史记录不自动删除，实际磁盘/内存故障照实返回。

## 开关和运维

本地总开关使用 operator kill/cancel/drain，即使云端断网也有效。普通 MCP 无开启服务、provider 或预算修改权限。关闭控制面板标签不等于停止后台协调器。

其他 AI 不停止共享服务或 connector。操作员维护 connector 时正常 SIGTERM，保存/收尾并尽力上传全部结果，网络错误保留 journal。崩溃恢复先确认旧进程已退出，备份私有目录，仅处理确认残留的锁；保留 SQLite/WAL/SHM，不能删除审计解除 UNKNOWN。

离线专项验证：

```sh
npm run build
node --test --test-concurrency=1 dist/tests/unit/network-*.test.js dist/tests/unit/admission-*.test.js dist/tests/integration/network-*.test.js
```

这些使用本机 HTTPS/SDK/隔离浏览器，不调用付费 API。当前公网真实结果、手机和短连接验证见[服务报告](../../reports/2026-11-02-unrestricted-service.md)；不据此承诺所有宿主、所有网站或互联网长期稳定性。
