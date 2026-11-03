---
name: jev-ui
description: Execute bounded website and Windows App tasks with Jev choosing observed targets through the official API, local code executing, and Codex taking over on failure. Supports independent Chrome and an IAB adapter, plus native Windows control and OCR assistance.
---

# Jev 本机界面执行器

入口：`C:/Users/Admin/.codex/jev-direct/ui.mjs`，Node 22+。`status` 不产生模型调用。`start RUN.json` 启动任务级本机服务；`desktop RUN_DIR PLAN.json` 和 `chrome RUN_DIR PLAN.json` 执行有界计划。源码、Python 环境和适配器位于 `G:/Codex/Jev control`。

先读已安装 typesafe-ai skill。收费调用必须有当前任务的有效授权文件；既有请求计数、已用费用及错误预留不能清零。无授权时继续准备和只读本地检查，交回 Codex，不伪造 Jev 判断。

网页主路径为独立 Chrome 的 Playwright 执行器。用户指定内置浏览器时，使用 cua_repl 绑定既有 tab，再导入工作区 `executor-loop.mjs`、`file-backend.mjs` 和 `cua-adapter.mjs`，整个有界循环在一次调用内执行。CUA 的本机文件通道只转发决策，密钥留在官方 SDK 进程。不要用本地网页表单中转模型请求，不把独立 Chrome 结果标成内置浏览器结果。

Windows 路径使用 Jev-Desktop 原生 broker/worker，当前验收范围为命名控件点击、填入固定文本并提交、读取结果和保存目标窗口截图。计划给出窗口标题、step id、目标描述、从实时状态得到的合法控件、用户授权的固定文本和独立成功条件。不要依靠输入框里的文本来证明搜索完成；核对结果区，保存证据。

本地 OCR 与官方 Jev 图片 Box/Noul 已完成识别测试；自动坐标点击尚未激活。控件树为空时可用 OCR/图片定位辅助 Codex，不能声称任意自绘 App 已能自动执行。截图只处理目标窗口，外发前遮住账户信息；本轮 Steam 实测只外发了必要控件和裁剪后的公开搜索栏。

API 错误、无匹配、陈旧引用、无法核验或用户接管时，返回结构化 handoff 交给 Codex。结果 unknown 时先核对界面和文件，禁止换入口盲目重放。原生窗口与目标引用由 broker 当场校验；判断不等于执行，执行不等于任务完成。

内置浏览器的 downloadMedia 在本机测试中曾跳到图片地址并超时；恢复时先核对 URL 和文件。可由 Codex 从实际读取到的 DOM 图片来源保存媒体，记录 fallback，不能算成原生下载接口成功。

不启用任何 Jev MCP、Mac 代理或额外模型供应商。Codex 主模型不变。全局规则是代理行为约定，不是对 Codex 内部每个工具的强制拦截。
