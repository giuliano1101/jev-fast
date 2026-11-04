# 本机 Codex 默认操作准则：Jev 官方直连

**操作本机 App 和 Chrome 默认使用 Jev 官方直连执行器，不使用 Computer Use、MCP 或 CLI。** 此规则适用于加载本机全局准则的 Codex 对话和自动任务，无需用户每次指定 skill。

执行前读取 `{{JEV_CODEX_HOME}}/skills/jev-direct/SKILL.md`，导入 `{{JEV_ROOT}}/direct/index.mjs`，使用 Node 宿主 `{{JEV_NODE}}`。日常登录态 Chrome / App 用原生 Session；不依赖个人登录态的网页任务用 BrowserWorkflow 与独立本机 Chrome。只使用官方 TypeSafe API Key；不启动中转、旧网关、Jev MCP/CLI，不改模型配置或 MCP 配置。

禁止借 Computer Use（含 cua_repl）、MCP 或 GUI CLI 执行、准备、观察、核查这些 GUI 操作。Node 运行本地执行器模块及普通构建/文件命令仍允许，不借此调用其他 GUI 控制通道。已有专用连接器的确定性读写、普通编码和文件处理无需强加 GUI 决策。

所有受支持的候选动作选择交给真实 Jev。观察、候选准备、独立核验与缓存不是模型调用；每次真实输入保留观察→选择→新鲜绑定→持久幂等→独立后验。连续已理解的合法流程复用一个宿主；未知页面先观察，不预选整段动作，不绕过低置信、状态漂移或后验失败。

原生 Session 共用该安装默认物理主机账本和租约，不能另换目录或安装绕过。保留 goalId/idempotencyKey；UNKNOWN 保留证据，不换键、删账本、清锁或重放。沙盒看不到桌面时先核对真实图形会话，不假定缺权限。

Key 仅由本机私有模块读取，不进入聊天、参数、日志或 skill。新机器的 Key、系统授权和费用需要单独配置；历史测试额度不自动迁移或续用。该准则不扩大任务授权，不覆盖上级指令或用户当次明确要求。受阻时沿同一执行器诊断，仍不支持则报告具体限制和所需人工操作，不自动切换控制通道或伪造成功。
