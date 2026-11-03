# jev-fast · 每台主机独立运行的 Jev 执行核心

各台 Mac / Windows 自己运行 Jev 决策与执行器。本项目已移除对外 CLI、stdio/网络 MCP 服务、集中 relay 和跨主机连接器；无需再通过一台 Mac 中转其他主机的操作。

保留浏览器、原生 Mac / Windows App、安卓执行适配器、混合执行策略、后验校验、幂等账本、费用计量和历次测试经验。宿主程序通过本地 TypeScript / JavaScript API 接入；macOS / Unix 本机控制台保留启动、停止和状态功能。

| 目标 | 说明 |
| --- | --- |
| 安装、本地 API、现有配置迁移 | [快速开始](docs/quickstart-agent.md) |
| 给其他 AI / 宿主程序 | [集成说明](docs/agent-integration-guide.md) |
| 本机单页开关 | [控制台](docs/control-panel.md) |
| 已登录 Chrome / Edge、本机浏览器 | [浏览器执行器](docs/local-browser.md) |
| Mac / Windows GUI 与已装 App | [原生桌面执行器](docs/native-desktop.md) |
| 只计费与未知用量 | [计量](docs/metered-service.md) |
| 混合策略与自动学习 | [执行设计](docs/hybrid-execution-design.md) · [实现经验](docs/hybrid-implementation.md) |
| 本次删除范围与验证 | [2026-11-04 报告](docs/reports/2026-11-04-per-host-core.md) |
| 历史报告、题目与结果 | [经验索引](docs/acceptance.md) · [集中服务归档](docs/archive/service-era/README.md) |

## 安装与验证

需要 Node 24.19+。在各自执行主机中：

```sh
git clone https://github.com/giuliano1101/jev-fast.git
cd jev-fast
npm ci --ignore-scripts
npx playwright install chromium
npm run build
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:safety
```

默认测试使用离线决策和临时页面，不需要模型 Key。真实执行须使用本机已配置的决策提供方；仓库不包含 Key、私有 profile 或运行账本。升级源码不会自动迁移或停用旧部署，请按本次报告核对实际运行状态。

本地代码入口为 `dist/src/index.js`，示例见快速开始。原生桌面与本机浏览器执行器可用于 Mac / Windows；现有生命周期、私有 profile 加载和 Unix socket 协调器仍要求 macOS / Unix，Windows 由自己的宿主注入本机 Jev 决策端口，不能直接套用这些 POSIX 辅助函数。`npm run control -- --runtime /absolute/private/runtime --config /absolute/private/profile.json --open` 启动本机控制台；省略 config 是明确的离线 mock 安装，不能当作真实 Jev。

## 执行规则

观察 → 生成候选 → Jev 选择一个动作 → 本机执行 → 核验实际后验。候选不是批量动作脚本，返回模型选择或“输入已提交”不能替代成功验证。页面导航中继续观察；切换排序等操作后重查筛选条件。

同一物理主机顺序执行，独立浏览器会话可以并行。保留新鲜观察、持久幂等和 UNKNOWN 隔离；未知结果先核查，不换键重放。停止不能撤销已经发生的点击。

本仓库仍依赖 MCP **客户端**库和官方 Playwright MCP **后端适配器**来驱动既有工具；它们不是对外发布的 Jev MCP 服务。原生桌面可直接调用，不需要 MCP server。删除接入层不等于删除执行器或历史经验。
