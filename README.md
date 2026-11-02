# jev-fast · Jev 电脑操控加速层

**给接入的 AI：先读[真实任务接入手册](docs/other-ai-real-testing.md)。** 当前公网 MCP 为 [`https://jev.43-160-233-161.sslip.io/mcp`](https://jev.43-160-233-161.sslip.io/mcp)，使用 Streamable HTTP，无需用户提供模型 Key、Authorization 或新额度审批。

当前共享部署使用 **真实 remote Jev / usage-only**，已启用 AI 即时准入和短连接 continuation。网页在隔离无头 Chromium 中打开任意 HTTP/HTTPS URL，独立于日常 Chrome；已配置 Android MCP host。公网实测包括独立 Example 网站会话、真实 Jev 导航、短连接恢复、手机 HOME 和前台应用回读。能力、失败和验证见[2026-11-02 服务报告](docs/reports/2026-11-02-unrestricted-service.md)，不据此承诺所有网站/应用稳定成功。

| 使用目标 | 入口 |
| --- | --- |
| Windows 本机可见/已有登录浏览器 | [本地浏览器 MCP 安装与使用](docs/local-browser.md) |
| 服务常驻、异常恢复与保留手动关闭 | [守护运维说明](docs/service-recovery.md) |
| 另一个 AI 连接当前共享服务 | [接入/真实网页与手机示例/SDK](docs/other-ai-real-testing.md) |
| 部署状态、continuation 与共享服务规则 | [公网快速开始](docs/public-service-quickstart.md) |
| 新机器的离线 mock 安装 | [Agent 快速开始](docs/quickstart-agent.md) |
| 一个页面管理服务、AI／设备、历史与接入配置 | [统一控制台](docs/control-panel.md) · [CLI/MCP](docs/cross-machine-cli-mcp.md) |
| Windows 本机浏览器、桌面、流程恢复与验收 | [Windows 执行器](docs/windows-executor.md) |
| 默认手动准入与可选自动策略 | [手动接入](docs/manual-admission.md) · [旧 Bearer 网络模式](docs/network-mcp.md) |
| 计量与工程约束 | [usage-only](docs/metered-service.md) · [AGENTS.md](AGENTS.md) |

修复后另验证了真实维基百科搜索、百分比计算（240 的 17.5% = 42），以及连接器中断 7 秒后的自动恢复。搜索的英文 URL 断言与中文词条结果存在本地化差异，原断言失败记录保留在报告中。

其他 AI 复用共享 `/tmp/jev-501`，不重启、停服、切换 provider 或启动替代 mock。操作员仍可关闭单个 owner、设备或本地总开关。

心跳稳定性维护已完成：连接器复用 TLS，relay 设备宽限为 30 秒；Windows 可建立新的独立连接，步骤及实测见[维护报告](docs/reports/2026-11-02-heartbeat-maintenance.md)。

本轮新增 [Windows 本地浏览器 MCP 与常驻恢复](docs/reports/2026-11-02-local-browser-uptime.md)：Windows 本地可见输入与已有 CDP 浏览器验收已在 runner 通过，原 Mac 已由 launchd 守护，手动关闭意图持久保存。

本机原生 Mac / Windows App 执行器已提供，接入与当前实测范围见[原生桌面手册](docs/native-desktop.md)。可与已有 `jev.choose_action` 配合使用；共享公网 profile 本轮仍保留 android，未新增 Windows host。

## 当前工具

本地 CLI/stdio 共 **13 个业务工具**：

- `jev.browser_open/observe/act/close`：真实网页观察、Jev 选择、执行与后验；动作使用当前 snapshot/control，不接受任意脚本。
- `jev.host_tools/act`：发现并调用操作员配置的 MCP host；当前包括 android，设备由服务注入。
- `jev.choose_action`：宿主提供真实观察和候选，Jev 返回签名选择；宿主负责执行与验证。
- `jev.open_session/observe/run_goal/cancel/status/close_session`：保留 standard 合成 fixture 的十二类任务。

网络 MCP 共 **16 个工具**，另有 network_status、request_status、release_connection。网络业务参数为 `{request_id, params, continuation_token?}`；本地参数直接使用业务 schema。以 tools/list 或 `schemas --json` 为准。

当前服务不设付费金额/累计次数/到期封顶、固定步骤、全局会话总数、队列长度或默认 AI/业务交付 TTL。独立浏览器会话可以并行；同会话动作租约与实体手机顺序执行负责一致性。调用者仍可指定 timeout/step budget，TLS/owner/幂等、UNKNOWN、16 MiB JSON/IPC 资源边界和上游实际资源限制仍存在。

## 短连接也保留上下文

初次调用 network_status，私密缓存服务生成的 `continuation_token`，后续业务、request_status 和 release 全部带上。它允许跨 DELETE/新 transport 恢复同一个逻辑 owner 和浏览器，不按展示名合并身份；无需用户手填。正常工作结束先清理自己的浏览器再 release_connection。token 不进 Git、聊天或公共报告。

QUEUED/DISPATCHED 查原 request_id；COMPLETED 仍检查 reply 和实际后验。UNKNOWN 保留原编号，不换键重放。release、手动 off、owner 代次变化和 relay 重启会使旧 continuation 失效，失效不证明旧动作没有发生。

## 新安装与离线测试

需要 Node24.19+ 和执行机上的独立 Chromium。新安装默认 mock；安装不会自动获得当前共享部署的私有 remote profile 或付费授权。

```sh
git clone https://github.com/giuliano1101/jev-fast.git
cd jev-fast
npm ci --ignore-scripts
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:safety
```

测试不需要模型 Key，不调用付费 API。安装依赖/Chromium 需要联网；mock 和集成测试使用本机回环与隔离浏览器。原开发 Mac 可使用 `. scripts/env.sh`，其他机器使用自己的 Node 路径。Chromium 优先取 Playwright 匹配版本，或显式设置独立 `JEV_CHROMIUM_PATH`；不接管日常 Chrome profile。

本地开发可使用[面板](docs/control-panel.md)或 `service start`，先启动 coordinator 再连接 stdio facade；它们共用同一个协调服务、身份和审计。配置真实 Jev、host backend、证书与计费策略仅由操作员完成，普通工具参数不能修改它们。

## 结果、停止与恢复

Jev 决策来源与实际执行效果分开报告。真实浏览器返回 execution/after/postcondition；导航期间若有 navigation_pending，先重新 observe。host_act 返回的 MCP 调用结果不自动证明整项任务完成，应回读前台/页面状态。不要公开原始账号页面、手机截图或设备标识。

账本先写后执行，同键同参数返回已有结果，改参数冲突。未知动作隔离且不重放；正常停止取消/收尾，不能回滚已完成点击。崩溃恢复须确认旧进程已退出并保留审计，不清账本或删除仍存活进程的锁。共享服务由操作员维护，其他 AI 不以清理为由停服。

## 历史实验与证据

以下报告保留各阶段原结果，不代表当前接口仍只有 fixture 或受当时预算/步骤限制：

- [S17 真实服务接通](artifacts/live-service/report.md) · [S18 usage-only](artifacts/metered-service/report.md) · [初期公网部署](artifacts/public-deployment/report.md)。
- [S12 合成稳定性](artifacts/stability/report.md) · [同条件入口对照](artifacts/parity/report.md) · [早期跨机器小测](artifacts/cross-machine/pilot/report.md)。
- [S7 真实网站实验](artifacts/real/report.md) · [S8 混合执行研究](artifacts/hybrid/report.md) · [S9 单手机固定题实验](artifacts/mobile/report.md)。历史固定题的速度/成功率不外推为当前通用网站或手机稳定率。
- [验收索引](docs/acceptance.md) · [阶段变更](CHANGELOG.md) · [架构与恢复](docs/cross-machine-operations.md)。
