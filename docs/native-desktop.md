# 原生 Mac / Windows App 执行器

原生执行器处理真实 App 的窗口、辅助功能控件、鼠标和键盘，不使用浏览器 fixture。没有 App 白名单、调用次数、费用或步骤配额。模型决策仍使用已有真实 Jev；执行器和模型是两个可以组合的 MCP 服务。

## 当前这台 Mac

已构建 `dist/native/jev-desktop-macos` 和 `dist/src/desktop/main.js`，实际辅助功能、屏幕录制状态均可读取。真实 Jev 已选择并执行系统计算器 `37 × 19 = 703`，并在 TextEdit 中修改本次测试专属临时文本、按 Cmd+S 保存后独立核对文件。窗口截图实测为 460 × 816，缩放为 2。

原生桌面开发阶段按用户要求没有重启共享服务；随后用户批准了[心跳维护](reports/2026-11-02-heartbeat-maintenance.md)，已重启 relay / connector 并上线 30 秒设备宽限。本机 coordinator、网关、原 profile、Key 和历史账本保留，也没有给现有公共 profile 添加 `desktop` 或 Windows host。公共 profile 仍只配置 `android`，实时就绪以 `network_status` 为准；不要向尚未配置的公网 `host=desktop` 反复重试。

本机 AI 可以直接启动新原生 MCP，配合已有公网 `jev.choose_action` 使用。当前机器的 MCP 配置如下，不需要提供模型 Key：

```json
{
  "mcpServers": {
    "jev-desktop": {
      "command": "/Users/yubinai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node",
      "args": ["/Users/yubinai/Documents/jev/dist/src/desktop/main.js"]
    }
  }
}
```

这个进程由 MCP 宿主按需启动，关闭时收尾自己的原生输入。它不会停止 `/tmp/jev-501` 或清理别人的会话。以上绝对路径仅适用于原 Mac；Windows 及其他机器使用各自实际安装路径。

## 给 AI 的执行流程

1. 连接原生 MCP，读取 `tools/list` 和 `desktop_status`，按真实 schema 调用。权限为 false 时处理操作系统授权，不能伪造权限或换成合成页面。
2. `desktop_launch_app` 打开任意已安装 App，或 `desktop_open_document` 在指定 App 中打开明确的本地文件。App 可用进程 PID、名称、Mac bundle ID 或安装路径表示。
3. `desktop_get_state` 读取真实窗口与控件；使用其 `observation_id`、`element_id`、`window_id`。刚启动时窗口可能尚未就绪，应再次观察。
4. 把完成当前任务所需的观察和候选交给已有 `jev.choose_action`。缓存网络 continuation，保留 request_id / idempotency_key，不在聊天里展示 token。
5. 仅执行实际选择的原生候选，再用新的 `desktop_get_state`、实际文件或其他独立后验确认结果。真实 Jev 决策不等于 App 已完成任务。
6. 网络请求不确定先查原编号；原生输入中途丢失结果时停止并核查实际状态，不能换键盲目重放。

这里的原生 MCP 是宿主执行器，单独调用它不会自动产生 Jev 决策或计入 Jev 模型用量。调用方应组合第 4 步。如果操作员将其绑定到 remote profile 的 `hostConfigs.desktop`，现有 `jev.host_tools/host_act` 会自动提供真实 Jev 选择、持久幂等记录及主机排队。本轮未改动共享 profile；不能把开发实测中的独立 HostService 接线说成公网已经注册 `desktop`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `desktop_status` | 平台、真实权限和能力状态 |
| `desktop_list_apps` | 正在运行的 App；这不是允许列表 |
| `desktop_launch_app` / `desktop_open_document` | 启动任意已安装 App / 打开指定文档 |
| `desktop_get_state` | 窗口、控件、观察 ID；可含截图 |
| `desktop_screenshot` | 窗口或 `full_display: true`；返回 PNG 和坐标映射 |
| `desktop_activate_app` | 激活指定 App / 窗口 |
| `desktop_click` | 控件点击，或基于观察的坐标点击 |
| `desktop_type_text` / `desktop_set_value` | Unicode 输入 / 原生控件赋值 |
| `desktop_press_key` | 命名按键或 `cmd+s`、`ctrl+a` 等组合键 |
| `desktop_scroll` / `desktop_drag` | 滚动、拖拽 |
| `desktop_perform_action` | 调用实际控件提供的原生动作 |

例如观察后点击实际按钮：

```json
{"name":"desktop_get_state","arguments":{"app":"com.apple.calculator"}}
```

```json
{"name":"desktop_click","arguments":{"app":"com.apple.calculator","observation_id":"替换为刚返回的观察ID","element_id":"替换为实际按钮ID"}}
```

新观察会替换同一 App 的旧观察；旧 ID 返回 `STALE_OBSERVATION`。这用于避免操作已经变化的控件，不是时间或使用配额。截图坐标使用 `coordinate_space: "screenshot"`，屏幕坐标使用 `screen`；应读取返回的原点、scale_x / scale_y 和坐标系，不能直接猜 Retina 比例。完整屏幕像素不自动授权把一个 App 的观察用于另一个 App。

## 安装与 Windows 范围

在自己的 checkout 中使用 Node 24.19+：

```sh
npm ci --ignore-scripts
npm run build
npm run desktop:build
npm run desktop:mcp
```

Mac 需要可用的 Swift 编译工具链；原生实现使用 AppKit、AX、CoreGraphics 和 ScreenCaptureKit。辅助功能和屏幕录制由 macOS 实际管理，App 自身没有暴露辅助功能树时可结合真实截图与观察坐标，不能凭空构造控件。

Windows 可选后端为 `native/desktop-windows.ps1`，使用系统 Windows PowerShell 5.1、UI Automation 和 Win32。此 Mac 不会被注册为 Windows host。Windows 端自行安装执行器并进行实体 App 验证；CI 的语法/只读协议检查不代表实体 Windows 交互验收。需要在真实交互式用户会话运行，操作系统权限、UIPI、受保护桌面及实际控件能力仍会影响操作结果。

诊断命令直接调用原生执行器，不请求模型：

```sh
node dist/src/desktop/main.js --call '{"name":"desktop_status"}'
```

原生输入的返回表示输入已提交；它不承诺所有 App 的所有任务必定成功。具体已测题目、失败与修复见[本轮报告](reports/2026-11-02-native-desktop.md)。
