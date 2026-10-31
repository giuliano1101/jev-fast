# 让另一个 AI 接入 Jev

可以接入，但读取仓库只是获得代码和说明。仓库是私有的，另一个 AI 的宿主还需要仓库读取权限。以下本地流程需要执行机器权限；远程 AI 可使用已部署的 **`https://jev.43-160-233-161.sslip.io/mcp`**，选择 Streamable HTTP，不配置 Authorization。初始化后仍需操作员在控制台手动开启设备/AI实例，才能执行。见[公网接入与开关说明](public-service-quickstart.md)和[免 Key 协议](manual-admission.md)。本机 Unix socket 或控制面板链接不能当作远程 MCP 地址。

当前正式 CLI/MCP 只执行 `standard` 本地模拟页面上的十二类固定任务。默认离线 mock；它可验证接线，不代表已经使用真实 Jev 模型。既有真实网页、抖音和 Android 测试工具仍是独立研究适配器。双实体电脑和任意真实应用接入尚未验收。

## 1. 在执行机器安装

需要 Node.js 24.19+、npm、Git 和独立 Chromium。当前主要验证 macOS。

```sh
git clone https://github.com/giuliano1101/jev-fast.git
cd jev-fast
npm ci --ignore-scripts
npx playwright install chromium
npm run build
node -p process.execPath
```

保存最后一行的 Node 绝对路径。不要在其他机器套用 `scripts/env.sh` 的原开发机器路径。安装依赖需要联网；下面的 mock 测试不调用付费模型。

## 2. 启动和检查同一个协调服务

可以使用[操作面板](control-panel.md)，或直接运行：

```sh
node dist/src/cli/index.js service start --runtime /tmp/jev-agent-demo --json
node dist/src/cli/index.js doctor --runtime /tmp/jev-agent-demo --json
node dist/src/cli/index.js policy status --runtime /tmp/jev-agent-demo --json
node dist/src/cli/index.js schemas --json
```

确认 `ready: true`、当前 provider、构建和执行模式。默认应为 `mock` / `test_mock`。`ready` 只证明本地协调服务运行；remote 模式还需检查 `remoteReachable`、`identityMatches` 和 `routeCompatible`。`enforcement: advisory-only` 表示不限制 AI 的其他宿主工具。

## 3. 任选 CLI 或 MCP

CLI 烟测直接执行：

```sh
node dist/src/cli/index.js demo --runtime /tmp/jev-agent-demo --json
```

应返回经执行器后验确认的 `SUCCEEDED`。演示会打开独立模拟浏览器并关闭会话。详细参数用 `schemas --json` 获取，不自行发明 URL、selector、脚本、坐标或身份字段。

支持 stdio MCP 的 AI 宿主可采用下面的连接格式；具体配置文件位置由宿主决定。把两个 `/absolute/...` 换成上一步得到的 Node 路径和当前 checkout 的绝对路径：

```json
{
  "mcpServers": {
    "jev": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/checkout/dist/src/mcp/index.js",
        "--credential",
        "/tmp/jev-agent-demo/client-a.json"
      ]
    }
  }
}
```

面板的接入信息会显示当前安装的实际路径。配置仅含凭据文件位置，不包含 token 内容。不要把 npm 的 build 输出串到 MCP stdout。连接后应发现以下六工具：

| 工具 | 用途 |
| --- | --- |
| `jev.open_session` | `{"fixture_id":"standard"}` 打开隔离模拟会话 |
| `jev.observe` | 获取脱敏观察 |
| `jev.run_goal` | 提交固定任务、goal_id、idempotency_key 和成功条件 |
| `jev.status` | 查询会话、目标或动作的持久结果 |
| `jev.cancel` | 取消目标后续动作 |
| `jev.close_session` | 释放自己的会话 |

可用任务为 `form/filter/detail/back/cancel/correction/duplicate/async/scroll/select/wait/navigation`。`run_goal` 示例见 [CLI/MCP 基础说明](mcp.md)。服务同一时刻只接受一个浏览器会话，冲突返回 `BUSY`。

关闭再启动服务会生成新凭据；旧 MCP 进程需断开并重连，不能继续持有旧 token。停止由操作员执行：

```sh
node dist/src/cli/index.js service stop --runtime /tmp/jev-agent-demo --json
```

## 4. 需要真实 Jev 时

由操作员按[跨机器手册](cross-machine-cli-mcp.md)部署或连接受信网关、登记设备与 agent、签发 token，提供 0600 私有 remote profile，并审批当前期限/请求数/费用。远程网关提供模型决策，本机协调服务执行动作；网关不是允许外部 AI 随意操作这台 Mac 的接口。

面板启动时显式传 `--config /absolute/private/profile.json`。普通 AI 工具不能上传 API key、修改 provider、登记身份或扩大预算。以前的测试额度不能因读取文档或点击开启而自动续期。

## 5. 把这段发给另一个 AI

> 阅读仓库根目录 AGENTS.md 和 docs/quickstart-agent.md。先报告当前能力范围与缺少的本机配置。按 operator 已提供的 runtime 接入，先检查 doctor/policy/schemas，再使用 CLI 或 MCP 的六个工具。不要直接请求 hosted API，不新增付费授权，不操作任意真实 URL。成功以本地账本 SUCCEEDED 和后验为准；通信不确定先 status，UNKNOWN 停止、不换键重放。不要把凭据内容发到聊天或 Git。

常见故障：找不到 Node/入口说明宿主绝对路径不对；本地服务不可达先检查相同 runtime 和是否已启动；MCP 初始化失败可能是未启动、凭据轮换或 stdout 混入日志；`SERVICE_PROFILE_MISMATCH` 需操作员核对并停止后重新配置，不自动切换到 mock；锁或 UNKNOWN 的处理见[运维手册](cross-machine-operations.md)，不要清空账本。

## 网络接入的区别

当前主路径为[手动接入](manual-admission.md)：使用 HTTPS Streamable HTTP，无需 Authorization，初始化clientInfo.name后出现在控制台待启用。名称不是身份验证，只有操作员允许的连接实例可以执行。六个原有操作及 `jev.network_status`、`jev.request_status` 两个网络状态工具继续提供；操作 arguments 为 `{request_id, params}`，收到 QUEUED 后用原 request_id 查询。网络 COMPLETED 后还需检查 reply/goal.status。同名新session、长失联及实例变更需要重新核对/开启；不同AI不能读彼此结果。本地未封装参数不能直接传网络版。旧预配Bearer方式保留在[旧网络手册](network-mcp.md)，具体AI宿主仍需部署时验证。
