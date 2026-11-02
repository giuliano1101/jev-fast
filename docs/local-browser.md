# 在 Windows 本机使用 Jev 控制浏览器

公网 `jev.browser_open/observe/act/close` 的浏览器进程在提供服务的 Mac 上。这些工具不能因为调用方是 Windows 就自动操作 Windows 的窗口。需要在 Windows 的 AI 客户端中配置 **jev-local-browser** 本地 stdio MCP：公共 Jev 负责选择动作，Windows 上的官方 Playwright MCP 负责实际操作。

无需复制 Mac 的 Key、私有 profile、账本或申请新的服务额度。公共服务的 usage-only 计费继续生效。

## Windows 安装

需要 Node 24.19+、Git，以及已安装的 Edge 或 Chrome。在 PowerShell 中执行：

```powershell
git clone https://github.com/giuliano1101/jev-fast.git
Set-Location jev-fast
npm ci --ignore-scripts
npm run local-browser:setup -- --mode launch
```

已有本地仓库时，在仓库中先执行 `git pull --ff-only`，再执行后两条命令。安装命令会编译并输出适用于**当前 Windows 机器实际绝对路径**的 MCP JSON。把输出中的 `mcpServers.jev-local-browser` 加入 AI 客户端的 MCP 配置，重新连接该 MCP。不要使用其他机器输出的路径，也不要把这里的 stdio 服务配置成公网 URL。

默认启动可见的独立浏览器，Windows 优先选择已安装的 Edge，其次 Chrome。普通模式不连接日常登录资料。可指定 `--browser chrome` 或 `--browser msedge`。不会自动退回 Mac 或无头浏览器。

如果 AI 客户端使用 Codex CLI，可用配置中显示的实际 Node 与入口路径：

```powershell
codex mcp add jev-local-browser -- "C:\实际路径\node.exe" "C:\实际路径\jev-fast\dist\src\local\main.js" --mode launch
```

## 控制已经打开、已经登录的浏览器

有两种可选连接方式，任选一种生成配置。

**浏览器原生远程调试**：在本机 Edge 的 `edge://inspect/#remote-debugging` 或 Chrome 的 `chrome://inspect/#remote-debugging` 开启浏览器提供的远程调试许可，然后执行：

```powershell
npm run local-browser:setup -- --mode attach --browser msedge
# Chrome 改为 --browser chrome
```

是否支持原生连接取决于本机浏览器版本。已有独立调试端口时，可明确指定 `--cdp-endpoint http://127.0.0.1:9222`。只连接本机端口，不将调试端口公开到网络。

**官方 Playwright 扩展**：按[官方扩展说明](https://playwright.dev/mcp/configuration/browser-extension)安装对应浏览器扩展，然后执行：

```powershell
npm run local-browser:setup -- --mode extension --browser msedge
```

首次连接时按浏览器自身的提示授权。关闭本地 MCP 不会主动关闭借用的现有浏览器；操作中明确选择关闭页面等动作仍会产生对应效果。扩展接入需要在目标 Windows 上验证，Mac 验证不能代替这一步。

## 给接入 AI 的操作说明

1. 调用 `jev.local_status`，确认 `platform=win32`、`execution_host=local`，`cloud.ready=true`。状态中的 `browser_connection` 明确提示连接需通过实际观察验证；配置存在不等于已经连接浏览器。
2. 调用 `jev.local_tools` 读取本机后端的真实工具与参数 schema。
3. 使用 `jev.local_act` 提交动作候选；由真实公网 Jev 选一个，随后在当前 Windows 执行。此入口参数不需要公网 `{request_id,params}` 外层。
4. 用 `jev.local_observe` 的 `browser_snapshot` 重新读取页面，验证目标是否完成。`execution=executed` 只说明工具成功返回，不能代替结果检查。

例如打开网站：

```json
{
  "idempotency_key": "windows-example-open-001",
  "task": "打开 Example 网站",
  "state": {"observation": "当前准备打开网站"},
  "actions": [{
    "id": "open-example",
    "tool": "browser_navigate",
    "arguments": {"url": "https://example.com"},
    "description": "在本机浏览器打开 https://example.com"
  }]
}
```

读取页面：

```json
{"tool":"browser_snapshot"}
```

`local_observe` 仅接受明确只读的观察工具及参数；导航、点击、输入、执行 JavaScript 等请走 `local_act`。实际动作参数留在本机，发给 Jev 的内容是 task、state 和候选描述；调用方写入描述或 state 的数据仍会发送给服务。

同一个不确定动作保留原 `idempotency_key`。本机私有状态保存 journal 与待核查记录；不要为“重试”删除该目录或换新 key。UNKNOWN 时检查当前页面并保留证据，不能直接重放。设备/AI 被手动关闭或 continuation 失效后，本地入口停止新动作，不会换身份绕过开关。

本机默认状态目录为 `%LOCALAPPDATA%\Jev\local-browser`，Mac 为 `~/.jev/local-browser`。同一目录只给一个本地 MCP 进程使用；独立执行器可使用独立 `--state-dir`，这是本地 journal 的所有权规则，不是公网单会话额度。

## 验证范围

离线测试覆盖本地真实 CDP 操作、可见窗口输入、现有浏览器存活、原请求恢复及不确定结果保护。Windows GitHub runner 使用离线决策桩验证 Windows 上的真实浏览器进程；真实 Jev 验收在 Mac 的可见浏览器进行。用户 Windows 的现有登录浏览器/扩展仍需 Windows 端实际安装后验收。
