# 2026-11-02：解除产品配额并接入真实执行

## 交付问题与变化

此前部署的公网 MCP 只有固定合成题入口，浏览器全局只允许一个业务会话。短连接客户端还会在自动准入完成前结束连接。它能够验证模型，却不能满足其他 AI 直接做日常网页和手机操作的需求；这是先前交付范围不足，不能归因于调用方没有提供 Key。

本轮把真实网页执行和已配置 MCP 主机接进同一个 coordinator → connector → 公网 MCP 路由。当前 Mac 已配置真实 Jev、只计费策略和 Android Mobile MCP；公网地址仍为 `https://jev.43-160-233-161.sslip.io/mcp`。调用方不需要模型 Key、设备编号或新的额度审批。使用方式见[其他 AI 实测说明](../other-ai-real-testing.md)。

## 已解除与保留的机制

| 机制 | 本轮结果 |
| --- | --- |
| 费用、请求次数、授权到期封顶 | 延续当前操作员 usage-only 策略，仅记录使用与费用；不修改历史预算账本 |
| 全局单浏览器会话 | 解除；每个业务会话使用独立 Chromium context |
| 目标最多 8 步、60 秒 | 解除；调用方可自行指定正整数上限，省略时无产品默认上限 |
| 累计动作、证据、审计和注册记录数量门槛 | 移除对应服务层数量门槛；保留原审计 |
| 网关每分钟 60 次、全局 4 次、身份 1 次并发 | 移除这些产品配额 |
| relay 32 个活动/排队请求、128 名 AI、连接器 4 个在途请求 | 移除这些产品配额 |
| 默认 AI 空闲到期、排队 5 秒、交付 70 秒、业务 IPC 65 秒 | 不再作为默认业务截止时间；调用方明确传入的期限仍生效 |
| 新 AI 需要等待操作员轮询准入 | 当前部署由服务器同步自动准入；手动关闭的实例不会被再次自动打开 |
| 短连接结束就丢失逻辑工作上下文 | 私密 continuation_token 支持跨传输会话继续查询和执行；显式 release_connection 结束逻辑连接 |
| 固定 standard/12 题作为唯一业务入口 | 保留为回归题库；新增通用 choose_action、真实 browser、配置的 host 执行入口 |

同一浏览器会话的操作仍顺序执行；同一物理手机的操作也顺序执行，以免两条指令相互破坏。这不限制同时存在的 AI 或浏览器会话数。当前 relay 仍选择一台执行设备，尚非多设备调度器。

保留 TLS、身份/所有权隔离、操作员开关、幂等与审计。UNKNOWN 代表结果不确定，不能换编号重放。16 MiB 是当前 IPC/网络帧的技术承载边界，固定合成题协议仍有自己的格式验证；这不是免费调用额度，也不意味着硬件、上游模型、网站与系统资源无限。新安装继续默认 mock，只有操作员已配置的部署可以调用真实付费模型。

## 新接口与真实能力

本地 CLI/stdio 共 13 个业务工具，公网另有 network_status、request_status、release_connection，共 16 个。

- `choose_action`：调用方提供任务、JSON 状态和候选动作，由真实 Jev 选择并返回签名决策。签名证明模型选择，不能单独证明物理操作成功。
- `browser_open/observe/act/close`：打开任意 HTTP/HTTPS 站点，在当前可见控件上点击、输入、选择、按键、滚动、导航与返回。`browser_act` 把 Jev 决策、单次执行和实际后状态连接起来。
- `host_tools/host_act`：发现操作员配置的 MCP 后端工具，再由 Jev 选择并调用；当前 `android` 对接本机 Mobile MCP。设备参数在本机注入，调用方不需要知道设备编号。

网页在隔离的 headless Chromium 中执行，不是用户日常 Chrome 的登录配置。当前网页观察覆盖主框架视口；iframe、上传下载和复杂系统对话框尚无完整驱动。通用 host 可接入其他操作员配置的 MCP 后端，但这次没有安装原生 macOS App 驱动，不能声称已经控制任意 Mac App。

## 真实测试题目与证据

这些是接入与执行验收，小样本不能推导长期成功率或速度提升倍数。原有速度对照报告仍作为历史实验；本轮不把新能力验收冒充新的配对性能实验。

| 题目 | 验证内容 | 结果与证据 |
| --- | --- | --- |
| 两名 AI 同时打开 example.org / example.com | 独立真实网页会话，不再全局 BUSY | 通过，[证据](../../artifacts/unrestricted-service/lifecycle-proof.json) |
| 删除一条 MCP 传输，再以不同展示名连接 | 使用原上下文继续读取原请求与浏览器会话 | 通过，同上 |
| Jev 选择导航到 example.net | 真实模型决策、真实公网网站执行、实际 URL 后条件 | 通过，同上 |
| 关闭一个浏览器后继续读取另一个 | 一名 AI 的清理不破坏另一名 AI | 通过，同上 |
| 发现 Android 工具并查询设备 | 真实 Mobile MCP 目录与连接设备 | 33 个工具，设备已连接，[证据](../../artifacts/unrestricted-service/phone-proof.json) |
| Jev 选择手机 HOME，再独立读取前台应用 | 真实物理手机返回主屏幕，前台确认为 launcher/home | 通过，同上；未公开设备编号和原始手机结果 |
| Wikipedia 输入 Ada Lovelace 并提交搜索（首次） | 真实网站两次 Jev 决策与提交后核验 | 输入成功，提交后观察 UNKNOWN；保留为失败，[证据](../../artifacts/unrestricted-service/first-search-failure.json) |

首次搜索的两次模型调用均返回 HTTP 200，故障发生在浏览器执行后观察：Playwright 可能等待尚未返回的主文档，旧观察方法也会被导航阻塞。修复把输入提交与导航完成分开：点击/回车只执行一次；主文档仍在等待时返回 `navigation_pending: true`、空 DOM/控件和未满足的后条件，由调用方继续 observe。观察被文档切换打断时只重读状态，不重放输入。旧读以 generation 隔离，不能覆盖新控件。超时或撤销后关闭并排空受影响 context，防止稍后迟发点击。

修复前的 UNKNOWN 原键与审计完整保留，复测使用新的独立任务：

| 修复后题目 | 实际结果 |
| --- | --- |
| 搜索 Grace Hopper（两次真实 Jev 决策） | 输入、提交均 executed；提交后 navigation_pending，继续只读观察到中文维基百科“格蕾丝·霍珀”词条，页面正文含 Grace Hopper。原测试只认英文路径 Grace_Hopper，故原脚本仍退出 1、final.passed=false；按实际标题与正文确认任务完成。保留这个本地化断言失配，[完整证据](../../artifacts/unrestricted-service/navigation-retest.json) |
| 计算 240 的 17.5%（三次真实 Jev 决策） | 两次输入、一次计算均 executed；提交后只读观察到 `Result: 42` 和 `17.5% of 240 = 0.175 × 240 = 42`，无重复输入，[完整证据](../../artifacts/unrestricted-service/calculator-retest.json) |

两题使用不同 AI 上下文，同时通过同一公网服务运行。首次搜索失败与修复后英文 URL 断言失败均未删除；不能把这些小样本汇总成“100% 稳定”。

## 部署与费用

服务端沿用现有腾讯云主机、443、证书和免费 sslip 域名，无新增收费域名或服务器。升级保存旧代码、配置和账本；管理接口仍仅 loopback，经原私有通道访问。Mac 保持真实 Jev 的操作员私有配置，模型 Key 没有上传服务器或 Git。服务后台运行，测试只释放自己的连接与会话。

已公开证据中的实际输入 token：首次搜索 8,742，网页生命周期 964，手机 1,230，修复后搜索 8,718，计算器 13,418，合计 33,072；输出合计 292。按当前账本每百万输入 token 0.042 美元、输出不计费的价格，这部分已知费用为 **0.001389024 美元**。这不是整个共享服务总费用：其他 AI 和后续复测另按 usage 账本记录，缺失 usage 时明确标为未知，不以预留次数代替实际费用。

完整离线验证、修复复测和审查信息写入 [checks.json](../../artifacts/unrestricted-service/checks.json)。公开记录去掉了凭据、续接能力、设备编号和原始用户数据。

## 最终验收

- typecheck、lint 通过。
- 499/499 单元测试、102/102 集成测试、40/40 安全测试、16/16 Python 部署测试通过；无跳过。控制台文字/在线排序随后另跑相应集成回归。
- 导航修复经独立审查批准，23/23 真实离线 Chromium 专项测试通过。同文档 hash/pushState 不会永久 pending，外部导航使旧快照立即失效。
- 新文档经实际 schema 校验；13 个本地业务工具、16 个公网工具一致。控制面板已在本机 Chrome 核验“运行中 / remote · Jev / 已连通”。
- 当前 Mac 的浏览器执行热修复已加载；relay 保持自动 AI 准入与 continuation，sessionTtlMs=null，无显式排队/交付 TTL。服务保持后台运行。
- 以上真实执行已知模型费用合计约 **0.001389024 美元**；完整共享账单仍以私有 usage 账本为准。日志时间为 UTC，报告日期按 Asia/Shanghai。

## 设备断线自动恢复补充

最终控制台验收还发现并保留了[修复前记录](../../artifacts/unrestricted-service/recovery-before-fix.json)：本机 healthy，但设备心跳过期后一直停在 pending。旧逻辑没有区分操作员“保持开启”的意图与临时失联撤销的活动权限。

新增持久 `desiredEnabled`：操作员开启保留开启意图，手动关闭清除意图；同一注册恢复就绪心跳、旧 owner 撤销确认后自动恢复设备的新代次。旧 AI/token 不复活，不接续不确定物理动作，不抢其他已选设备，新同名注册也不继承。旧 disabled 历史不能安全推断意图，保守迁移；当前部署由原操作员策略重新开启本机设备后生效。另修复关闭过期设备 A 时误撤销当前设备 B 的 AI 的隔离问题。独立审查批准，最新 6/6 定向验证通过。

已在真实公网服务暂停连接器 7 秒再恢复：[4 项检查全部通过](../../artifacts/unrestricted-service/recovery-proof.json)：原接入被撤销、同连接器自动恢复、新 AI 可直接使用、旧 token 确认无效。模型调用 0 次。未修改原有 3 秒设备、5 秒本机 owner fencing；服务保持后台运行。

全量离线测试扩展至 499 项单元测试。一次与部署重负载并行的运行出现 CLI mock 停止等待超时；保留失败诊断，单独 2/2 CLI 复查通过后重新运行全量。没有通过放宽生产停止条件或跳过测试掩盖它；这也不构成长期零故障承诺。

第一次 GitHub CI 的单元测试通过，集成测试出现 1 项 `STALE_SNAPSHOT`：弹窗测试只等待 URL，未等 `navigation_pending` 结束就发出滚动。已用延迟 DOM-ready 的弹窗确定复现，再修正为只读轮询到就绪才继续，并验证模型选择次数不增加。生产保护保持不变；[首次远端失败记录](../../artifacts/unrestricted-service/verification/github-first-ci-failure.json)保留。
