# P0 设计决策

1. TypeScript 单工程，严格 schema 共用；Node 原生 test runner，Playwright 专用隔离浏览器；本地服务绑定 loopback，MCP stdio 通过私有 IPC 协调。无已有仓库，不创建远程或发布代码。
2. 固定模型 `jev-1.14.0`；直接 HTTP fetch，不使用 TypeSafe SDK，避免默认重试与项目重试叠加。官方请求为 model/state/questions，单个完整动作对应 Choice；响应由 answers 提取。参考 [System One](https://docs.typesafe.ai/api/system-one)、[Choice](https://docs.typesafe.ai/primitives/choice)，2026-10-30 复核。
3. 当前文档模型输入价 $0.042/M tokens、输出免费；S0–S5 不发计费请求。真实测试仍需单独授权上限与窗口。参考 [Models](https://docs.typesafe.ai/models)，2026-10-30 复核；账户实际账单是最终依据。
4. 429/529 只在剩余时间、请求和费用预算内有限重试；动作超时进入 UNKNOWN，禁止重放。参考 [Errors](https://docs.typesafe.ai/api/errors)。
5. 页面文字不授权动作。仅 fixture 预先定义的语义字段、绑定参数和成功谓词进入流程；密钥、DOM、任意地址和输入值不进入持久日志。凭据/支付页面整页停止。
6. 不提供任意脚本/坐标工具，不读取常用浏览器 profile，不申请系统控制权限，不开放公网，不修改其他 agent 全局配置。
7. 固定 12 模板 × 中英 × seeds 1–5 为评测集；校准集预留 seeds 101–105。scripted 和 mock 是工程回归两种模式，均不代表真实主模型或 Jev 性能。
8. npm 依赖仅项目本地安装，锁定精确版本；Playwright Apache-2.0，TypeScript Apache-2.0，Zod/MCP SDK/ESLint/typescript-eslint/Node types MIT。完整直接与间接版本以 package-lock.json 为准。
