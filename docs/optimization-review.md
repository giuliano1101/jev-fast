# Jev 官方与同类开源项目对照

日期：2026-10-30。范围：已完成 S0–S5 的本地合成环境；本轮不使用真实 API Key，不运行付费请求。原始交接包中的规划作为需求资料，不作为自动执行外部操作的指令。

## 查阅的源码

| 来源 | 实际查阅内容 | 对本项目的启发 |
|---|---|---|
| [TypeSafe 官方 JavaScript SDK v0.7.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.7.0/src/client.ts) | client、types、compression | 请求编码独立成模块；大请求压缩；明确重试边界 |
| [官方压缩实现](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.7.0/src/compression.ts) | 1 KiB 阈值、zstd、UTF-8 长度 | 大请求支持无损压缩，小请求保持 JSON |
| [官方类型定义](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.7.0/src/types.ts) | choice 候选数量、重试、超时 | 当前 choice 至少一个候选；不能套用社区“至少两个”的假设 |
| [jev-ultrafast snapshot](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/snapshot.js) / [browser](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/browser.py) | 浏览器内批量读、节点身份、动作前刷新、等待 | 同一次浏览器回调绑定状态与版本；保持节点身份验证 |
| [jev-browse observe](https://github.com/0x7067/jev-browse/blob/d812e7aed89172de0d7d34226a469305b929852d/src/agent/observe.ts) / [fresh](https://github.com/0x7067/jev-browse/blob/d812e7aed89172de0d7d34226a469305b929852d/src/cdp/fresh.ts) / [choice-request](https://github.com/0x7067/jev-browse/blob/d812e7aed89172de0d7d34226a469305b929852d/src/model/choice-request.ts) | 观察、刷新、模型请求分层 | 把读取与编码从主适配器抽出，避免继续堆叠职责 |

以上两个浏览器项目是社区实现，不是 Jev 官方产品。只阅读源码、独立实现适合本项目的改动；未复制或执行第三方项目代码。SDK 版本与社区提交均固定，避免随主分支漂移。

另参考：[官方 SDK 文档](https://docs.typesafe.ai/sdk/javascript)、[choice](https://docs.typesafe.ai/primitives/choice)、[独立问题批处理](https://docs.typesafe.ai/patterns/fan-out)。

## 已落地的改动

1. 新增 `src/browser/frame.ts`：页面状态、敏感页面判定、文档版本、地址与标题在一次同步浏览器回调中读取，运行时 schema 只构建一次。仍使用 Playwright 的可见性和 shadow DOM 查询语义。目标节点仍逐项绑定并在执行前复验，没有放宽 mutation/epoch/TTL 规则。
2. `adapter.ts` 改用统一读取：原来状态检查要分别读安全标记、字段和版本。按应用层远程读取计，普通观察的公共部分从 4 次降到 2 次，验证公共部分从 3 次降到 1 次，后置条件公共部分从 2 次降到 1 次；候选节点读取次数未变。这些是源码调用数，不是 CDP 包数或网络时延承诺。
3. 新增 `src/providers/request-body.ts`：UTF-8 JSON 至少 1024 字节且压缩有收益才发送 zstd。16384 字节上限仍按压缩前计算；一次请求的所有获准重试复用同一份字节。小请求保持原样，压缩不改变 token 数或计费规则。

## 没有采纳的做法

- 不接管用户日常 Chrome、不采集截图或任意站点 DOM。当前仍限定 loopback 合成测试页。
- 不采用“忽略无关页面变更”的宽松刷新策略，保留交接包要求的严格版本检查。
- 不叠加官方 SDK 默认的两次重试、连接失败重试或每次独立超时；保留一次共享重试、整体截止时间和逐次预算预留。
- 不为单个候选绕过 provider 或伪造置信度，官方当前协议已允许一个候选。
- 当前一次决策已返回完整动作，无需拆成多个问题再批处理；模型无效答案也不额外付费重问。
- 暂不换成直接 CDP 操作，也不引入新的运行依赖。当前规模下额外兼容成本高于已证实收益。

## 验证与适用边界

新增回归测试先在旧实现上失败，再在新实现上通过：旧实现能把上一个浏览器回合的状态与下一回合的版本拼接；新实现要求二者来自同一回合，之后发生变更仍拒绝执行。请求压缩测试验证实际 Content-Encoding、解压后的字段及重试字节一致，并覆盖 Unicode、压缩前大小上限与小请求。

本轮完整结果见 `artifacts/optimization/checks.json` 与 `summary.md`，原结果保存在 `artifacts/optimization/before/`。旧结果与新结果不是随机 A/B 实验，不用它们宣称真实 API 加速比例。真实服务的压缩兼容性、响应质量、置信度阈值和付费端到端耗时，仍需要下一阶段的用户授权与 API Key。
