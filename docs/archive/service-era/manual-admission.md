> 历史归档：此文件记录 2026-11-04 之前的集中服务设计。CLI/MCP/relay 代码已移除；下列地址、命令和操作步骤不再是当前使用说明。请看[本机接入](../../quickstart-agent.md)。

# 免 Key 接入、手动开关与 continuation

日常操作已合并到[统一控制台](../../control-panel.md)：服务总开关、AI／设备开关、搜索和历史记录都在同一页。原 relay loopback 管理接口继续作为后台使用，不需要日常打开第二个页面。

本文描述手动接入的默认规则及可选部署策略。当前共享公网已启用 `autoAdmitAi: true`、`allowContinuations: true` 和真实 Jev 只计费；其他 AI 直接使用[接入手册](../../other-ai-real-testing.md)，不向用户索取 Key 或新审批。

设备/AI 不需要 OAuth 或预配网络 Key。名称来自连接方自报，不能证明身份；权限按随机连接实例、owner 和代次管理。管理 API 仅限操作员 loopback 入口，AI 工具不能自己开启。

## 默认与当前策略

| 私有服务端配置 | 行为 |
| --- | --- |
| 省略 `autoAdmitAi` 或为 false | 新 AI 默认关闭，由操作员逐实例开启 |
| `autoAdmitAi: true` | 已选择的设备就绪时，initialize 返回前自动完成 AI 首次准入；若当时设备未就绪，在后续工具调用重试首次准入 |
| 省略 `allowContinuations` 或为 false | 显式 DELETE 撤销该逻辑连接；新 transport 不继承它的权限 |
| `allowContinuations: true` | enabled 的 network_status 签发私密 continuation_token；此后 DELETE 仅移除 transport，原逻辑 owner 保留到 release、撤销或失效 |

这两个字段只在操作员私有 server profile 中配置，不是 MCP 参数。自动策略不会重新开启已被手动关闭或撤销的原 owner 代次；设备 off、本机总开关和代次 fencing 继续有效。新独立实例仍按当前策略处理，关闭某个实例不是按名称建立永久封禁名单。

## 操作员配置与控制台

[部署模板（历史版本）](https://github.com/giuliano1101/jev-fast/blob/e74756ea0fa6a1c171aa82d921cdfb87c75e81de/deploy/network)默认使用 `accessMode: "manual"`；旧 Bearer 示例另存于 `*.bearer.example.json`。服务端需 TLS、私有配置/数据目录，不需要 mcpTokenFile/connectorTokenFile。配置示意：

```json
{"accessMode":"manual","autoAdmitAi":true,"allowContinuations":true}
```

这里只展示策略字段，不是一份完整可启动配置。`sessionTtlMs` 可选，省略/null 表示不设置 AI 空闲到期；显式数值按操作员配置生效。

```sh
node dist/src/network/main.js server --config /absolute/private/server.json
node dist/src/network/main.js connector --config /absolute/private/connector.json
```

以上为操作员安装命令，其他 AI 不在共享 Mac 上重复启动。控制台完整私密链接由 relay 输出，只通过本机/操作员隧道访问，不公开管理 token。connector 的 `name` 为设备展示名；配置和 CA/凭据遵守 0600 文件、0700 直接父目录规则。一个 runtime 只运行一个手动 connector，其独占锁防止第二个进程撤销原进程 owner；不要删仍存活的锁。

控制台先开启自己的执行设备并等就绪。默认策略下再开启 AI；autoAdmitAi 策略下新 AI 首次准入自动完成。关闭 AI 会禁止新请求、拒绝其排队任务并发出取消/收尾；未收到执行器确认前显示正在停止。关闭设备同时撤销其 AI 授权。操作已完成的物理效果不能回滚，断网时关闭意图不等于已确认物理停止。

## 短连接恢复

公网业务工具共 13 个，均使用 `{request_id, params, continuation_token?}`。网络专用工具为：

| 工具 | arguments |
| --- | --- |
| `jev.network_status` | `{continuation_token?}`；就绪且策略允许时返回 token |
| `jev.request_status` | `{request_id, continuation_token?}` |
| `jev.release_connection` | `{continuation_token?}`；释放当前或指定逻辑上下文 |

宿主自动缓存 network_status 返回的 token，跨 DELETE、新建 transport 或不同名称时将它传回。它绑定原 CID、owner、generation，不授予任意身份；未携带 token 的新连接无法查询原请求。token 不进入业务参数指纹，不因 transport 变化重做物理动作。

持 token 的逻辑 owner 不因正常 DELETE 被撤销；临时 transport 自己的独立 owner 在未签发自身 continuation 时照常清理。结束后显式 release_connection。token 不公开打印，也不要求用户手填；relay 重启后内存 token 失效，业务审计仍保留，不能因此换键重放。

## 断线、撤销与一致性

- AI 默认无空闲过期；操作员显式 sessionTtlMs 仍有效。
- 设备心跳默认约 3 秒失联会撤销活动权限；本地 owner 续租失效也会取消/收尾。设备持久保存操作员 desiredEnabled 意图：同一注册恢复就绪心跳、旧撤销确认完成后可自动恢复设备；旧 AI owner/token 不复活。手动关闭清除该意图，新同名注册不继承。这是失联 fencing，不是任务时长配额。
- 手动 AI off、设备 off/失联、执行器实例变化和 release 会使原 continuation 失效。重新允许是新授权代次，不恢复旧物理任务。
- 原 request_id、goal_id、idempotency_key 保持稳定。UNKNOWN 禁止重放；匹配的权威结果可澄清交付状态。
- 一个 relay 选择一个执行设备，多个 AI/独立浏览器会话可以使用它；同一物理手机串行执行，同一会话有动作租约。

当前正式工具已支持真实 HTTP/HTTPS 浏览器及配置的 Android host，不再只有 fixture。工具 schema、真实调用示例和后验规则见[其他 AI 手册](../../other-ai-real-testing.md)。离线 HTTPS 测试覆盖默认关闭、自动首次准入、跨短 transport continuation、错误 token、release/off 取消、幂等恢复与大状态传输；当前公网证据见[本轮报告](../../reports/2026-11-02-unrestricted-service.md)。
