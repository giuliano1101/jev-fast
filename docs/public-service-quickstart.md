# 已部署服务：接入与手动开关

本阶段的公网 MCP 地址：

```text
https://jev.43-160-233-161.sslip.io/mcp
```

传输使用 **Streamable HTTP**，无需 Authorization、OAuth 或网络 API key。地址使用免费的 [sslip.io/nip.io IP 映射 DNS](https://nip.io/)，HTTPS 使用服务器单独申请的 Let's Encrypt 证书。它不是自有注册域名；更换服务器公网 IP 后需要更换地址和证书，公共 DNS 的可用性也依赖服务提供方。

## 现在如何开启

1. Chrome 中已打开 **Jev 接入控制台**。它通过仅绑定本机的 SSH 隧道访问 `http://127.0.0.1:47832/`，公网不能访问管理端口。完整管理链接含有本次启动的私有片段，不能分享；页面加载后会从地址栏移除。
2. 在已有 **Jev · 本地服务控制** 标签页点击“启动服务”。两张已有标签页都指向 `/tmp/jev-501`。也可双击仓库根目录 `打开Jev控制面板.command`。当前默认离线 mock；启动不执行任务、不消耗模型额度。
3. 在接入控制台，核对 **Mac mini · Jev connector** 后点击“开启”。本轮已启动连接器，当前仍等待你开启；本机总开关保持原来的关闭状态。
4. 让 AI 宿主以 Streamable HTTP 连接上面的 `/mcp`。AI 的 `clientInfo.name` 是控制台展示名，新会话默认关闭。核对它后手动“开启”，再运行任务。
5. 逐项关闭使用接入控制台；关闭全部本机执行使用 Mac 面板的“停止服务”。云端不能代替你开启本机服务。离线连接不能开启，停止中需等待连接器确认。

控制台里的 `Jev Deployment Acceptance Mac` 是本轮已关闭的协议验收客户端，显示离线是正常结果；它没有获准执行过动作。名称由对方自报，不是身份验证。新同名会话不会继承旧权限。

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
// 尚未人工开启时，动作工具返回 ADMISSION_REQUIRED。
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

只有人工开启后才可运行。响应不确定时查询原 request_id；UNKNOWN 不允许换编号重放。详细契约见[手动接入说明](manual-admission.md)和[AI 快速开始](quickstart-agent.md)。

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

**当前正式执行器仍限内置 standard fixture 的十二道任务。** 公网部署没有新增任意网页、桌面或手机控制能力。此次“使用 Jev 部署”由独立研究选择器选择固定、脱敏的部署步骤，主机通过 CUA/协议工具执行和验收；它不能自动生成任意服务器命令，也不是部署速度对照实验。真实模型执行任务仍需另行配置有效的本机 profile 和明确预算，本次部署选择额度不会自动用于其他目标。

本轮结果和限制见[部署报告](../artifacts/public-deployment/report.md)。
