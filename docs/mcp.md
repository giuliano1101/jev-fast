# 本地共享 MCP / CLI（mock）

一个长期运行的 coordinator 持有唯一 Engine、浏览器和持久账本。CLI 与每个 MCP stdio facade 都只把严格校验的请求送到同一个私有 Unix-domain socket；stdio facade 不创建自己的浏览器。P0 同一时刻最多一个已打开或正在打开的 session，同一 session 最多一个活动 goal。额外打开或有冲突的执行返回 `BUSY`，不隐式排队。

当前服务只实例化 `MockProvider`，不读取 API key，也不会因环境中存在 key 开启 live。浏览器仅访问服务启动的 `127.0.0.1` 合成 fixture。coordinator 没有 TCP listener；fixture HTTP 服务仅绑定 loopback。

## 启动、就绪和停止

在本项目目录运行；所需 Node/browser 环境见 [environment.md](environment.md)。脚本有意不隐式 build，启动前明确编译：

```sh
. scripts/env.sh
npm run build
npm run cli -- --help
npm run --silent cli -- service start --runtime /tmp/jev-demo --json
npm run --silent cli -- service health --runtime /tmp/jev-demo --json
npm run --silent cli -- demo --runtime /tmp/jev-demo --json
npm run --silent cli -- service stop --runtime /tmp/jev-demo --json
```

`service start` 在后台启动服务并等待实际鉴权健康检查通过，返回 `ready: true`。已运行时返回 `already_running: true`。默认运行目录为 `/tmp/jev-<uid>`；示例显式使用 `/tmp/jev-demo`。启动最多等待约 10 秒，停止完成最多等待约 5 秒。失败以非零退出码和脱敏错误码返回，不能把启动进程本身当作就绪。

`demo` 通过同一个接口打开 session、运行合成多步表单、在 finally 中关闭 session。结果中的 `SUCCEEDED` 来源于本地后置条件验证。它不是对真实网站的操作许可。

若需要前台运行：

```sh
npm run start:service -- --runtime /tmp/jev-demo
```

前台收到 SIGINT/SIGTERM 时也执行安全关闭。运行中的操作员 kill switch 是 `service stop`：使用独立操作员凭据鉴权，先调用 Engine.kill 阻止新动作并取消在途目标，再关闭浏览器和服务。普通客户端凭据不能调用此操作。正在执行但结果不明的动作保留 `UNKNOWN`，不会声称物理操作已撤销。

## 六个工具与 CLI

MCP 的 `tools/list` 与 CLI `schemas` 都从 `src/core/contracts.ts` 的 Zod schemas 生成 JSON Schema。所有公开参数均为 strict object，不接受 `client_id`、任意 JS、shell、URL、selector、坐标或 approval 扩权字段。运行时使用同一份 Zod schema；包括 `status` 的 `goal_id` 与 `action_id` 不能同时存在这一细化约束。

| MCP 工具 | CLI 命令 | 必要参数 |
| --- | --- | --- |
| `jev.open_session` | `open_session` | `fixture_id: "standard"` |
| `jev.observe` | `observe` | `session_id` |
| `jev.run_goal` | `run_goal` | `session_id`, `goal_id`, `idempotency_key`, `goal`, `success` |
| `jev.cancel` | `cancel` | `session_id`, `goal_id` |
| `jev.status` | `status` | `session_id`，可选 `goal_id` 或 `action_id` |
| `jev.close_session` | `close_session` | `session_id` |

导出完整契约：

```sh
npm run --silent cli -- schemas --json
```

工具调用示例：

```sh
npm run --silent cli -- open_session --runtime /tmp/jev-demo --args '{"fixture_id":"standard"}' --json
```

把返回的 session_id 填入后续请求：

```sh
npm run --silent cli -- run_goal --runtime /tmp/jev-demo --args '{"session_id":"SESSION_ID","goal_id":"g1","idempotency_key":"k1","goal":{"task":"form","language":"zh","seed":1},"success":{"kind":"task_complete"},"max_steps":8,"time_budget_ms":60000}' --json
npm run --silent cli -- status --runtime /tmp/jev-demo --args '{"session_id":"SESSION_ID","goal_id":"g1"}' --json
npm run --silent cli -- close_session --runtime /tmp/jev-demo --args '{"session_id":"SESSION_ID"}' --json
```

CLI 也接受带 `jev.` 前缀的命令名。`--json` 输出机器可读 JSON；不加时输出简短摘要。机器调用应使用 `npm run --silent` 或直接调用 Node，避免 npm 自身的提示混进输出。错误 JSON 为 `{"error":{"code":"INVALID_ARGUMENTS"}}`，退出码非零。MCP 工具错误为 `isError: true`，text 内容为 `{"code":"..."}`；不会透传底层异常信息。

## 连接两个 MCP 客户端

coordinator 在配置端固定登记身份 `a`、`b`，分别创建 `client-a.json`、`client-b.json`。凭据内容只有版本、socket 路径和随机 token；服务端把 token 映射到身份。工具参数不能自报或覆盖身份。默认不存在共享 ACL。

先启动 coordinator，再为两个客户端分别配置以下进程。`command` 应替换为本机可用 Node 的绝对路径；可在激活项目环境后用 `node -p process.execPath` 查询。路径以本 checkout 为例：

```json
{
  "mcpServers": {
    "jev-a": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": [
        "/Users/yubinai/Documents/jev/dist/src/mcp/index.js",
        "--credential", "/tmp/jev-demo/client-a.json"
      ]
    },
    "jev-b": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": [
        "/Users/yubinai/Documents/jev/dist/src/mcp/index.js",
        "--credential", "/tmp/jev-demo/client-b.json"
      ]
    }
  }
}
```

推荐 MCP host 直接执行 Node，如上所示。命令行也可使用：

```sh
npm run --silent start:mcp -- --credential /tmp/jev-demo/client-a.json
```

**不要使用不带 `--silent` 的 npm 命令作为 MCP host 启动命令，也不要把 build 与 stdio MCP 启动串到一起。** MCP stdout 只能承载协议；源码中没有启动 banner、凭据或普通日志写入 MCP stdout。脱敏错误码只去 stderr。

CLI 选择 b 凭据时使用 `--credential /tmp/jev-demo/client-b.json`。持有 b 凭据的客户端不能 observe/status/cancel/close a 的 session。两个身份可以轮流独立打开 session；P0 的单 session 限制不意味着自动共享。

若明确要测试同一 session 的并发，在服务未运行时用：

```sh
npm run --silent cli -- service start --runtime /tmp/jev-shared --share-a-with-b --json
```

该服务端配置将 a 所拥有的 session 授权给 b，供故意测试第二客户端 `BUSY`、取消与状态读取。已运行的服务不会因重复 `service start` 改变 ACL；必须先停止并以目标配置重新启动。这不是调用参数中的临时授权。

## 本地安全边界与状态恢复

- 运行目录必须归当前用户所有且权限为 `0700`；socket 与每个凭据文件为 `0600`。凭据读取拒绝符号链接、不安全权限和不匹配 socket；服务器凭据由 32 字节随机数生成。token 不放入命令参数、stdout、服务日志、provider 输入或账本。
- 这是**传输凭据的逻辑隔离**，不是同一 macOS 用户下的恶意进程隔离。相同 OS 用户能读取自己的其他凭据文件并冒充该身份。没有使用 OS peer credentials 把 token 绑定到独立沙箱、宿主进程或另一个 OS 用户；不要把多个不可信同用户进程当成强隔离租户。
- IPC 每个连接只承载一个请求和响应，输入与输出帧上限 64 KiB；MCP 官方 SDK stdio transport 的读取缓冲也限定为 64 KiB。IPC 使用从连接建立起计算的绝对 65 秒期限，慢速逐字节发送不能延长它。goal 最大预算 60 秒，为返回和清理留出余量。未知方法和非法输入均拒绝。
- 传输中断不代表动作未发生。先通过 `status` 查询 goal/action；同幂等键的相同请求返回已有账本结果，不重放动作。`UNKNOWN` 表示无法确认物理结果，session 隔离；应保留审计记录并停止该 session。不能换幂等键强行重试。
- 正常关闭删除本次服务创建的 socket、凭据及 service.lock，保留 `ledger/` 和脱敏 `service.log`。清理逐项尝试，即使先前资源释放失败也继续释放后续资源。
- **coordinator 崩溃后的启动采用 fail-closed，当前没有自动清理 stale service.lock/socket/凭据。** 即使 core ledger 有进程死亡恢复，整个服务也不会宣称自动重启恢复完成。操作员应确认 lock 中 PID 已退出、没有该 runtime 的其他服务，并备份完整 runtime；再人工移除仅 stale 的 `service.lock`、`coordinator.sock`、`client-a.json`、`client-b.json`、`operator.json`，保留 `ledger/`。不要删除或重写存活进程的锁。重新启动生成新凭据，客户端需重连。账本中的在途动作按 core 恢复规则变成 `UNKNOWN`，不自动重放。

## 已验证

针对 facade 的 14 个测试包含三个真实 MCP SDK 测试：两个独立 `StdioClientTransport` 子进程连接同一个 coordinator，后者使用真实 BrowserAdapter/FixtureServer。验证默认隔离、单 session BUSY、服务端共享 ACL 的并发与取消、执行后故障的 UNKNOWN action 查询和幂等不重放。其余测试验证 strict schemas、身份注入拒绝、凭据权限、未授权 token/操作员操作拒绝、帧上限、绝对期限、启动清理所有权、资源释放失败、CLI 就绪/demo/停止。

```sh
. scripts/env.sh
npm run build
node --test dist/tests/unit/facade*.test.js dist/tests/integration/mcp.test.js
```

本机受限执行环境可能阻止 Unix socket 或 Chromium 启动；需要在允许本地 socket 与浏览器的测试环境运行。这里的成功仅覆盖本地合成 mock 场景，不是 hosted Jev 性能或真实 macOS 应用可靠性证据。
