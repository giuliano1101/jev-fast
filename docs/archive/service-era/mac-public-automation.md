> 历史归档：此文件记录 2026-11-04 之前的集中服务设计。CLI/MCP/relay 代码已移除；下列地址、命令和操作步骤不再是当前使用说明。请看[本机接入](../../quickstart-agent.md)。

# 公网 MCP 操作 Mac 日常 Chrome 与原生 App

同一入口：`https://jev.43-160-233-161.sslip.io/mcp`，Streamable HTTP。无须模型 Key、OAuth 或 Authorization；沿用原真实 remote Jev、usage-only 账本及操作员开关。执行目标是服务所在的 Mac mini。

## Cursor / Grok Bot 接入

合并到 Cursor 的项目 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json`，不要覆盖已有其他服务：

```json
{
  "mcpServers": {
    "user-jev": {
      "url": "https://jev.43-160-233-161.sslip.io/mcp"
    }
  }
}
```

这是 Cursor 官方支持的远程 URL 配置方式，见 [Cursor MCP 文档](https://cursor.com/docs/mcp)。已经连接的 Grok Bot 刷新工具列表即可，无须另装本机执行器。

1. `tools/list` 后调用 `jev.network_status`，确认 `enabled`、`connector_online`、`local_ready`、`mac_available` 都为 `true`，`available_hosts` 包含 `mac`。
2. 私密缓存返回的 `continuation_token`，所有后续调用自动带上。不要让用户提供，不要展示或写入 Git；跨 DELETE / 新 MCP transport 仍使用同一个 token。
3. 调用 `jev.host_tools`，`params.host` 填 `mac`。`desktop` 是同一物理 Mac 的别名，不是另一个执行器。
4. 用 `jev.host_act` 选择并执行原生动作。`desktop_*` 是候选的 `tool` 名，**不是额外的公网顶层工具**。
5. 先执行 `desktop_status`，核对 `platform=macos`、`accessibility=true`、`screen_capture=true`。`mac_available` 表示桥与隧道可达，不代替 OS 权限检查。

`actions` 是单步候选集，Jev 每次只执行选中的一个动作，不会把候选数组当作顺序脚本。多步任务由调用 AI 观察、决策、执行并核验各步。

工具发现：

```json
{"name":"jev.host_tools","arguments":{"request_id":"mac-tools-001","continuation_token":"TOKEN","params":{"host":"mac"}}}
```

公网共 16 个顶层工具，原 browser、Android、fixture、choose_action、network_status/request_status/release_connection 全部保留。Mac 后端提供以下 14 个候选工具，具体参数以实际发现的 schema 为准：

| 原生候选 | 用途 |
| --- | --- |
| `desktop_status` | 实际 OS 权限、平台和能力 |
| `desktop_list_apps` | 正在运行的 App；不构成允许列表 |
| `desktop_launch_app` | 启动已安装 App，支持 bundle ID、名称、路径或 PID |
| `desktop_open_document` | 在指定 App 打开本地文件 |
| `desktop_get_state` | 当前窗口、AX 控件、观察 ID，可含截图 |
| `desktop_screenshot` | 窗口或完整屏幕图像及坐标映射 |
| `desktop_activate_app` | 激活 App / 窗口 |
| `desktop_click` | 控件或坐标点击 |
| `desktop_type_text` | Unicode 文本输入 |
| `desktop_set_value` | 原生可编辑控件赋值 |
| `desktop_press_key` | 命名按键及 `cmd+l`、`cmd+s` 等组合键 |
| `desktop_scroll` | 滚动 |
| `desktop_drag` | 拖拽 |
| `desktop_perform_action` | 控件实际支持的原生动作 |

## 日常 Chrome：使用已有进程、标签和登录态

使用 `host=mac`，App 为 `com.google.Chrome`；先 `desktop_list_apps` 也可获得实际 PID。原生执行器操作正在运行的日常 Chrome，不新建 profile、不复制 Cookie，也不重启 Chrome。没有运行时可用 `desktop_launch_app` 启动它。

观察：

```json
{
  "name":"jev.host_act",
  "arguments":{
    "request_id":"chrome-observe-001","continuation_token":"TOKEN",
    "params":{
      "host":"mac","idempotency_key":"chrome-observe-step-001",
      "task":"观察当前日常 Chrome 窗口与控件",
      "state":{"phase":"initial-observation"},
      "actions":[{"id":"observe","tool":"desktop_get_state","arguments":{"app":"com.google.Chrome","include_screenshot":true},"description":"读取真实 Chrome 窗口、控件和截图"}]
    }
  }
}
```

COMPLETED 的 `reply.result` 含真实 Jev `decision`、`execution` 和原生 MCP `result`。解析原生 `result.content` 的 JSON text，获得 `observation_id`、`window.window_id`、`elements`。截图作为外层 MCP `content` 的 image block 返回，不重复嵌入 JSON；坐标原点与缩放保留在 text metadata 中。

例如按地址栏快捷键，下面的 OBS 与 WINDOW 必须来自最新观察，`state` 也应使用实际观察摘要：

```json
{
  "name":"jev.host_act",
  "arguments":{
    "request_id":"chrome-address-001","continuation_token":"TOKEN",
    "params":{
      "host":"mac","idempotency_key":"chrome-address-step-001",
      "task":"聚焦已观察 Chrome 的地址栏",
      "state":{"observation_id":"OBS","window_id":"WINDOW"},
      "actions":[{"id":"address","tool":"desktop_press_key","arguments":{"app":"com.google.Chrome","observation_id":"OBS","key":"cmd+l"},"description":"在当前 Chrome 窗口按 Cmd+L"}]
    }
  }
}
```

随后重新观察，以新 observation_id 调用 `desktop_type_text` 输入网址；再观察后按 `return`；最后读取实际 URL、页面文字和截图确认结果。不要从“输入已提交”推断页面成功。新建自己的测试标签可先 `cmd+t`，结束时只关闭自己拥有且已确认的标签。

`jev.browser_open/observe/act/close` 仍使用隔离无头 Chromium。需要日常 Chrome 登录态时明确走以上 `host=mac` 路径。

## 桌面 App

同样通过 `jev.host_act`，将候选换成所需 `desktop_*`：

- TextEdit：`desktop_open_document` 的参数为 `{"app":"com.apple.TextEdit","path":"明确的绝对文件路径"}`。
- 观察后，从实际 `elements` 中选择可编辑控件，`desktop_set_value` 传 `app`、`observation_id`、`element_id`、`value`。
- 保存前重新观察，`desktop_press_key` 传 `key:"cmd+s"`；用实际文件或新窗口状态独立核对。
- 控件树不足时，使用截图和对应观察执行坐标点击；Retina 比例以返回的 `image_metadata` 为准。`coordinate_space:"screenshot"` 与 `screen` 不能混用。

每个输入必须使用该 App 最新观察。新的观察会替换旧 ID；`STALE_OBSERVATION` 应重新观察并诊断，不猜控件 ID。

## 交付、稳定性与开关

QUEUED / DISPATCHED 查询原 `request_id`：

```json
{"name":"jev.request_status","arguments":{"request_id":"原编号","continuation_token":"TOKEN"}}
```

COMPLETED 还须检查 `reply.ok`、`execution`、原生 `isError` 与实际后验。UNKNOWN 保留原编号、幂等键、token 和证据，停止原意图；不能换键重放不确定动作。短连接结束不等于物理动作停止。

新桥持久保存前置和 Mac 两端的请求记录；丢失 POST 回执后仅 GET 原任务，不重新提交。进程重启将未完成任务保留为 UNKNOWN；权威的后到结果可以澄清。原生后台崩溃使新桥不健康并触发它自己的监督恢复，旧后台须确认退出后才启动新的物理队列。

Mac 输入串行排队；Android 使用原有执行路径。每次决策与输入前检查原 relay 的调用者续接身份及设备状态，并直接核对本机协调器的 ready 和实例编号；每次 IPC 自动读取现有最新凭据，不要求调用者提供 Key。操作员原有 AI、设备、全局和本机开关继续生效。临时无法验证身份时不执行新输入；实际关闭或撤销后旧 token 不复活。没有新增模型 Key、付费封顶、固定步骤数或会话数量配额。

结束时只关闭自己的窗口/测试文档，正常完成后 `jev.release_connection` 释放自己的逻辑连接；不要停止共享服务。

## 当前风险与操作系统边界

当前公网没有身份鉴权，名称只是显示标签；知道 URL 的调用者可能操作本机登录账号、文件和 App，并获取屏幕内容。截图和观察会进入调用 AI 的上下文；提交给 Jev 的 state 也会经现有模型路线处理。人工关闭连接不等于验证调用者身份。

后台运行时必须获得 macOS 实际的设备控制和录屏权限。当前安装复用同一 Node 运行时，系统对该运行时的授权也可能适用于经它运行的其他程序。不要编辑 TCC 数据库或把交互式 Codex 的权限误当成 launchd 后台权限。

Mac 需开机、登录且桌面可操作；锁屏、系统安全界面、App 自身权限/控件支持、网络和焦点竞争均会影响结果。多 AI 或人同时操作同一 App 仍可能导致观察过期，需要重新核验。不能承诺任意 App 的任意任务都成功。

## 部署结构（操作员）

原协调器 `/tmp/jev-501`、原 gateway、原 connector、relay 和 Android profile 保留。新增私有前置层仅接管 nginx `/mcp`；初始化、旧工具、会话和其他路由透传至原 relay。nginx 使用平滑 reload，禁用 upstream 自动重放。

- VPS：`jev-mac-public.service`，私有 `127.0.0.1:18843`；原 relay 仍在 8443。
- 新反向 SSH 隧道：VPS `127.0.0.1:18844` → Mac `127.0.0.1:47839`。两个端口均不公开。
- Mac：`com.jev.mac-public`、`com.jev.mac-public-tunnel` launchd jobs；原生工具使用本桥独立 release 内的桌面 stdio entry 与已编译后端。真实 Jev 选择通过原协调器 IPC，记入原 usage-only 账本。
- 私有运行目录与 capability 不提交。capability 仅保护新桥内部链路，不是外部 AI 需要配置的 Key。
- `deploy/mac-public/` 有 systemd、launchd 模板；使用绝对 Node/entry/config/SSH 路径，launchd 工作目录 `/`，日志位于用户 Library，避免 Documents 工作目录/日志导致启动失败。
- 前置进程需有权读取 relay 的公共 CA 证书。现机使用独立的 `/etc/jev-mac-public/relay-ca.pem`，不修改 nginx 原证书文件权限；绝不复制 TLS 私钥给前置进程。

CLI：`node dist/src/mac-public/main.js front /absolute/private/front.json` 或 `mac /absolute/private/mac.json`。这只是操作员启动入口，外部 Grok 无须在其机器运行。维护新桥前保留 UNKNOWN 编号；不要重启 relay、清理其他连接、改 provider 或重置账本来恢复桌面任务。

配置字段示例见 [front.example.json（历史版本）](https://github.com/giuliano1101/jev-fast/blob/e74756ea0fa6a1c171aa82d921cdfb87c75e81de/deploy/mac-public/front.example.json) 与 [mac.example.json（历史版本）](https://github.com/giuliano1101/jev-fast/blob/e74756ea0fa6a1c171aa82d921cdfb87c75e81de/deploy/mac-public/mac.example.json)。示例不包含任何真实 capability；仅由操作员在私有目录生成和保存。新版 Mac 桥使用自己的 release 下的桌面 entry 与 native 二进制，便于修复截图而不替换原独立执行器的二进制。构建时还需 `npm run desktop:build`；普通 `npm run build` 不编译 Swift。

协调器暂不可达或实例不同会返回不确定/未就绪结果：保留原编号、先查状态，不换键重放。原协调器恢复并完成 relay 实例同步后，新独立任务可自动读取最新本机凭据；不能用旧实例的许可绕过本机关闭。
