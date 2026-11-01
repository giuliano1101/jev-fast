# 让另一个 AI 接入 Jev

## 已部署共享服务：直接连接

先读[其他 AI 接入与真实任务手册](other-ai-real-testing.md)。使用 Streamable HTTP：

```text
https://jev.43-160-233-161.sslip.io/mcp
```

无需 Authorization、模型 Key、profile、证书或新额度审批。当前共享部署已经配置 remote Jev/usage-only、自动 AI 即时准入和 continuation；其他 AI 不另起 mock、不停止或重启共享服务。

先 tools/list，再 network_status。就绪后自动私密缓存返回的 `continuation_token`，在业务 wrapper、request_status 和 release_connection 中传回，跨 DELETE/短连接恢复原 owner；不要要求用户手填或把 token 贴到聊天。全部调用、可运行 SDK 和错误处理见[接入手册](other-ai-real-testing.md)。正常结束释放自己的逻辑连接；UNKNOWN 保留原编号并停止重放。

本地有 13 个业务工具，公网为 16 个：六个兼容 fixture 工具、choose_action、browser_open/observe/act/close、host_tools/act，以及网络专用 network_status/request_status/release_connection。真实网页在隔离无头 Chromium 中执行任意 HTTP/HTTPS URL，独立于用户 Chrome。手机使用配置的 android host，先 host_tools 再按返回 schema 调用 host_act。

当前已验证的公网真实网页、短连接与手机操作见[本轮报告](reports/2026-11-02-unrestricted-service.md)。同一页面/实体手机的动作需要顺序协调；独立浏览器会话不再受全局单会话限制。无固定步骤/队列/会话数和默认业务 TTL，显式调用者预算、资源边界、TLS/owner/UNKNOWN 规则仍保留。

## 新机器：离线开发安装

下面仅用于新安装，不用于替换当前运行中的共享服务。需要 Node24.19+、npm、Git、执行机上的独立 Chromium。

```sh
git clone https://github.com/giuliano1101/jev-fast.git
cd jev-fast
npm ci --ignore-scripts
npx playwright install chromium
npm run build
node -p process.execPath
node dist/src/cli/index.js service start --runtime /tmp/jev-agent-demo --json
node dist/src/cli/index.js doctor --runtime /tmp/jev-agent-demo --json
node dist/src/cli/index.js policy status --runtime /tmp/jev-agent-demo --json
node dist/src/cli/index.js schemas --json
node dist/src/cli/index.js demo --runtime /tmp/jev-agent-demo --json
```

保存实际 Node 绝对路径；不要在其他机器套用 scripts/env.sh 的原开发 Mac 路径。新安装默认 `mock/test_mock`，上述 fixture 演示不调用付费模型，也不能证明已使用真实 Jev。tools/list/schema 发现工具不代表当前 profile 配置了所有 backend；健康信息可查看 `general_choice_available`、`real_browser_available`、`configured_hosts`。ready 仅表示本地协调器运行，远程状态还需核对身份/路由与可达性。

## 本地 CLI/stdio MCP

先运行同一个 coordinator，再配置宿主（替换绝对路径）：

```json
{"mcpServers":{"jev":{"command":"/absolute/path/to/node","args":["/absolute/checkout/dist/src/mcp/index.js","--credential","/tmp/jev-agent-demo/client-a.json"]}}}
```

本机工具直接传业务 params，不加网络 request_id/continuation 外层。schema 由 `schemas --json` 给出；13 个工具的范围见[主手册](other-ai-real-testing.md)。例如配置真实 remote profile 后，CLI `browser_open` 可使用 `--args '{"url":"https://example.com"}'`；新安装 mock 未配置真实决策/host 时，相关工具会如实返回不可用，不自动连接未知 backend。

fixture 兼容任务仍为 form/filter/detail/back/cancel/correction/duplicate/async/scroll/select/wait/navigation；`run_goal` 的 max_steps/time_budget_ms 可选，不强加旧 8 步/60 秒。多个独立 session 可以并行，同 session 的活动目标和观察/关闭仍受一致性仲裁。

关闭自己创建的开发服务由操作员执行：

```sh
node dist/src/cli/index.js service stop --runtime /tmp/jev-agent-demo --json
```

该命令不用于当前共享 `/tmp/jev-501`。服务重启会轮换本地凭据，旧 MCP 进程需重连；锁和 UNKNOWN 不能通过清账本处理。

## 新安装接入真实 Jev

操作员按[跨机器手册](cross-machine-cli-mcp.md)准备受信网关、私有证书/身份与 remote profile，显式选择 usage-only 或可选有上限策略。当前共享服务已有用户授权的 usage-only，AI 无需再申请付费次数/额度。provider、host backend、设备和密钥不是普通 MCP 参数。

可选 hostConfigs 仅由操作员绑定已知 MCP backend；AI 不能传任意 serverCommand 或设备标识创建主机。新部署手动接入默认关闭；autoAdmitAi/allowContinuations 是私有服务端可选策略，当前公网已开启。完整接入语义见[手动接入](manual-admission.md)，旧 Bearer 接线见[网络手册](network-mcp.md)。

找不到 Node/入口时检查宿主绝对路径；本地不可达检查实际 runtime/服务，不直接重启共享服务。`SERVICE_PROFILE_MISMATCH`、`CONTINUATION_INVALID`、资源/上游错误应按实际层报告，不索取已配置的模型 Key、不自动切换 mock。宿主根本没有远程 MCP/Node 能力时，报告宿主缺少入口，而非 Jev 未授权。

原生桌面 App 使用独立[原生 MCP](native-desktop.md)和已有真实 Jev 选择组合。原 Mac 的构建已实测；其他机器需构建自己的执行器。共享 profile 本轮未增加 desktop / Windows host，实时网络状态应再次核对。
