# 执行经验、来源与边界

## 已验证的本机能力

2026-11-05 在原验收 Mac 使用官方 jev-1.14.0，两项系统权限均为 true；这不是新机器的权限探测结果。

| 路径 | 验证过的行为 |
| --- | --- |
| 原生日常 Chrome | 观察本任务窗口、真实 AX 按钮、Jev 选择、点击一次、新状态、独立回执、窄窗口截图 |
| 原生 TextEdit | 真实可编辑控件赋值、Unicode/中文、Jev 选择 Command-S、独立读取保存文件字节 |
| 纯 Playwright 库 | 独立 Chrome 上下文；填写、下拉、勾选、提交、正确值与恰好一次服务器回执 |
| BrowserWorkflow | 同一宿主连续执行；导航/历史/切页、主内容滚动、真实下载事件、文件解码和下载历史；逐步 Jev 决策及阶段计时 |
| Session | 同键缓存、参数冲突、新鲜绑定、状态漂移拒绝、物理主机租约、跨重启 UNKNOWN 隔离 |
| 官方多问题 | Choice 与 Noul 同请求返回；没有批量执行物理动作 |

Chrome AX 标题可能为 `页面 - Google Chrome - 资料名`，ScreenCaptureKit 仅为页面标题；当前原生实现支持该实际格式，并保留 PID、精确矩形与唯一窗口匹配。截图坐标必须使用元数据原点与倍率，不猜 Retina 倍率。

后台 App 被激活时，焦点元素可能随激活改变。窗口级按键前先激活，再读新观察，不能拿激活前的焦点快照发送键盘输入。NativeAdapter 已在键盘、文本、滚动、拖拽准备阶段实现这一点。Chrome 新窗口初次加载还需只读稳定观察，不能用尚在变化的标题或焦点继续输入。

页面标签暂时消失采用 unknown/加载状态；等待稳定后再判定条件丢失。切换排序后核验所有筛选条件。去掉已经完成的动作选项，保存目标时用实际文件/业务结果核对，不能只看按钮点过。

连续网页操作的现成接口及实测暴露的布局、编码边界见 [browser-workflows.md](browser-workflows.md)。不要临时重写导航/下载适配器。首次任务的研究和宿主编写时间可能远大于模型耗时，熟悉任务应复用维护好的宿主循环，保留每步 Jev、新鲜绑定和独立后验；不把熟悉题目复跑当成首次盲测成绩。

## 研究与实际采纳

- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)：借鉴动态有限动作空间、复用连接、默认结构化观察、按需截图、保留真实节点与新鲜度校验的原则；不安装或调用其 harness/命令入口、其他文本模型或第三方中转。
- [jkudish/jev-browser](https://github.com/jkudish/jev-browser)：参考无副作用的库入口、机密字段隔离及代码掌握执行循环；未安装该项目，也未接入其 MCP/CLI/provider 自动探测。
- [kerpopule/hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills)：参考将有限选择交给 Jev、按需小状态投影与只记录决策的思路；没有安装 Hermes hook、CLI 或更改 Codex 的模型提供方。
- [官方并列问题模式](https://docs.typesafe.ai/patterns/fan-out)：实现为本机 `ask()`，一次请求可含多个 Choice/Noul；返回后由代码决定相关项。

未复制第三方项目代码或导入其接入配置。实际实现、账本及测试均在本机 jev-fast/direct 中。

## 性能证据与限制

一组相同合成状态的官方判断：两次顺序请求约 1235 ms；合并为一次约 430 ms。说明该样本减少了一次网络往返，不是对所有任务的通用速度保证。

实际独立浏览器四步通过耗时约 950 / 504 / 311 / 580 ms（各步含选择与后验，不含浏览器启动）；重复请求五个已验证动作的缓存没有再次调用模型或输入。不要把缓存耗时或离线假模型成绩当作新 Jev 决策速度。

首次执行器安装验收（skill-executors 历史活动）共 16 次官方请求，已知费用约 $0.000343392，未知为零。该数字只描述当时，后续授权测试已继续使用同一账本，当前累计必须读取实际账本；不能据此旧摘要减记费用或续用额度。包含前置保护拒绝、测试页修正前的部分步骤与重新验证；不能删掉失败来统计成绩。

后续 Chrome 13 组同题复跑：固化后的 BrowserWorkflow 从启动至清理约 56.108 秒；首次盲测为 1158.632 秒。该复跑已有站点和来源知识，不代表所有陌生任务提速 20 倍；开发、四次输入前保护停止及回归另列。50 次真实 Jev 请求、48 次新输入、0 缓存替代；全部历史估算约 $0.008729742，未知 0（仅截至本报告，不是未来授权）。证据与逐动作表：`{{JEV_ROOT}}/docs/reports/2026-11-05-official-direct-acceptance.md`。

Android 现有适配器需要 MCP 后端，本机直连未接入；Windows 原生 PowerShell 代码保留，但这台 Mac 没有做实体 Windows 验收。独立浏览器不复用日常登录态；复杂 iframe、shadow DOM、canvas、上传及新弹窗未提供通用封装。原生 App 的 AX 支持仍须现场观察。

完整工程与费用记录：`{{JEV_ROOT}}/docs/reports/2026-11-05-official-direct-acceptance.md`。历史真实网页案例与流程学习依据：`{{JEV_ROOT}}/docs/jev-operating-memory.md`。本 skill 和全局规则在新 Codex 运行/会话发现时加载；不声称能热修改已经运行的其他对话或第三方 Agent。
