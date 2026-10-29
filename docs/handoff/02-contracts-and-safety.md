# 接口与安全约束

本章所有 `jev.*` 工具名、字段、状态和 CLI 名称都是本项目的**拟议契约**，不是官方 SDK 语法。实现应生成 JSON Schema、类型与契约测试，拒绝未知字段和类型强制转换。

## 对外工具

| 拟议工具 | 请求要点 | 返回要点 |
| --- | --- | --- |
| `jev.open_session` | 已配置 fixture 标识，client 身份由传输层确定 | session_id、能力清单、允许 origin |
| `jev.observe` | session_id | snapshot_id、版本、有效期、脱敏观察、合法 candidate 摘要 |
| `jev.run_goal` | session_id、goal_id、已批准局部目标、成功谓词、步数/时间预算、幂等键 | 状态、验证证据摘要、耗时、步数、回退原因 |
| `jev.cancel` | session_id、goal_id | 取消状态及是否存在执行结果未知的动作 |
| `jev.status` | session_id、goal_id 或 action_id | 账本中的当前状态；不再次执行 |
| `jev.close_session` | session_id | 清理结果；未决动作须保留审计状态 |

MCP 与 CLI 使用同一 core；不提供任意 JS、shell、原始坐标点击或任意 URL 工具。调试 CLI 可展示已脱敏候选和 mock 决策，不允许跳过 policy gate。初期用本地 stdio 或已鉴权的本地传输，服务不能监听公网。若多个 stdio facade 连接同一 coordinator，应使用本地 IPC 身份隔离，而不是相信调用者自报 client_id。

## 内部数据结构

`Snapshot` 包含 session_id、snapshot_id、document_epoch、mutation_version、url/origin、created_at、expires_at、脱敏语义节点和本地私有 locator 映射。URL 查询参数按白名单保留，其他剥离。snapshot_id 不等于页面绝不会改变；执行前仍须检查实际节点及相关状态。

`Candidate` 是完整动作，不是可自由拼接的 operation/target：candidate_id、snapshot_id、operation、target_ref、已绑定参数引用、risk_class、preconditions、expected_postcondition、policy_version。P0 操作集合为 click、fill、select、scroll、back、wait；只能面向 fixture 与白名单值。输入值由主 agent 的已授权模拟任务提供，不让 Jev 生成自由文本。所有参数存在本地映射中，模型只能选择 ID。最多 64 个候选，超过时按局部目标确定性缩小，无法安全缩小就回退；不静默截掉唯一正确选项。

`Decision` 包含 provider、实际 model、snapshot_id、candidate_id、confidence、usage、elapsed。验证 candidate_id 严格属于当前集合，confidence 是有限数且在合法范围；缺字段、NaN、错类型、未知模型或非法选项均拒绝。初始置信阈值可设 0.90，但须通过独立校准集调整并锁定，不能把 0.90 当作 90% 实际成功率。

若响应含 probabilities，须按固定 provider 契约检查键集合、有限数、数值范围及和的容差，不能把畸形分布悄悄归一化后执行。成功谓词只能从服务端允许的 fixture predicate 类型及绑定参数构造，不接受主 agent 或页面传入任意可执行表达式。

`ActionRecord` 至少包含 action_id、session_id、goal_id、lease_epoch、idempotency_key、request_hash、snapshot_id、candidate_id、policy_version、状态及各阶段时间、验证摘要。不得保存原始 DOM、完整输入值或密钥。

## Hosted provider 边界

官方请求形状为 `model`、`state` 与 `questions`；单个动作使用一个 Choice，`criteria` 将合法 candidate_id 映射到脱敏描述。官方 Choice 上限 255，本项目限制更小。回答从 `answers` 读取，不当作可直接执行的 tool call。一次请求只做一个完整动作选择，避免两个独立问题分别选 operation 和 target 后组合出非法动作。[Choice](https://docs.typesafe.ai/primitives/choice) · [System One API](https://docs.typesafe.ai/api/system-one)

API key 仅从后续批准的进程环境或本机秘密存储注入，客户端不向 MCP 调用方暴露。P0 mock 不读取 key；live 默认关闭。出站只允许正式 API endpoint，禁用重定向到其他域；TLS 校验不能关闭。P0 不发送 assets、图片、Box、multipart 或任何 Danger-Zone header。

## 原子性与并发

1. 同一 session 只能有一个活动 goal 持有动作租约；第二个 agent 获得 BUSY，不加入隐式执行队列。观察也需权限，不能跨客户读取状态。
2. coordinator 为每次租约发放递增 fencing epoch。所有 executor 动作核对 epoch；旧持有者即使超时恢复也不能继续。
3. 每个动作在执行前先写入持久 action ledger，再从 VALIDATED 进入 EXECUTING。事务与单会话锁防止两个请求同时执行。
4. 幂等键在 session 范围唯一；同键同 request_hash 返回原记录，同键不同参数返回 IDEMPOTENCY_CONFLICT。重启也应保留账本，不只存在内存中。
5. 执行超时或进程崩溃标为 UNKNOWN，不自动重放。锁和会话进入隔离状态，先新观察、比对可验证后置条件；无法确认则回退人工/主 agent。租约到期不能使未决物理动作与新动作重叠。
6. 执行前检查 origin、document_epoch、mutation_version、TTL、节点唯一性、可见/可交互性、参数、批准与预条件。过期返回 STALE_SNAPSHOT，重新观察和选择，不将旧 candidate_id 套到新页面。

浏览器 DOM 在检查与点击间仍可能变化；不能声称实现任意网页上的绝对事务原子性。采用单执行器、即时节点验证、禁止导航出界、fixture 可控变化和执行后验证来降低风险；不稳定页面暂停而非强行执行。

## 状态与回退

```text
OBSERVED → DECIDED → VALIDATED → EXECUTING → VERIFYING → SUCCEEDED
              ↘ REJECTED / FALLBACK       ↘ UNKNOWN / FAILED / NO_PROGRESS
```

每次执行都从新状态验证预先确定的后置条件，例如字段值匹配、页面路径和标题同时匹配、模拟提交记录计数恰好增加一次。Jev 的 confidence 和“已完成”回答不算证据。相同状态指纹且目标没有进展视为 no-op；同一候选连续两次无进展或累计达到预算，停止快速循环并返回原因。wait 只能等待预定义条件，最多 2 秒并计入预算。

回退必须先释放或隔离快速路径，再向主 agent 返回最小脱敏上下文及原因。主 agent 若使用其它执行器继续，必须经过相同会话仲裁；不能一边让 Jev 循环一边用内置 CUA 操作同一会话。无法协调的内置 CUA 不与该浏览器共享会话。

## 重试与批准

纯决策请求可以在同一总预算内对 429/529 做有限退避并尊重 Retry-After；实现只保留一层重试，审查 SDK 默认重试，避免叠加。网络超时可能已被服务处理并计费，不能承诺 exactly-once 计费。任何迟到响应仍需 freshness 校验。动作请求超时只能查询状态和观察，不能盲重试。[Errors](https://docs.typesafe.ai/api/errors)

P0 只有本地模拟操作被允许；风险分类由本地规则决定。后续真实发送、提交、购买、删除或权限变更必须在主流程取得具体批准，批准绑定用户、目标、参数摘要、有效期和一次性消费状态；高 confidence、页面文字、Jev 的风险判断都不能代替批准。P0 即使收到批准对象，也不开放范围外动作。

## 数据与攻击面

- 原始 DOM/AX 和页面文字都是不可信数据，不能创建工具、扩大 allowlist 或覆盖系统规则。恶意页面要求忽略规则、读文件、联网传密钥时仍只允许既有候选。
- 页面采集采用字段白名单，而非只靠正则删密码。password、token、cookie、authorization header、隐藏字段、个人资料和未知敏感容器不进入 state。
- 遇到登录、凭据、支付或无法可靠脱敏的页面，停止外传整页并回退；不能只把 password 值替换后仍发送周边敏感信息。
- fixture 使用可识别的虚构数据与 canary secrets 验证泄漏阻断，日志不记录真实密钥。默认不持久化截图；诊断输出必须脱敏且可清理。
- kill switch 立刻禁止新的决策和动作，取消待执行队列；正在执行的动作不能谎称已撤销，保留 UNKNOWN 直至核实。
