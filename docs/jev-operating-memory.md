# 这台 Mac 的 Jev 使用经验

日期：2026-11-05（Asia/Shanghai）。用户明确选择官方 API Key 直连；不使用仓库内的 Jev MCP、Jev CLI、历史网关或跨主机操作策略。先读 [本机直连部署](direct-api-local.md)。

本机已安装 `jev-direct` skill 和全局 AGENTS 默认准则。新的真实输入优先通过 Session，自动处理重绑、置信度、持久幂等与后验；[可复用 API](../skills/jev-direct/references/api.md)保存具体用法。

## 已继承的执行方式

1. **宿主负责规划和授权，Jev 负责窄选择。** 用当前观察构造有限、互斥、带稳定 ID 的单步候选。候选数组不是步骤脚本；只执行返回 ID 对应的本地动作。任意文本输入由宿主提供，不能把 Jev 当作文本生成模型。
2. **当前状态优先于历史。** 每轮读取真实控件、值、选中状态和 observation_id。执行前再次绑定；旧观察、窗口变化、控件遮挡应停止或重新观察，不能凭上次坐标继续点。
3. **去掉已满足或没有进展的候选。** 给复杂任务明确当前阶段。表单准备可以由宿主组合，但每个字段输入前重新绑定，提交前检查全部字段，提交单独决策。
4. **加载时先只读等待。** 谓词采用 true / false / unknown 三态。筛选标签暂时消失不等于条件永久丢失。排序后同时重查所有筛选条件，不能只验证最后一个控件。
5. **后验独立验证。** Jev 选择、点击成功或 DONE 都不等于完成。读取新界面、实际文件字节、业务状态或可核查 URL。计算任务核对输入日期和实际结果文字。
6. **未知结果不能重放。** 物理输入前持久写账本；超时、响应丢失、进程重启留下的未决记录保持 UNKNOWN。保留 goal_id / idempotency_key；不得换键、删账本、换执行者绕过隔离。只有可信只读证据能解除未知。
7. **同一真实界面顺序操作。** 混合控制器有进程内租约，文件账本有独占锁；其他 AI 或进程仍须由宿主统一协调。仅关闭本任务拥有的窗口、标签页和 helper。
8. **低置信度交回宿主。** 历史混合策略以 0.90 为阈值；无效选项、无进展、状态漂移或后验失败停止输入，交给当前 Codex 宿主核查。直连 choose 本身只返回决策，不自动施加阈值或执行动作。
9. **只学习经验证的流程。** ProcedureStore 以账号范围、环境指纹和 TTL 匹配。三次独立成功、至少两个起始状态才激活；重复证据、未知结果不算成功，确认回归应隔离版本。不能从一次成功推断通用规律。
10. **费用与失败如实记录。** 使用 UsageLedger 逐请求计量；缺失 usage 保留未知，不当作零。普通测试全部离线；真实 API 请求另行验收。直连决策没有自动重试，也没有额外总费用/次数封顶。

## 原生 Mac 执行器经验

- 使用 `DesktopExecutor` 的 14 项本地方法，读取 `desktop_status` 检查实际辅助功能/录屏权限。
- Chrome 可以用 `com.google.Chrome` 读取当前窗口，复用当前登录态。是否可观察取决于本机权限和 App AX 支持。
- 点击以真实 observation_id / element_id 绑定。截图坐标必须采用 image_metadata 原点与 scale，不猜 Retina 倍率。
- Chrome AX 标题与截图标题的后缀可能不同；这台机器的 Chrome AX 标题会附加 App 和个人资料名称，ScreenCaptureKit 只给文档标题。原生实现已覆盖这两种已观察格式，仍要求 PID、精确矩形及唯一窗口匹配；保留文档中类似后缀的文字，不能任意裁掉尾部。
- 先区分执行上下文与系统权限：沙盒内 false / APP_NOT_RUNNING 不等于真实桌面缺少授权。2026-11-05 在实际 GUI 宿主上下文复查两项权限均为 true，随后原生操作及截图成功。后续任务应在同一真实桌面上下文执行，不因沙盒结果误导用户反复授权。
- App 被激活时，焦点元素可能改变。键盘、文本、滚动、拖拽在原生 Session 中先准备焦点，再读新观察；新 Chrome 窗口首次加载时还需要稳定观察，不能用激活前/加载中的快照发送按键。已由首轮保护拒绝与后续实测验证，拒绝记录和可信未执行核对均保留。
- 隐藏 HTML input 的 DOM 尺寸为零，AX 可能仍有可操作控件；必须先观察当前选中状态，再用真实 AX 控件，不能盲点隐藏元素。

## 官方 API 的补充原则

官方端点为 `POST https://api.typesafe.ai/v1/systemone`，认证为 Bearer Key。输入是 state、model、具名 questions。Choice 返回 choice / probabilities / confidence；选择不提供执行权限。

可对同一 state 在一个请求中并列提出多个原子问题，再由代码选择相关结果，以减少网络往返。底层 JevChoiceProvider 仍是一项动作 Choice；新增 `ask()` 已支持同一官方请求中的多个 Choice/Noul，并在本机完成真实测试。它不等于自动批量执行多个物理动作。当前本机固定 `jev-1.14.0`，避免移动别名悄悄改变既有契约。

## 原始证据与边界

- [宿主集成规则](agent-integration-guide.md)、[原生执行器](native-desktop.md)、[混合实现](hybrid-implementation.md)。
- [真实网站与抖音实验](../artifacts/real/report.md)：最终修复版 8/12；搜索和复杂筛选仍有低置信度失败。受约束任务的速度不能外推为通用能力。
- [混合故障回归](../artifacts/hybrid/report.md)：区分暂时重绘与持久重置；UNKNOWN 跨重启保留。属于离线受控验证。
- [2026-11-03 Mac 原生报告](reports/2026-11-03-public-mac-automation.md)仅取执行器与窗口匹配经验；里面的历史接入入口不适用。
- 混合模块仍是研究型控制器：原有单次会话 12 动作/13 决策/300 秒与最多一次 teacher 的限制保留，只在显式调用该模块时适用。直连 choose 不附加这些限制。
- 当前 Codex 可以作为受监督教师，但尚未建立无人值守 teacher 服务。Android MCP 后端未接入本机直连；独立 DOM 浏览器现已通过纯 Playwright 库接线和真实官方 Jev 验收，包括填写、下拉、勾选、提交及幂等。

官方资料：[API](https://docs.typesafe.ai/api/system-one)、[模型](https://docs.typesafe.ai/models)、[Choice](https://docs.typesafe.ai/primitives/choice)、[并列问题](https://docs.typesafe.ai/patterns/fan-out)、[置信度路由](https://docs.typesafe.ai/patterns/confidence-routing)。
