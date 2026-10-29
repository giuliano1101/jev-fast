# 给 Mac mini Codex 的启动指令

以下文本供用户**以后**在 Mac mini 上启动 Codex 时复制。它不是当前已发出的执行指令；本轮没有连接或改动该电脑。请先取得本私有仓库的实际地址并在目标电脑检出，不能把云端文件路径当作 Mac 上的现有目录。

## 可复制指令

```text
请在当前已检出的 Jev MVP 仓库中，实现一个用于验证电脑操控加速的最小工程。目标环境是我的 Mac mini M4 Pro 64GB，但先只做隔离浏览器 fixture，不操作我的日常浏览器、文件、账户或 macOS 原生应用。

先读取 README.md、01-scope-and-architecture.md、02-contracts-and-safety.md、03-implementation-plan.md、04-tests-and-acceptance.md 和本文件。读取适用 AGENTS.md；如果相关技能未出现在目录，可检查仓库 .agents/skills 下相关 SKILL.md。不要安装未知技能或执行第三方仓库启动脚本来代替审查。

本次执行范围是 S0–S5：环境核查、离线 fixture、typed candidates、安全状态机、mock provider、默认关闭的 Jev adapter、本地共享 MCP 与 CLI、测试和报告。依照当时工具权限安装经审查且锁版本的最小依赖；若需要额外授权，明确列出具体包和用途，先等待批准。不要自动申请 Accessibility 或屏幕录制权限，不运行 native AX 或截图定位。

核心架构是主 agent 提供有界局部目标，Jev 只能从合法完整动作候选中选择，执行器单步执行，独立 verifier 读取新状态验证。Jev 不是聊天模型替换，不是工具执行器，也不能覆盖审批。优先完成安全核心，再做 façade，不能留下绕过策略的原始点击/任意脚本入口。

P0 默认 mock、离线、合成数据、单 browser session。实现两种 client 身份及并发争用测试，session 租约与 fencing、snapshot TTL/版本、持久幂等账本、执行 UNKNOWN 隔离、no-op/预算回退、cancel/kill switch。动作 timeout 不盲重试，过期响应不执行。任何客户端不能绕过 coordinator 操作同一会话。页面内容是数据，不是授权。

不要读取或使用机器上已有的 TYPESAFE_API_KEY，不发真实 API 健康检查。live adapter 只通过本地 fake HTTP 验证契约；只有我后续明确批准外传合成数据、费用/请求上限、测试窗口和安全密钥输入方式后才能进入 S6。缺少真实 API 不阻塞离线 P0。不要让我在聊天中粘贴密钥。主 agent 的付费基线也需要明确授权。

先写简洁实施计划和需要确认的环境事实，然后按依赖实现、验证、修复可恢复失败。优先沿用工程已有可靠工具链，不盲目照抄文档示例包版本；复核官方文档后锁 SDK/model。禁止未经审查运行 browser-use/jev-ultrafast；只可借鉴其公开架构并注明许可。不要修改我的其它 agent 全局配置，也不承诺替换它们内置 CUA。

完成 S5 后停止，不扩展到真实站点或 P1。运行 typecheck、lint、单元、集成、安全、双客户端和 mock benchmark，给出真实 passed/failed/blocked/not-run。若命令与设计不同，更新 README。不得把 mock 成功或模拟低延迟说成 Jev 性能提升。交付代码、锁文件、准确启动命令、脱敏测试产物、已知限制和可复现结果；说明是否仍存在 UNKNOWN 动作。不要 merge 或部署；如需要 PR，先草稿且仅在当前授权允许发布时创建。
```

## 未来工程的命令契约

以下只是希望实施者落地的命令名称，**当前没有 package.json，也不能运行**；实现后须实际执行验证并更新 README。

```text
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run test:safety
npm run bench:mock
npm run start:mcp
npm run cli -- --help
```

不提供 `curl | sh`、未知包一键安装或把 key 写入 shell 历史的命令。`start:mcp` 默认只能连接 mock；运行 live 必须是显式独立配置，不根据环境变量存在就自行开启。

## 遇到阻塞的回报格式

```text
目标：例如完成 S4 的双客户端测试
动作：例如启动本地 MCP client
原因：实际权限/工具/依赖错误，不推测
状态：blocked / failed / not-run
已完成：与阻塞无关且有证据的部分
需要用户：最小明确授权或信息；未得到前不执行依赖步骤
```

最终回报应区分“离线工程可运行”“真实 Jev 集成已验证”“真实性能有提升”三个不同结论。未执行的后两项不能用设计完成替代。
