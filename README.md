# Jev 官方直连与本机执行器

通过官方 TypeSafe API 让 Jev 选择有限候选动作，由本机执行器操作 Chrome 和 macOS App。优先接入是 **`direct/index.mjs`**。适用且就绪时使用 Jev；不适用或确认派发前失败且无未决动作时可使用已授权后备工具，并记录原因。已退役的 Jev MCP/CLI、旧网关与 relay 不恢复。Node 宿主和构建工具用于加载执行库，不是另一个 GUI 控制通道。

## 为什么改为这一方式

旧默认安装仍拉取 MCP 依赖、配置 profile/网关，并让宿主反复临时编写导航和下载逻辑。现在只安装 `direct/` 的 Playwright 与 zod，API Key 留在各机私有目录；复用 Session/BrowserWorkflow 执行连续流程。

- 每次输入保留观察 → 官方 Jev 选择 → 新鲜绑定 → 持久幂等 → 独立后验，不把一次选择当作任务完成。
- 导航、返回/前进、标签页、正文滚动、控件消歧、下载事件保存、图片解码与下载历史均有现成接口。
- 同一个宿主顺序执行，自动记录逐动作/请求 CSV 和阶段耗时；过渡期只读重试、布局稳定及等价 URL 编码处理减少临时诊断。
- Codex skill 可按目标机路径安装，托管的全局默认准则保留已有用户设置；不携带其他电脑的 Key、权限或付费授权。

原 Mac 上的 13 组 Chrome 测试：首次盲测 **1158.632 秒**，固化后同题复跑 **56.108 秒**，减少 **95.16%**。后者已熟悉站点和来源，研发及四次中止另记，不代表所有陌生任务都有同样速度。[改进、完整费用和测试证据](docs/reports/2026-11-05-official-direct-acceptance.md)。

## 环境与入口

Node **24.19+**，目标机安装 Google Chrome。macOS 原生执行器还需要 Swift 编译工具链、交互式图形登录会话，以及本机授予的辅助功能/录屏权限。仓库不会自动授权系统权限。

依赖安装在 `direct/`：`npm --prefix direct ci --ignore-scripts`。根目录的 build/typecheck/lint/test 命令都转到 direct 包，不再安装历史 MCP 包或启动服务。`npm run build` 编译保留的 TypeScript 核心，并在 macOS 编译 Swift helper；Windows 会复制原生后端源码，但本轮只验收 Mac，不宣称 Windows 实体机部署已通过。

| 需求 | 接口/说明 |
| --- | --- |
| 日常已登录 Chrome、本机 App | `openDesktopSession`，原生 AX/键鼠/窄窗口截图 |
| 不需要个人登录态的网页任务 | `openBrowserSession` + `BrowserWorkflow`，本机独立 Chrome 进程 |
| 多个窄判断 | 官方 `ask`，一个请求包含多个 Choice/Noul |
| 只选择、不输入 | `createJevRuntime().choose` |
| Codex 全局准则与 skill | `installCodexDefaults`，按本机路径渲染、备份、保留无关配置 |
| 学习/复用 | `ProcedureStore` / 混合模块；未通过激活条件的流程不能冒称已学习 |

详细步骤见 [环境与私有配置](docs/quickstart-agent.md)、[宿主集成](docs/agent-integration-guide.md)、[连续网页操作](skills/jev-direct/references/browser-workflows.md)、[原生 App](docs/native-desktop.md)。仓库 skill 是路径模板，安装后才是目标机的可用绝对路径。

## 凭据、状态与边界

官方端点固定 `https://api.typesafe.ai/v1/systemone`，模型 `jev-1.14.0`。Key 由私有模块读取 `<安装目录>/.runtime/direct/api-key`；目录 0700、文件 0600（Windows 使用对应的私有 ACL）。Key 不进入聊天、参数、日志、仓库或 skill。缺 Key、服务故障、低置信或状态漂移不静默切换其他模型/执行通道。

原生 Session 共用默认物理主机账本和租约；保留 goalId/idempotencyKey。UNKNOWN 保留证据并停止，不能换键、删库或另建安装绕过未决输入。升级保持原安装与 `.runtime`，不要用第二份运行目录绕过同一物理主机租约。

独立网页 Session 不复用个人 Chrome profile。复杂 iframe、canvas、通用上传及任意 shadow DOM 尚未通用封装；下载历史仅提供专门的只读核验。Android 仍依赖历史 MCP 后端，不属于本次直连部署。Windows 原生源码和历史研究保留，不等于新机器验收。

## 验证与历史

普通测试只用离线决策桩和临时网页，不请求付费 API。验收命令为 build、typecheck、lint、test、test:integration、test:safety。真实网站基准须显式提供当前活动的预算目录和额度，历史预算不能重置或自动迁移到新机。

旧源码和报告保留以便追溯，但 `src/index.ts`、旧服务/网关、控制台、MCP 后端不再是默认支持的安装或运行入口。根包删除了相关依赖及启动命令，旧 MCP 浏览器 CI 已移除；历史报告不作为当前接入说明。
