# 已部署服务：AI 接入与服务开关

本阶段的公网 MCP 地址：

```text
https://jev.43-160-233-161.sslip.io/mcp
```

传输使用 **Streamable HTTP**，无需 Authorization、OAuth 或网络 API key。地址使用免费的 [sslip.io/nip.io IP 映射 DNS](https://nip.io/)，HTTPS 使用服务器单独申请的 Let's Encrypt 证书。它不是自有注册域名；更换服务器公网 IP 后需要更换地址和证书，公共 DNS 的可用性也依赖服务提供方。

## 当前部署状态（2026-11-01，S18 只计费）

已经开启真实服务，无需 AI 再向用户索取模型 API key、profile、证书或逐连接开关。Mac 面板显示 **运行中 / remote · Jev / 已连通**。公网 MCP 的真实验收目标完成，动作回执 `route: jev`，上游 HTTP 200；详细证据见[本轮报告](../artifacts/live-service/report.md)。

操作员按最新要求启用了本机自动接入程序，接受任意非空 AI 展示名，自动开启新 AI 会话；协议本身仍默认关闭，不同 AI 的结果仍隔离。名称只是展示信息，不是身份验证。自动接入是这台 Mac 的部署策略，不会随 clone 自动安装，也不是 AI 工具的管理权限。

1. AI 宿主选择 Streamable HTTP，填上面的 `/mcp`，无需 Authorization。
2. 初始化时设置 `clientInfo.name`；等待 `jev.network_status` 的 `enabled: true`。自动接入存在短暂轮询延迟，未开启时先等状态，不重复发送业务请求。
3. 使用下方固定契约，保留 request_id 和业务幂等键。工作结束仅关闭自己的 MCP/业务会话，不要停止共用协调器、连接器或网关。

本机总开关仍可停止实际执行。当前自动接入程序持续允许新 AI，因此若操作员要撤销自动接入策略，应先暂停该程序再管理接入开关；单个新会话的“关闭”不是永久屏蔽名单。

协调器、真实网关及配置了私有 remote profile 的本机面板已经独立后台运行，不随本次对话结束主动关闭。当前未承诺 Mac 重启后自动恢复。

**付费策略已按用户最新要求改为只计费**：不设金额封顶、累计调用次数上限或预算有效期。S17 的“剩余 2 次”已失效，旧父/子预算保留但不再拦截当前服务。每次实际 HTTP（含失败和重试）记录 token 和已知费用，缺失用量明确标为未知。如何查看费用见[只计费使用说明](metered-service.md)和[本轮报告](../artifacts/metered-service/report.md)。各 AI 直接连接，不需再次向用户申请额度。

当前已打开的新版本机面板固定使用真实配置；根目录通用 Finder launcher 仍是新安装用的默认 mock 启动入口，不要用它替换正在运行的面板。维护和恢复路径见本轮报告。

## AI 连接示例

不同宿主的配置字段不同；选择“远程 MCP / Streamable HTTP”，填上面的 URL 即可，不应填入模型 API key。下面是本轮实际验证的 MCP SDK 调用方式，便于其他 AI 检查协议兼容性：

```js
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({name: 'Your AI Name', version: '1.0.0'}, {capabilities: {}});
const transport = new StreamableHTTPClientTransport(
  new URL('https://jev.43-160-233-161.sslip.io/mcp'),
);
await client.connect(transport); // 不发送 Authorization
const tools = await client.listTools();
console.log(tools.tools.map(tool => tool.name));
const response = await client.callTool({name: 'jev.network_status', arguments: {}});
const status = JSON.parse(response.content.find(item => item.type === 'text').text);
console.log({admission: status.admission, enabled: status.enabled});
// 等待 enabled === true；尚未开启时，动作工具返回 ADMISSION_REQUIRED。
await transport.terminateSession();
await client.close();
```

实际部署验收使用 `@modelcontextprotocol/sdk@1.32.2`。发现的工具为六个动作工具，以及 `jev.network_status`、`jev.request_status`。网络动作参数必须包含稳定的 `request_id`：

```json
{
  "name": "jev.open_session",
  "arguments": {
    "request_id": "example-open-001",
    "params": {"fixture_id": "standard"}
  }
}
```

接入实例开启后才可运行；当前由操作员的自动接入程序处理。响应不确定时查询原 request_id；UNKNOWN 不允许换编号重放。详细契约见[手动接入说明](manual-admission.md)和[AI 快速开始](quickstart-agent.md)。

## Mac 连接器和私有隧道

本轮 Mac 连接器的私有配置：
`/Users/yubinai/Documents/jev/.runtime/public-connector/connector.json`。
状态和 journal 留在同目录，未上传 GitHub。连接器使用 `/tmp/jev-501/client-a.json`，与面板和协调器 socket 记录的路径文本保持一致。macOS 的 `/tmp` 与 `/private/tmp` 虽指向同一目录，凭据安全校验仍要求直接父目录字符串与 socket 路径一致，不能混用这两个别名。服务尚未启动时没有该凭据，连接器仍可登记为待开启，但不会就绪或执行。

首次开启时已修正本机私有配置中的旧别名，保留原 journal，并为新连接使用独立的 `journal-runtime-tmp` 目录；没有删除审计、修改凭据验证规则或重启协调服务。已实际验证修正后的凭据读取和本机健康检查通过。

需要重新启动连接器时，先确认原进程已经正常停止，再运行：

```sh
# 本机已验证的 Node 绝对路径；其他机器使用其自己的 Node24.19+
/Users/yubinai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/yubinai/Documents/jev/dist/src/network/main.js connector \
  --config /Users/yubinai/Documents/jev/.runtime/public-connector/connector.json
```

停止连接器使用其进程的 SIGTERM 或所在终端的 Ctrl+C；不要清 journal、删锁或换编号处理未知结果。新连接器进程会得到新的待审批实例。状态无法确认时按[运维手册](cross-machine-operations.md)检查。

本轮 SSH 隧道和连接器由当前 Codex 的后台会话维持；关闭对应会话或断网会影响它们，并未安装开机自启。服务器本身的 systemd 服务继续独立运行。SSH 断开后，这台 Mac 可使用已验证的原有 SSH 身份和已知主机校验重连，下面仅包含私钥文件位置、不包含密钥内容：

```sh
ssh -N -T -i /Users/yubinai/.ssh/dotwi_deploy \
  -L 127.0.0.1:47832:127.0.0.1:47832 \
  -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
  ubuntu@43.160.233.161
```

本轮复用了原有私钥和主机记录，没有新增或修改 SSH 凭据或服务器认证。隧道恢复后用服务器私有日志中的完整管理链接重新打开页面；不要将日志或链接放进聊天、GitHub或公网。

## 服务维护和边界

服务器安装位于 `/opt/jev-fast`，独立 Node 位于 `/opt/jev-node-v24.19.0`，服务名 `jev-network`。日常查看使用 `sudo systemctl status jev-network`，停止使用 `sudo systemctl stop jev-network`。没有配置自动重启或开机启动；异常退出保留账本和锁，先核查再恢复。重启后的接入需重新批准。

Nginx 只代理 `/mcp`、两个 connector 路径及 `/health`。`/` 返回404是预期行为；管理台不在公网根目录。证书续期使用既有 Certbot，新增 hook 仅匹配本证书，再校验和 reload Nginx；真实长期续期需继续观察。

**当前正式执行器仍限内置 standard fixture 的十二道任务。** 公网部署没有新增任意网页、桌面或手机控制能力。此次“使用 Jev 部署”由独立研究选择器选择固定、脱敏的部署步骤，主机通过 CUA/协议工具执行和验收；它不能自动生成任意服务器命令，也不是部署速度对照实验。S17 已配置真实 profile；S18 根据用户随后明确指令改为无付费上限的只计费策略。新的 AI 只需连接，不管理模型配置或审批。

本轮结果和限制见[部署报告](../artifacts/public-deployment/report.md)。
