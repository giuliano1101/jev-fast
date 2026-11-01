# 免 Key 接入与手动开关

本文描述默认接入协议。当前部署已由操作员启用自动 AI 接入和只计费，使用[其他 AI 测试说明](other-ai-real-testing.md)；不要求使用者逐次索取密钥或额度。下文的手动开启步骤用于默认/其他部署，不能据此推断当前共享服务未授权。

设备和 AI 不需要登录、OAuth 或预先配置网络 Key。接入后会出现在控制台，默认待启用；你核对名称和连接编号后，分别开启设备与 AI，才允许执行任务。

名称由连接方自报，不能证明“确实是我们自己的”。系统按独立连接实例管理权限；相同名称的新连接仍默认关闭。后台的随机 MCP session/设备 handle 是连接能力编号，持有者可使用该连接；它们不是实名认证，也不要公开分享。控制台的管理入口仍只绑定本机回环地址，外部连接不能自己开启。

## 配置与打开

[部署模板](../deploy/network/)的默认 server.example.json 与 connector.example.json 已改成 `accessMode: "manual"`。旧 Bearer 方式保留在 `*.bearer.example.json`，已有旧配置不被静默改写。

服务端仍需 TLS 证书、私有配置和数据目录，但不再需要 mcpTokenFile/connectorTokenFile：

```sh
node dist/src/network/main.js server --config /absolute/private/server.json
```

终端会输出本次启动的“接入控制台”本机链接。完整链接只给操作员使用，打开后页面会移除地址栏片段，并用本标签 sessionStorage 支持刷新。若部署在服务器，管理端口只监听127.0.0.1；通过已登录控制台的端口访问能力或操作员 SSH 隧道访问，不把管理端口转发成无保护公网网页。`adminPort` 可指定固定端口，例如47832。

Mac connector 配置用 `name` 设置设备展示名，不需要 tokenFile。私有配置、CA/证书仍沿用0600、直接父目录0700的文件规则。连接器只主动发 HTTPS，不增加 Mac 入站端口：

```sh
node dist/src/network/main.js connector --config /absolute/private/connector.json
```

同一本地 runtime 只运行一个手动连接器，替换进程前先退出旧进程；仅关闭它的接入开关不等于退出进程。连接器在 runtime 中持有独占 `network-connector.lock`，防止不同 journal 的第二进程撤销第一个进程的授权。异常退出后须确认旧进程已死亡、保留账本，再处理确认残留的 runtime 锁及 journal 的 owner.lock；不要删除仍存活 coordinator 的 service.lock。

AI 使用普通 Streamable HTTP MCP 地址，例如 `https://jev.example.com/mcp`，无需 Authorization。AI 展示名来自标准 initialize 的 clientInfo.name；不同宿主如何填写由宿主配置决定。本地 stdio/CLI 不受影响。当前仍是一个 relay 选一个执行设备，可接入多个 AI；不会同时调度多台设备。

## 控制台操作

1. 启动 Mac 本地协调服务，保持与 connector 的 client-a.json 路径相同。
2. 接入控制台会显示设备和 AI 的名称、类型、短连接编号、首次/最近连接时间及状态。
3. 先开启自己的设备，等待执行器就绪，再开启自己的 AI。设备开关表示允许该连接接收任务，不替代 Mac 本机服务总开关。
4. 未开启的连接可以登记、发现工具、查看自身接入状态，不能执行任务或读取其他连接的结果。
5. 关闭一个 AI，立即禁止它的新请求并拒绝旧排队任务；已在执行的任务会取消并收尾，页面在收到执行器确认前显示“正在停止”。
6. 关闭设备会同时撤销它的 AI 授权。重新开启设备后，AI 需要重新手动开启，不自动恢复旧任务。

已完成的点击不能撤销。云端断网时，逐连接关闭可能暂时等不到执行器确认；Mac 本机总开关仍可直接停止执行器。不要把“已保存关闭意图”解释为物理动作已经回滚。

## 同名、重连与重新开启

- 同名连接分别显示不同编号，逐个开关；允许一个名称不会允许所有同名连接。
- 同一 MCP session 的短暂 HTTP 中断可继续使用原连接；正常 HTTP 请求结束不是退出 MCP。
- 显式 DELETE/session 终止或默认30分钟无活动会撤销该 AI；新建 session 必须重新开启。部分 SDK 的 Client.close() 只关闭客户端 transport，并不发送 DELETE；及时退出需 terminateSession 或等会话过期。
- 同一 connector 进程短时重连保留 handle。设备心跳超过默认3秒失联会关闭接入权限，重新连上后需要手动开启。
- 本地网络 owner 采用5秒租约；没有成功续租会取消并收尾，过期授权不能自动复活。连接器会报告失效状态，等待手动重新开启。
- 新 connector 进程和 relay 重启需要重新核对/开启。本地执行器实例变化会撤销 AI 授权，需重新开启 AI；设备连接本身是否仍允许，以控制台状态为准。名称不会恢复历史授权。

重新开启产生新的执行授权代次和本地 owner。旧浏览器会话不能继续使用，需要新建会话。原请求结果仍保留在账本，旧 UNKNOWN 不重放。若停止还未确认，等待原设备或有资格的同执行器替代连接确认收尾；不同设备不能替旧设备证明它已经停止。

## AI 工具调用

工具仍为六个网络操作和两个只读状态工具，操作参数保持外层 `{request_id, params}`：

```json
{"request_id":"唯一的新请求编号","params":{"fixture_id":"standard"}}
```

示例中的请求编号应换成1–100位字母、数字、下划线或短横线（推荐 UUID）；不要原样提交中文占位文字。返回 QUEUED 后调用 `jev.request_status` 查原编号。网络 delivery_status 为 COMPLETED 后，还要检查 reply.ok 和实际 goal.status。

不同 AI 可以使用相同业务编号，各自读取自己的记录。AI B 不能读取、取消或操作 AI A 的核心会话；名称相同也不会合并。短时重连仍保持原 request_id/goal_id/idempotency_key，不因丢响应换编号重做。

当前主流程依旧只支持 standard 合成任务。免 Key 接入不会让已有真实站点/App/Android研究适配器自动成为通用能力，也不批准模型费用。

## 验证与限制

本机测试用实际 HTTPS SDK、无 Authorization 请求、隔离浏览器和控制台 UI 验证登记、待启用、开启后执行、同名连接隔离、关闭/重新开启与结果不重放。S16另在指定Ubuntu服务器验证公网TLS/SDK初始化、默认拒绝执行、私有管理台和未授权Mac连接器心跳恢复，见[报告](../artifacts/public-deployment/report.md)及[实际接入说明](public-service-quickstart.md)。目标商业AI宿主、已批准公网在途任务及实体第二电脑仍需后续验收。接入无身份验证，不能仅凭名称判断设备归属；管理边界、TLS、请求大小和连接数量限制继续保留。

旧 S14 Bearer 网络协议的使用和恢复说明仍见[网络手册](network-mcp.md)。手动接入的长断线和重新审批策略比旧模式更保守，不能混用二者的恢复假设。
