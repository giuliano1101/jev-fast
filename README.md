# jev-fast · Jev 电脑操控加速层

当前阶段：**v0.2.0-s7**。保留 S6 本地浏览器 P0，并新增真实网站与本机抖音 App 的受限交互研究适配器。它还不是通用电脑自动操作产品。

[S7 真实网站与抖音报告](artifacts/real/report.md) · [六道测试题](artifacts/real/tasks.json) · [S7 复现说明](docs/real-testing.md) · [S6 合成环境对比报告](artifacts/live/report/summary.md) · [原始逐项结果](artifacts/live/report/rows.csv) · [S7 检查记录](artifacts/real/verification/checks.json) · [S6 检查记录](artifacts/live/offline-verification/final/checks.json) · [阶段变更](CHANGELOG.md)

根据 `docs/handoff/` 的交接包实现。P0 核心是**隔离浏览器 + 本地模拟页面**的工程版本：主流程给出有界任务，provider 只选择合法完整动作，执行器逐步执行并独立验证。默认 mock，不读取已有 API key、不调用 Jev 正式服务。

## 本机启动与测试

推荐在 macOS 使用 Node.js 24+ 与 npm：

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

这些测试不需要 API key，不调用付费服务。GitHub Actions 运行同样的离线检查。Linux/Windows 尚未完成本阶段适配，S6 密钥保护测试使用 macOS `/private/tmp` 路径。

原开发机器的系统 node/npm wrapper 不可用，可在该机器的项目根目录使用已有环境配置（不改全局设置；其他机器不要使用这段专用路径）：

```sh
cd /Users/yubinai/Documents/jev
source scripts/env.sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:safety
npm run bench:mock
```

在其他已配置 Node/npm 的机器上无需 `source scripts/env.sh`。`npm ci` 需要联网安装锁定依赖；mock 测试仅访问 loopback。浏览器优先使用 Playwright 匹配的 Chromium；本机可回退到现有独立测试 Chromium 缓存，不接管日常 Chrome profile。若没有测试浏览器，运行 `npx playwright install chromium`，或通过 `JEV_CHROMIUM_PATH` 指定独立 Chromium 可执行文件。

测试覆盖表见 [验收索引](docs/acceptance.md)，实际完整结果见 [验收报告](artifacts/acceptance/summary.md)。全套离线基准结果见 [mock 报告](artifacts/mock/summary.md)；`manifest.json` 记录实际硬件、浏览器、版本、锁文件 hash、任务 seed 与模式。

已完成 [官方与 GitHub 同类项目对照及优化](docs/optimization-review.md)：合并浏览器状态读取、复用校验 schema，并为较大的 API 请求加入 zstd 压缩。优化后的完整复测见 [优化验收报告](artifacts/optimization/summary.md)。

已完成 [S6 真实浏览器对比](artifacts/live/report/summary.md)：Jev 25/30 成功，普通 computer use 18/18；双方成功的 16 项配对耗时比中位数 5.49×。困难组 Jev 仅 5/10 成功，5 次低置信度停止，不能作为稳定替代方案。包含两轮校准的已知 API 费用约 $0.00305，另有一次认证失败用量未知。

S7 在真实 Wikipedia、日期计算网站及本机抖音 App 上完成六道题的分档对比。原 Jev 基线 6/12，最终修复版 8/12，普通 computer use 12/12；8 组双方成功配对的完整工作流耗时比中位数为 3.72×。搜索与复杂组合筛选仍有低置信度停止，当前不能稳定替代普通 computer use。题目、失败、优化消融和费用均在 [S7 报告](artifacts/real/report.md) 中。

已实现 [S8 有界混合执行研究接口](docs/hybrid-implementation.md)：自动请求 teacher、流程证据验证、Jev/确定性执行、共享预算和跨重启 UNKNOWN 隔离。真实主机必须提供可信观察器、持久账本和 teacher 回调；目前不是独立运行的通用智能体。离线故障测试和真实本地浏览器重绘/重置回归见 [S8 验证报告](artifacts/hybrid/report.md)。S7 实测成绩不变，手机实测另行记录。

## 使用接口

目录索引：`src/` 为执行核心与接口，`fixtures/` 为合成页面，`tests/` 为回归测试，`bench/` 为基准工具，`docs/` 为交接与设计记录，`artifacts/` 为已归档证据。运行状态和密钥不入库；大体积重复 ZIP 留在本机，GitHub 直接保存展开后的源码与结果。

MCP 和 CLI 共享同一 coordinator 与安全核心。完整配置和命令见 [本地 MCP/CLI 使用说明](docs/mcp.md)。提供六个工具：

- `jev.open_session`：打开固定 fixture，身份来自已鉴权传输。
- `jev.observe`：读取脱敏状态；活动任务期间返回 BUSY。
- `jev.run_goal`：执行批准的 fixture 任务，最多 8 步 / 60 秒。
- `jev.cancel`：停止新动作，保留在途动作的真实状态。
- `jev.status`：查账本，不重放动作。
- `jev.close_session`：清理浏览器，同时保留审计结果。

任务名：`form`、`filter`、`detail`、`back`、`cancel`、`correction`、`duplicate`、`async`、`scroll`、`select`、`wait`、`navigation`。支持 `en` / `zh` 与固定 seed。输入值只允许相应 seed 的合成名称、模拟邮箱、筛选条件和枚举分类。任意真实姓名、URL、selector、脚本及伪造身份都会被拒绝。

## 关键行为

同一 coordinator 只允许一个活动浏览器 session；一个 session 同时只有一个目标持有动作租约。观察、关闭与目标执行也参与仲裁。一次动作由服务端绑定参数，provider 无法发明动作或自由文本。

Snapshot 绑定文档、变更版本、节点身份与输入属性，默认有效 2 秒。只有执行器能证明**物理操作尚未开始**的过期拒绝才可重新观察，最多两次；不会把旧候选套到新页面。真正的超时、崩溃、执行结果不明仍记为 `UNKNOWN`，隔离会话，禁止重放。

账本先持久化后执行，使用独占 owner lock、原子替换及 fsync；同键同参数返回原记录，不同参数冲突。原始 DOM、输入值和密钥不入账本。P0 日志和模型输入仅含合成白名单状态；S7 独立桥接仅发送固定公开控件与测试值。

## 停止、恢复与回滚

正常终止 coordinator 会先停止新动作、取消目标、等待终态写入，再关闭浏览器和账本。实际进程崩溃后，只有确认旧 PID 不存在才可回收 owner lock；未决动作恢复为 UNKNOWN。重启后旧会话仅可查询/返回幂等结果，需要新会话执行新任务。

若回收锁的过程中再次崩溃，`recovery.lock` 会保守阻止启动；先确认相关 coordinator 进程均已停止并备份账本，再人工移除该恢复标记。不要删除 owner lock 来绕过仍活着的进程。UNKNOWN 不能通过清空账本或重试来“修复”。

本项目未修改全局 agent 配置、系统权限或用户浏览器资料。回滚只需停止本项目进程；保留账本审计后，可以移走整个项目目录。不需要撤销系统辅助功能/屏幕录制权限。

## 已知限制与真实测试

P0 MCP/CLI 核心仍只支持本地 fixture。S7 的独立研究适配器额外支持固定的 Wikipedia、日期计算与抖音创作者筛选题；它依赖 Codex CUA，尚未并入通用 MCP 执行能力。上传、付款、删除、登录等不属于本轮题库。

两个 MCP 测试客户端证明本地协议接入和仲裁，不能据此声称已接入任意商业 agent。身份凭据的隔离是同一 macOS 用户下的逻辑隔离，不抵御拥有同一用户文件权限的恶意进程。

`scripted` 与 `mock` 都是确定性工程基线。真实 TypeSafe 服务已通过普通/zstd 烟测与正式浏览器实验；真实实验是独立的 12 步研究工具，不是 P0 8 步引擎验收。两种浏览器和候选空间不同，不能将操作路径比值解释为纯模型速度差。

测试范围、预算与复现方式见 [S6 记录](docs/live-testing.md)。不要把密钥粘贴到聊天或写入源码。固定模型与接口依据见 [设计决策](docs/decisions.md)。
