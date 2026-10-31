# 网络 MCP 部署准备与操作说明

本阶段完成代码、私有配置模板和本机网络回归，**尚未部署到真实服务器**，也未完成 Linux、公网、实体双机或特定商业 AI 宿主的验收。服务器控制台登录到本机浏览器后，可以继续由当前开发流程操作指定服务器；不需要把登录密码或 API key 发进聊天。

## 到部署时需要准备

1. 一台你已选定、可安装服务的服务器，以及浏览器里已登录的控制台/终端。计划使用 Linux；需要 Node24.19+、npm、Git、可写持久磁盘和非 root 服务用户。不需要 GPU，也不需要在云端安装浏览器。
2. 一个可配置 DNS 的域名，及对外 HTTPS。推荐443；若先直连8443，URL 与 publicHost 必须都带 `:8443`。使用443时由现有代理/负载均衡转发，或另行配置非 root 绑定权限，不以 root 长期运行 Node。
3. 允许 Mac 主动访问服务器 HTTPS。Mac 不开放入站控制端口；服务器不能直接暴露本机 Unix socket 或操作面板。
4. 指定首个 AI 宿主及其连接方式。本版验证了支持显式 Authorization Bearer 的 SDK 客户端；要求 OAuth 登录/自动发现的宿主需要后续认证适配，不能只填一个 URL 就假设可用。
5. Mac 上对应的本地 runtime、client-a 路径，以及是否保持默认 mock。连接云端 relay 不需要 hosted Jev API key；若以后启用真实模型，另按现有私有 profile 和有效预算授权处理。

CPU/内存和公网延迟的容量需求会按你的实际服务器做上线试运行评估；当前没有生产负载结论。不会在准备阶段购买服务器、修改未指定账户或替你批准模型费用。

## 部署文件

[deploy/network](../deploy/network/) 包含服务端与连接器 JSON 模板、systemd 模板和说明。模板是直接 TLS8443 示例；部署时替换域名、路径和身份，不能直接使用 example.com 或占位路径。

| 位置 | 应保存的内容 |
| --- | --- |
| 服务器 `/opt/jev-fast` | 指定 Git commit 的源码和 dist |
| 服务器 `/etc/jev-network` | 0700，服务用户拥有的0600配置、TLS证书/私钥、两份token |
| 服务器 `/var/lib/jev-network` | 0700持久账本，保留 SQLite/WAL/SHM/owner.lock |
| Mac 私有目录 | 0700，0600 connector配置、connector token及可选CA，独立journal目录 |
| AI 宿主私有设置 | MCP URL及MCP token，不能使用connector或本机operator凭据 |

两份网络 token 分角色，不能相同。本机 client-a/本机 operator/网络 MCP/网络 connector/模型 API key 是不同用途，不相互替代。不要把真实文件写回模板目录或 Git。

## 构建和安装

在准备好的服务器 checkout 中：

```sh
node --version
npm ci --ignore-scripts
npm run build
node dist/src/network/main.js server --help
```

服务器不执行 `npx playwright install`；实际操作仍在 Mac。使用已有 [source release 工具](cross-machine-operations.md)可以打包和校验源码，也可以 checkout 指定提交。控制台支持文件上传时，可上传已校验的源码包；整个 `.runtime` 不上传服务器。

为服务配置专用非 root 用户和上述私有目录。将有效的域名 TLS 证书和私钥复制进服务用户可以读取的私有目录。CA/证书虽包含公开信息，当前加载器仍要求0600和直接父目录0700。证书续期后的替换/服务重启流程在部署环境验证；此阶段没有自动续期逻辑。

## 安全生成网络凭据

在已准备的私有目录内运行 Node，创建短期 token 文件，不打印 token、不覆盖已有文件。这里生成的是网络接入凭据，**不是模型付费审批文件**：

```sh
node --input-type=module <<'JS'
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
for (const file of ['mcp-token.json','connector-token.json']) {
  writeFileSync(file, JSON.stringify({
    token: randomBytes(32).toString('hex'),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  }) + '\n', {flag:'wx',mode:0o600});
}
JS
```

通过已授权的私有渠道把 connector-token 文件放到 Mac，把 MCP token 配到目标 AI 宿主；不粘贴到聊天或公共日志。Token 到期后服务拒绝该角色请求。本版没有热重载；轮换需安全停止相应进程、更新私有文件后重启并保留账本。即使 bearer 仍有效，Mac 本地服务关闭时也不允许执行。

## 启动与验证

服务端配置参考 `server.example.json`。`publicHost` 必须精确对应 AI/connector 访问的 HTTPS URL 的 Host；代理要保留这个 Host。`allowedOrigins: []` 允许未发送 Origin 的鉴权非浏览器客户端；若目标宿主发送 Origin，显式填入其受信 HTTPS Origin，不使用 `*`。

```sh
node /opt/jev-fast/dist/src/network/main.js server --config /etc/jev-network/server.json
```

`GET https://你的域名/health` 只验证 relay 可达；不代表连接器或本地浏览器就绪。调用 MCP initialize 和 tools/list 验证协议，再调用 `jev.network_status` 查看心跳租约。默认不提供 SSE GET 推送，采用 stateless JSON response 和业务 request_id 查询恢复。

Mac 安装匹配提交、依赖和 Chromium，复制并填写 connector 配置，然后：

```sh
node /absolute/checkout/dist/src/network/main.js connector --config /absolute/private/connector.json
```

只有自签/私有 CA 时显式填 `caFile`；公开 CA 可省略以使用系统信任库。没有跳过 TLS 检验的参数，不把凭据跟随重定向发送。

Mac 的本机面板选择同一 runtime。先保持本机服务关闭验证远程拒绝，再开启默认 mock，按[网络使用手册](network-mcp.md)提交 open_session / run_goal / request_status / close_session。部署验收还需实测公网中断、连接器恢复、本机开关和目标 AI 宿主鉴权，不能只看 `/health` 为200。

## 进程管理、恢复与回滚

可按实际 Node 路径安装 `jev-network.service` 模板；它不会自动重启，也不会删除锁。启动前用 foreground 模式验证 TLS、Host 和私有权限。配置、store目录应属于同一服务用户。模板需要部署时在实际 Linux/systemd 环境验收，本阶段没有声称已运行它。

停止 relay/connector 使用 SIGTERM 或 Ctrl+C。连接器先等待在途 IPC 保存结果，再尝试回传；未回传的结果保留在 journal。停止连接器不停止本地协调服务。本地紧急停止始终用本机面板，不依赖云端在线。

如果进程异常退出留下 owner.lock，按[网络手册的残留锁流程](network-mcp.md)确认旧进程死亡、备份完整私有目录，再只处理已确认残留的锁。不得清空账本、手工把 UNKNOWN 改成成功或换ID重复可能已发生的动作。不同机器/PID命名空间的锁不能只按本机 PID 猜测，需要检查实际服务进程。

回滚先停止 relay 和连接器，保留其私有数据，再切换匹配的提交。旧版本不能读新网络账本时保持停止；不要为了回滚删除审计。已有 CLI/MCP 本地核心可独立运行，本地面板也保持可用。
