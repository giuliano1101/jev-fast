# 产品范围与架构

## 要解决的问题

高层模型逐步理解页面并选择每一个点击，可能让轻量交互承担较大的推理延迟。本 MVP 将任务规划与局部动作选择分离，但保留每一步的权限检查、执行后验证和主 agent 回退。是否更快、更便宜且不降低可靠性，必须在相同任务和环境下实测。

## 范围

P0 支持一个独立浏览器会话、一个本地 fixture 服务、两种 client 身份，覆盖中文和英文的多步模拟表单、列表筛选、详情导航、返回、取消与错误修正。fixture 只保存临时模拟数据，所谓提交只改变本地测试状态。外网导航、登录、真实发送/购买/付款、文件删除、上传下载、系统设置修改全部禁用。

P1 才评估 macOS 原生 Accessibility tree 适配器及权限授权。截图定位、图像和 Box 属于更晚的研究支线，不作为 DOM/AX 失败时的隐式自动后备。P0 的回退是暂停快速路径并交还主 agent，而不是偷偷扩大工具能力。

接入范围限于 Mac mini 本地能够使用外部工具的 agent。本地 stdio MCP 不是云端 ChatGPT、Muse 或 GrokBot 的自动连接通道；两个测试 client 只证明身份隔离和并发控制，不证明两个商业 agent 产品已经完成集成。未来若需 remote bridge 或 tunnel，必须另行设计并授权网络暴露、身份鉴别、权限范围和撤销机制，不能为实现“所有 agent”而默认监听公网或开放隧道。

## 拟议组件归属

| 组件 | 负责 | 明确不负责 |
| --- | --- | --- |
| 主 agent adapter | 将用户目标变成有界局部目标、前置条件和成功条件；处理回退 | 绕过服务直接并发操控同一浏览器 |
| Session coordinator | 客户端身份、会话锁、租约、动作账本、取消 | 解释页面指令为授权 |
| Browser adapter | 读取 DOM 与浏览器可访问性语义；生成稳定定位引用；执行允许动作 | 接管用户日常 profile、任意脚本工具 |
| Candidate builder | 本地生成有限 typed 候选；剔除隐藏/禁用/危险元素 | 让模型发明坐标、URL 或 selector |
| Policy gate | 检查范围、数据类别、批准凭据、来源与当前状态 | 用模型 confidence 代替批准 |
| Decision provider | mock 或获批的 Jev provider，仅返回候选选择 | 直接点击、注入脚本、读取密码 |
| Executor 与 verifier | 执行单个已批准候选；从新状态验证既定后置条件 | 只因模型说成功就完成任务 |
| Telemetry 与 benchmark | 脱敏事件、耗时、成本、总体成功率、失败分类 | 只报告成功轨迹或藏掉回退成本 |
| MCP 与 CLI facade | 复用同一核心契约，向支持工具的 agent 提供能力 | 承诺任意 agent 可替换原生 CUA |

建议单一 TypeScript 工程便于浏览器、CLI 和 MCP 共享 schema；具体依赖需开工时审查并锁版本，不要求安装未知全局包。可以用受支持浏览器驱动实现 DOM 操作，不能假设目标 SDK 当前版本的 API。P0 不需要 Python；若改用 Python 官方 SDK，须重新确认其最低运行时版本。

## 单步数据流

```text
主 agent 的局部目标与本地策略
  → 取得会话租约
  → 观察 DOM/可访问性语义并签发 snapshot_id
  → 构建候选 → 本地风险过滤 → 最小化与脱敏
  → mock 或经授权的 Jev typed choice
  → 答案 schema/候选集合/confidence 检查
  → 执行前再次核对租约、snapshot、页面、候选、批准
  → 执行一个动作 → 读取新状态 → 独立验证
  → 继续 / 已完成 / 暂停并回退
```

低置信、无候选、状态过期、越界回答、连续 no-op、达到步数或时间上限均不自动执行。每个局部目标默认最多 8 个动作、总计 60 秒，snapshot TTL 初始建议 2 秒；这些是可调的保守工程起点，不是厂商要求或性能承诺。TTL 太短导致高回退时先测量，不能通过移除过期校验解决。

## Jev 事实与设计推论

以下为 2026-10-29 查阅的官方资料；实现前复核。`jev-1.14.0` 于 2026-10-14 发布，当前输入价格为每百万 token 0.042 美元，输出免费；基准固定版本，不使用会漂移的 `jev-latest`。这只是模型 API 价格，不包括主 agent、重试、网络、浏览器与工程成本。[Models](https://docs.typesafe.ai/models)

服务为 `POST https://api.typesafe.ai/v1/systemone`，Bearer 鉴权，请求包含 `state` 与 typed `questions`，Choice 返回选项及相关置信信息。它不是 OpenAI chat completions 的可互换 endpoint。官方 quickstart 当前要求 Python 3.10+ 或 Node.js 20+；实际选用 SDK 时锁版本并核对。[Quick start](https://docs.typesafe.ai/introduction/quickstart)

Jev 不替换 coding agent 的主 LLM；官方 agent skill 帮助编码集成，不会自动提供运行时电脑控制。此处的 shared service 和 MCP 是本项目拟议方案，不是官方现成产品。[Coding agents](https://docs.typesafe.ai/introduction/coding-agents) · [Agent skill](https://docs.typesafe.ai/agent-skill)

官方图像与 Box 文档标为未达到生产标准，需要 `TypeSafe-Danger-Zone-Images: true`。图像支持及 Box 的模型版本约束须按各页面复核；P0 一律不启用，也不发送截图。[Images](https://docs.typesafe.ai/images) · [Box](https://docs.typesafe.ai/primitives/box)

本包只能确认官方 hosted API 路径，未确认可下载权重或自托管方案。64GB 内存不改变这一事实。ZDR 是面向企业客户另行提供的选项，不能假定默认零留存；任何真实页面外传都需先核对实际账户条款。[Legal](https://docs.typesafe.ai/legal)

## 可借鉴但不能当承诺的证据

[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) 可供阅读架构；其中航班等快速演示不是本项目验收保证。不得未经依赖、许可和安全审查就复制运行其启动脚本。

[Jev-Mobile 论文](https://arxiv.org/abs/2609.30186) 在 AndroidWorld 报告 Jev-Mobile 成功率 79%，step-wise VLM 基线 84%；仅在成功轨迹中，平均端到端时间下降 32.7%、模型 API 成本下降 73.4%。它支持研究“规划与动作选择解耦”，不证明 macOS、中文界面或本项目有同样提升，也不能忽略失败率差异。
