# Jev 统一控制台

服务总开关、AI／设备接入、离线历史、连接地址和本机配置现在集中在**同一页**。当前 Mac 已配置真实 Jev 与接入管理，打开既有控制台即可，不需要提供模型 Key 或管理令牌。

## 日常操作

1. **顶部服务卡片**：检查“运行中 / remote · Jev / 已连通”，启动、停止或刷新协调服务。
2. **连接管理**：直接查看当前 AI 和执行设备，按名称或编号搜索，也可筛选 AI／设备。每行开关只作用于该连接实例。
3. **离线历史**：默认收起，避免旧连接淹没在线连接；展开后仍可搜索。记录不会被删除。
4. **连接方式与本机设置**：同页展开即可复制公网 MCP 地址、查看本机 stdio 配置、CLI 命令与运行目录。

列表每 2 秒刷新，保留筛选、展开状态和当前操作焦点。“正在停止 · 等待确认”表示撤销尚未完成，不会提前显示已停止。连接列表不可达会明确提示；保留的旧列表不作为最新状态保证，也不影响使用服务总开关。

关闭页面或控制台进程不会停止共享协调服务；停止服务需点击顶部“停止服务”。已完成的物理动作不会被撤销，UNKNOWN 不会因切换页面或开关而自动重放。

## 当前 Mac 打开方式

双击仓库根目录 **`打开Jev控制面板.command`**。操作员安装已有私有面板书签时，脚本直接复用它，不再新建第二个面板，也不会切换 provider 或停止正在运行的服务。已打开的最新 Chrome 标签页同样可用。

原本机的服务页和接入页快捷入口都指向统一控制台。relay 的 loopback 管理接口作为后台保留，日常无需再打开另一页。只有操作员维护或独立 relay 安装才使用原[管理接口说明](manual-admission.md)。

## 新安装

需要 Node 24.19+、项目依赖；运行服务的机器还需要匹配的 Chromium。新安装默认离线 mock，启动控制台不会自动获得付费授权。

```sh
npm run build
npm run control -- --runtime /tmp/jev-operator --open
```

默认端口 47831，可用 `--port 0` 选择空闲端口。控制台仅绑定 127.0.0.1。终端输出的完整本机链接包含本次访问能力，不要公开；页面载入后移除地址栏片段，将其保存在当前标签页的 sessionStorage。

原开发 Mac 若需手动使用 Node，先 `. scripts/env.sh`；其他机器使用自己的安装路径。

## 操作员接入 relay 管理

配置由操作员一次性设置，AI 客户端不需要这些文件。协调服务启动配置与控制台管理桥配置分别固定：

```sh
node dist/src/control/main.js \
  --runtime /tmp/jev-operator \
  --config /absolute/private/profile.json \
  --admission-config /absolute/private/console-admission.json \
  --open
```

`console-admission.json` 使用当前用户拥有、权限 0600 的普通文件：

```json
{
  "url": "http://127.0.0.1:47832",
  "tokenFile": "/absolute/private/relay-console-token",
  "publicMcpUrl": "https://your-relay.example/mcp"
}
```

- `url` 只接受 literal 127.0.0.1 HTTP origin，不带路径、账号、查询或片段。远程 relay 经既有操作员隧道映射到本机；不公开管理端口。
- `tokenFile` 是绝对路径、当前用户拥有且权限 0600 的普通文件，保存 relay 已有本地管理能力；服务端每次请求重新读取，支持操作员轮换。它不是模型 Key，也不是给其他 AI 的网络接入 Key。
- `publicMcpUrl` 可选，用于同页复制公开的 Streamable HTTP 地址。

控制台服务端只转发固定 `/api/status` 与 `/api/admission`，浏览器只使用当前控制台自己的本机访问能力，收不到 relay token、owner、grant 或 local-instance 字段。浏览器不能指定上游 URL、配置路径、provider、脚本或 shell。

未配置管理桥的新安装仍可使用服务总开关；接入区域会显示未配置提示，而不是假装已经连接。已配置但不可达会显示错误，修复隧道／私有文件后点击刷新即可。

## 服务与开关规则

- 协调器、CLI、stdio MCP 和网络连接器复用相同 runtime。面板只管理固定 runtime。
- 当前共享部署为 usage-only，不设金额、累计次数或付费到期封顶；只记录实际模型费用。控制台查看状态不调用付费模型。
- 新 AI 按现有自动接入策略启用；操作员手动关闭始终有效。设备短暂失联恢复会保留操作员开启意图，但不复活旧 AI owner/token。
- 启动使用既有 CLI 校验固定 profile，不会静默回退 mock。停止由本地操作员凭据授权，不依赖上游模型可达。
- 原生 Mac App 能力、网页／手机实际执行边界与 UNKNOWN 处理见[其他 AI 接入手册](other-ai-real-testing.md)。

## 本机访问保护与维护

控制台校验精确 Host、Origin 和启动时生成的本地能力，不启用跨域权限；使用 CSP、禁缓存和 no-referrer。不要把控制端口代理到公网或分享完整私有链接。它是同一操作系统用户下的操作员工具，不构成 OS 隔离边界。

启动控制台不会启动 relay、网关或连接器，也不修改费用账本。维护这些后台进程见[运维手册](cross-machine-operations.md)；不要通过清锁、清审计或关闭其他 AI 会话来恢复未知结果。
