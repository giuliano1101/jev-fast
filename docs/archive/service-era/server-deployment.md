> 历史归档：此文件记录 2026-11-04 之前的集中服务设计。CLI/MCP/relay 代码已移除；下列地址、命令和操作步骤不再是当前使用说明。请看[本机接入](../../quickstart-agent.md)。

# 网络服务部署准备

当前默认采用[免 Key 接入与手动开关](../../manual-admission.md)：AI/设备不需要登录或配置网络 Key，新连接在控制台等待你开启。旧 S14 Bearer 模式作为可选兼容方式保留。

**S16 已在指定 Ubuntu 24.04 服务器完成公网 relay 部署。** 实际地址、Mac 连接器和开关步骤见[已部署服务说明](../../public-service-quickstart.md)，结果与尚未验证的范围见[报告](../../../artifacts/public-deployment/report.md)。本页保留通用部署要求；可重复使用的分阶段脚本及恢复限制见[部署工具说明（历史版本）](https://github.com/giuliano1101/jev-fast/blob/e74756ea0fa6a1c171aa82d921cdfb87c75e81de/deploy/network/PUBLIC_DEPLOYMENT.md)。没有购买服务器或域名；本次固定部署步骤的 Jev 选择使用了用户另行批准的限时额度。

## 需要准备

1. 已选定的一台服务器，以及浏览器里已登录的控制台/终端。需要可安装 Node24.19+、npm、Git，创建非 root 服务用户和持久数据目录。云端不运行浏览器或模型，不需要 GPU。
2. 可配置 DNS 的域名与 HTTPS。推荐443；初次直连8443时 URL 和 publicHost 都带`:8443`。443通过准备好的代理/负载均衡或非 root 绑定权限处理，不以root长期运行Node。
3. Mac 能主动访问服务器HTTPS。Mac不开放入站控制端口。告知首个AI宿主，以验证它的无Authorization、stateful Streamable HTTP接入与实际clientInfo名称。
4. 操作员访问接入控制台的路径：该控制台只监听服务器127.0.0.1。可以通过已有控制台的私有端口访问能力，或操作员SSH隧道访问；管理端口不直接公开。
5. Mac本地runtime与client-a路径，保持和本机总开关一致。默认mock；手动开启连接不启用hosted Jev、不续期旧预算。

## 文件与权限

| 位置 | 内容 |
| --- | --- |
| 服务器 `/opt/jev-fast` | 指定commit的源码和dist |
| 服务器 `/etc/jev-network` | 0700目录内的0600服务配置、TLS证书和私钥 |
| 服务器 `/var/lib/jev-network` | relay及接入登记/请求映射审计，保留SQLite/WAL/SHM和锁 |
| Mac私有目录 | connector配置、可选私有CA、journal；不需要tokenFile |
| AI宿主 | MCP HTTPS地址，普通初始化即可；无需Authorization |

TLS用于连接加密和验证服务器，仍需证书；它与用户不想配置的AI/设备登录鉴权不同。私有配置/TLS/CA由服务用户拥有、0600、单链接普通文件，直接父目录0700，不接受末端符号链接。会话/连接handle不要公开；名字不是身份凭据。

## 安装与运行

服务器安装锁定依赖并构建：

```sh
node --version
npm ci --ignore-scripts
npm run build
node dist/src/network/main.js server --help
```

服务器不安装Chromium；浏览器在Mac执行。可checkout指定commit，或通过控制台上传已校验源码包；整个`.runtime`不上传。源码打包方法见[发布与运维手册](../../cross-machine-operations.md)。

填写[server.example.json（历史版本）](https://github.com/giuliano1101/jev-fast/blob/e74756ea0fa6a1c171aa82d921cdfb87c75e81de/deploy/network/server.example.json)，确认`accessMode: "manual"`，域名、路径和`deviceId/agentId`标签；无需mcpTokenFile/connectorTokenFile。`publicHost`精确匹配外部URLHost；代理保留该Host。`allowedOrigins: []`支持不发送Origin的普通MCP客户端；需要浏览器Origin时显式列受信HTTPSOrigin，不用`*`。

```sh
node /opt/jev-fast/dist/src/network/main.js server --config /etc/jev-network/server.json
```

终端输出本次本机管理链接。`adminPort`模板为47832。管理链接片段只供操作员，服务器日志应保持私有。通过固定端口的同端口隧道访问时，完整链接与Host/Origin一致；若换本地端口，需按实际管理入口检查精确Host限制，不关闭该检查。

`GET /health`只说明relay可达，不代表设备已允许或执行器就绪。外部没有开启本机进程或批准自己的工具。

Mac安装匹配提交、依赖和Chromium，填写[connector.example.json（历史版本）](https://github.com/giuliano1101/jev-fast/blob/e74756ea0fa6a1c171aa82d921cdfb87c75e81de/deploy/network/connector.example.json)：

```sh
node /absolute/checkout/dist/src/network/main.js connector --config /absolute/private/connector.json
```

`name`是展示名，`deviceId/agentId`与relay配置匹配；`credentialFile`指向原本机协调服务的client-a.json。公开CA可省略caFile，私有CA显式配置；不跳过TLS验证、不把信息跟随重定向发送。

AI填入`https://你的域名/mcp`并初始化后，与设备一起出现在接入控制台。先开启Mac本机服务，再在控制台开启设备、等待执行器就绪、开启对应AI。新同名连接仍待启用。按照[手动接入手册](../../manual-admission.md)提交任务并查询原request_id结果。

## 上线验收与停止

上线需实际验证：目标AI宿主无Key连接、名称登记与默认关闭、开启后合成任务、同名连接不继承权限、执行中逐项关闭、Mac总开关、网络断线/长断线重审批、TLS与管理入口隔离。当前本机回环验证不等于公网或Linux实机验收。

[systemd模板（历史版本）](https://github.com/giuliano1101/jev-fast/blob/e74756ea0fa6a1c171aa82d921cdfb87c75e81de/deploy/network/jev-network.service)需改成服务器真实Node路径，按实际环境验证。它以非root运行，不自动重启/删锁。关闭AI/device先禁止新任务，正在停止需等待执行器确认；离线不能承诺立即撤销已发生动作。

停止relay/connector用Ctrl+C或SIGTERM。本地总停止始终使用Mac面板，独立于云端。网络owner5秒续租失败会取消并收尾；设备3秒失联会关闭接入权限，恢复后需手动开启。具体实例/重启/待确认规则见手册。

## 故障恢复与旧模式

异常退出的owner.lock按既有流程确认旧进程死亡、备份私有状态后，仅处理确认残留的锁。保留所有账本，不靠清库、改UNKNOWN、换编号重复动作恢复。不同设备不能为旧设备确认收尾；旧停止尚未确认时保持等待，不能把另一台设备的空任务列表当成旧设备已停止。

手动模式保留旧S14relay记录，并在独立manual子目录保存登记和请求映射；网络ledger历史不被抹除。旧Bearer配置仍可使用，对应`*.bearer.example.json`及[旧网络手册](../../network-mcp.md)。旧模式仍需其两份私有token，不能把无Key连接直接接到旧Bearer入口。

本阶段没有完成实体第二设备、多设备并发、任意真实网站/App/手机或公网长期验收。实际部署时再检查服务器容量、证书更新与宿主兼容性。
