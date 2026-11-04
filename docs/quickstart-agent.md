# 官方直连环境与私有配置

默认模块为 `direct/index.mjs`。只安装 `direct/` 的依赖，不启动旧 profile、网关、mock 控制台、MCP 后端或 GUI CLI。

目标机需要 Node 24.19+ 和已安装的 Google Chrome。macOS 原生 App 还需 Swift 工具链、交互式图形登录会话和本机辅助功能/录屏授权；Windows 保留原生后端源码，但本轮只验收原 Mac，不能声称 Windows 实体机已通过。

依赖安装为 `npm --prefix direct ci --ignore-scripts`。根目录 build/typecheck/lint/test/test:integration/test:safety 均转到 direct；build 编译 TypeScript 核心及 Mac Swift helper。默认使用已安装 Chrome，无需另装 MCP 浏览器。

## Codex 全局设置

本机 Node 宿主导入 `direct/index.mjs` 的 `installCodexDefaults`，调用 `installCodexDefaults({root:实际安装绝对路径})`。默认目标是 CODEX_HOME 或本机用户的 `.codex`；安装器备份原 skill/AGENTS、渲染本机路径、更新一个托管准则块，保留无关规则。它不联网、不请求模型、不处理 Key、不改 MCP 或模型配置。新开/重载 Codex 对话后验证默认发现。

仓库 skill 是路径模板，不能将含 `{{JEV_ROOT}}` 的文件直接复制为安装版。模块路径会按 JSON 字符串转义，支持空格、中文和引号；发现损坏标记或符号链接目标会停止。

## 本机凭据与状态

用户在本机私下填写 `<安装目录>/.runtime/direct/api-key`；POSIX 目录0700、文件0600，Windows 使用私有 ACL 检查。Key 不进入聊天、参数、日志、skill 或仓库。已有 Key 和账本不覆盖。新机不复制其他电脑的 Key、cookie、profile、系统权限或付费授权。

官方端点 `https://api.typesafe.ai/v1/systemone`，模型 `jev-1.14.0`；模型推理在官方执行，不下载本机权重。安装路径固定，升级保留 `.runtime`；禁止建立另一安装绕过同一物理主机账本或 UNKNOWN。

先跑离线检查和原生 `status()` 只读探测。沙盒看不到桌面先核对真实图形上下文，不直接判断缺权限。需要系统授权、验证码或密码时请用户操作，不能切换控制通道。

普通测试不请求付费 API。真实 Chrome 基准必须显式提供 `JEV_ACCEPTANCE_BUDGET_DIR` 和 `JEV_ACCEPTANCE_LIMIT_USD`，复用当前已授权活动账本；缺少配置在请求前拒绝。历史 $0.50 不授予新机任何额度。[执行器说明](agent-integration-guide.md)。
