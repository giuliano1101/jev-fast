> 历史归档：此文件记录 2026-11-04 之前的集中服务设计。CLI/MCP/relay 代码已移除；下列地址、命令和操作步骤不再是当前使用说明。请看[本机接入](../../quickstart-agent.md)。

# 已部署共享服务：AI 接入与开关

更新：2026-11-02。实际契约、SDK 和真实网页/手机示例见[其他 AI 接入手册](../../other-ai-real-testing.md)；本轮实测见[服务报告](../../reports/2026-11-02-unrestricted-service.md)。

```text
https://jev.43-160-233-161.sslip.io/mcp
```

选择 **Streamable HTTP**，不发送 Authorization、OAuth 或模型 API key。公网域名使用 sslip.io，证书由 Let's Encrypt 签发；更换服务器 IP 需要相应更新域名和证书。`/` 返回 404 正常，使用 `/mcp`；`/health` 仅表示 relay 存活。

## 当前部署

共享 Mac `/tmp/jev-501` 使用操作员配置的 **remote · Jev / usage-only**，已配置 `android` MCP host。新 AI 复用该服务，不向用户索取 Key、profile、证书、付费额度或逐连接开关，不另起 mock、不停止或重启共用服务。

公网已部署 `autoAdmitAi: true` 与 `allowContinuations: true`：设备就绪时在 initialize 返回前即时准入新 AI。自动准入由可信服务端策略执行，不依赖短连接等待外部审批程序。名称只作展示，不是身份验证；AI 不获得管理 API 权限。操作员关闭原 owner、设备或本地总开关仍有效。

当前本地有 **13 个业务工具**，公网有 **16 个工具**：六个兼容 fixture 工具、`choose_action`、四个 `browser_*`、两个 `host_*`，以及网络专用 `network_status/request_status/release_connection`。真实网页在隔离的无头 Chromium 中运行，可以打开任意 HTTP/HTTPS URL，不复用日常 Chrome 登录态。手机只能使用操作员配置 backend 的实际工具。

本轮公网验证了两个独立 Example 网站会话、真实 Jev 导航、跨短连接的原 owner/请求恢复，以及 Android HOME 和前台应用回读。网站导航仍须检查 `navigation_pending` 并重新观察；不要把单次执行回执当成所有网站/应用稳定性的证明。细节和失败记录见[本轮报告](../../reports/2026-11-02-unrestricted-service.md)。

## 短连接宿主的必要流程

1. tools/list 后调用 `jev.network_status({})`。确认 `enabled`、`connector_online`、`local_ready` 为 true。
2. 将私密返回的 `continuation_token` 自动缓存在宿主上下文。它是服务生成的上下文能力，用户无需提供；不打印到聊天、报告或 Git。
3. 所有业务 arguments 使用 `{request_id, params, continuation_token}`；`request_status` 使用 `{request_id, continuation_token}`。
4. 即使每次调用都会新建并 DELETE MCP transport，仍用同一 token 继续原逻辑上下文。不同名称不会合并 owner，猜测 CID 也不能恢复权限。
5. `QUEUED/DISPATCHED` 查询原 request_id；`COMPLETED` 检查 reply 和实际业务后验。`UNKNOWN` 保留原键和上下文，禁止重放。
6. 正常结束先关闭自己的 browser session，再调用 `jev.release_connection({continuation_token})`。只 DELETE transport 会保留已签发 continuation 的逻辑 owner。

`CONTINUATION_INVALID` 表示 token 已失效或不属于当前运行实例，不证明旧动作没发生。relay 重启、release、手动关闭和 owner 代次变化都会使旧 token 失效。宿主须保留业务恢复编号，不能换键重做。

## 限额与计量

当前部署不设付费金额/累计次数/审批到期封顶、固定步骤、全局会话总数、队列长度或默认 AI/业务交付 TTL。调用者可显式设置自己的超时/步骤预算。独立浏览器会话可以并行；同会话互斥、同一手机顺序执行及设备/owner 心跳 fencing 是一致性约束。

每次实际 hosted HTTP 尝试记录 usage 和已知费用，缺失用量标为未知。[只计费说明](../../metered-service.md)继续适用，旧 S17“剩余 2 次”不再生效。16 MiB JSON/IPC 资源边界、TLS、私有文件、代次、幂等和 UNKNOWN 审计仍保留。

## 运维边界

Mac 协调器、连接器和真实网关是共享后台服务。自动 AI 准入不替代本地总开关，也不会自行批准新的执行设备。逐连接开关见[手动接入](../../manual-admission.md)，本机开关见[控制面板](../../control-panel.md)。操作员关闭后，原逻辑 owner 不会因新的网络调用自动复活；新的独立 AI 实例是否准入仍由当前部署策略决定。

管理入口仅监听 loopback，通过操作员私有隧道访问，公网不提供 provider、付费策略或开启服务的工具。原 Mac 的私有配置位于 `.runtime/`，不入库；连接器使用 `/tmp/jev-501/client-a.json`，路径需与 coordinator socket 记录一致，不能随意改成 `/private/tmp` 别名。

服务器部署路径和恢复程序见[部署运维文档](../../server-deployment.md)。维护前确认影响、保留审计；不要删除 journal/owner lock 处理不确定结果，不把历史报告中的手动启动/停止命令当作其他 AI 的接入步骤。当前服务开机恢复与长期网络稳定性须按实际运行状态核验。
