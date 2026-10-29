# P0 验收索引

最终运行结果见 `artifacts/acceptance/`（由本轮完整验收生成）。本索引用于把交接包要求映射到实际测试；不是凭索引自动判定通过。

| 要求 | 实际测试位置 / 证据 |
|---|---|
| F01 中英文 12 类任务、取消不提交 | `tests/integration/browser.test.ts`；任务完成 oracle；`artifacts/mock/tasks.csv` |
| F02 错误恢复、重复、隐藏/禁用目标 | `tests/safety/browser.test.ts` 主动禁用/隐藏/复制合法目标；correction 真实校验错误与修正 |
| F03 异步、滚动、等待 | 全部六动作覆盖断言与 async/wait/scroll fixture |
| S01 页面注入 | 页面 canary 不产生新候选；固定本地风险规则 |
| S02 最小化与秘密阻断 | 页面/隐藏/URL/伪造状态 canary；实际 provider 输入、持久 ledger 和 telemetry 扫描；产物扫描 |
| S03 非法模型输出 | `tests/unit/contracts.test.ts`、`tests/unit/jev.test.ts`、`tests/safety/core.test.ts` |
| S04 过期与节点变化 | TTL、导航、节点替换、合法输入的事件更新及无事件 property 更新；状态与版本同回合读取；最后校验读取失败不误判为已执行 |
| S05 双客户端争用 | `tests/integration/mcp.test.ts` 实际 stdio clients + 共用 coordinator |
| S06 fencing / 未决隔离 | core late-provider/cancel/timeout/quarantine 用例 |
| S07 幂等与冲突 | durable ledger 重启后返回原结果，不重放；不同 hash 拒绝 |
| S08 崩溃与响应丢失 | 实际 child process 写入 EXECUTING 后退出；dead PID 回收；UNKNOWN 隔离 |
| S09 低置信/无候选/no-op | core 故障注入，执行次数验证 |
| S10 timeout/429/529 | provider deadline、单层重试、Retry-After、请求预算、迟到响应 |
| S11 网络边界 | 两个真实 loopback origin；接收端计数 0；重定向、popup、resource、navigation |
| S12 凭据/支付/风险 | 浏览器整页停止、非白名单值拒绝、无任意 selector/URL/审批扩权入口 |
| S13 kill/cancel/budget | core 单步/时间预算、关闭/取消竞态和 UNKNOWN 保留 |
| S14 未授权 live | 构造器明确授权+注入 key；mock 从不读环境；未授权请求计数 0 |
| S15 身份/畸形请求 | strict schemas + 实际 MCP/IPC 鉴权测试，无 client_id 自报字段 |
| 官方/GitHub 对照优化 | `docs/optimization-review.md`；`artifacts/optimization/`；zstd 解压等价、Unicode 字节阈值、压缩前上限、有限重试复用 |

## 解释边界

- 所有模型响应在本阶段为 mock 或注入的合成 HTTP 响应；未调用官方 API。
- 测试中的 UNKNOWN 是故意注入的执行超时/崩溃结果；正确行为是持久保留、隔离且不重放。测试临时目录清理后不作为可继续的生产会话。
- mock benchmark 的 240 次正常任务与故障注入测试分别报告。不能把工程基线数字当成真实 Jev 加速或真实主模型对照。
- 恢复后旧浏览器不会被重新接管；旧会话保留幂等/状态查询，新任务需新会话。过期或无法确认的物理动作不自动重试。
