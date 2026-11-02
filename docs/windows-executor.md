# Windows 本机执行器

这是远端真实 Jev 的宿主适配层。独立于 Mac coordinator 运行，不在 Windows 启动替代 mock，也不获取模型 Key、操作员权限或修改计费。公共 Jev 继续处理决策；本机 MCP 执行实际 Windows 操作。

默认 stdio 入口连接一个当前用户私有的 loopback 后台。后台复用浏览器 profile 和 UIA worker；每个 Codex 客户端拥有独立的 Jev continuation、请求日志、标签页及桌面目标。`release` 只清理该客户端，不能关闭其他聊天的标签。共享物理资源的锁与 UNKNOWN 隔离位于后台根目录，不能通过新开聊天绕过。`coordinator.json` 含私有连接能力，禁止公开。

与上游 `jev-local-browser` 四工具入口并存：需要官方 Playwright 扩展或浏览器原生调试接入时，使用其[本机浏览器手册](local-browser.md)。本模块提供持久 profile、受控输入、统一进度/恢复和多客户端隔离，不覆盖上游入口。私密目录与公开 Jev 回执校验复用上游公共实现，原生输入复用上游 NativeDesktopDriver。

首次连接可以启动尚未部署过的本机后台；已有后台记录但无法连通时，不自动重启以绕过用户关闭。操作员确认后可运行 `node dist/src/windows/main.js --config 私有配置路径 --start`。该命令保留历史记录，不自动重放任何动作。后台重启也不能重建已经丢失的浏览器对象；旧请求/动作先查记录，执行状态不明时继续停止。`--direct` 仅用于隔离测试或明确的独立实例。

## 安装与接入

使用 Node 24.19+。在 Windows checkout 安装锁定依赖并编译：

```powershell
npm ci --ignore-scripts
$env:PLAYWRIGHT_SKIP_BROWSER_GC='1'
npx playwright install chromium
python -m pip install --no-deps --require-hashes --only-binary=:all: --target .runtime/python-packages -r scripts/requirements-windows.txt
npm run build
powershell -NoProfile -File scripts/install-windows.ps1 -AllowedFileRoots 'G:\Codex' -RegisterCodex
```

安装脚本保留原 `jev` 入口，只追加 `jev_windows`。它先生成本机私有配置和可审核的 MCP 片段；已有同名配置时拒绝覆盖。省略 `-RegisterCodex` 只生成预览。Codex MCP 配置方式参见 [OpenAI 官方文档](https://learn.chatgpt.com/docs/extend/mcp)。重载后必须通过实际 stdio 初始化和 tools/list 验证，配置文件存在不代表服务已经加载。

此仓库既有服务的文件权限、Unix socket 和目录 fsync 检查针对 Mac。Windows 模块不绕过这些检查。服务回归须在原支持平台运行；Windows 用例单独运行：

```powershell
npm run build
node --test --test-concurrency=1 dist/tests/unit/windows-recovery.test.js dist/tests/integration/windows*.test.js
```

## 路由与使用

- 公共网页且不需要本机身份：原 `jev.browser_*`。
- Windows localhost、已登录本机页面、下载、上传、H5：`jev_windows.browser_*`。
- Windows 原生窗口：`desktop_windows`、`desktop_attach`、`desktop_observe`、`desktop_act`；仅实际 UIA 支持的 Invoke/SetValue/Toggle/Select。没有对应控件时报告不支持，不猜坐标。
- 原生 App 的激活、Unicode 键盘、鼠标、滚动、拖拽或打开文档：使用 `native_status/apps/prepare/observe/act`。这层复用仓库新增的 `NativeDesktopDriver`，不重写其 Windows/Mac 输入逻辑。目标和观察只属于当前客户端；截图保存在私有目录，传给 Jev 的是必要结构与候选，不把 PNG base64 塞进模型文本状态。输入错误可能发生在部分输入之后，按 UNKNOWN 停止，不能换键重做。
- 已配置的 Android 等 host：先 `host_tools` 发现真实 schema，再通过 `host_step` 记录 workflow_id/step_id。同一步骤重取记录不重复操作。执行后必须以新的读取步骤确认实际前台/页面状态。
- 本地控制面板：操作员在配置文件登记固定 loopback URL、状态路径和允许的 POST 模板。普通工具不能动态添加 endpoint、任意请求或管理台能力。`panel_act` 只允许选择这些模板。
- 文件输出：`artifact_inspect` 检查授权目录、真实文件大小、SHA-256、PDF/ZIP 格式与可用解析器结果。没有完整解析时 `full_document_validation` 为 false。

`browser_open` 和每次 `_act` 都调用真实 `jev.choose_action`。观察、截图、核验和本机元数据读取不额外制造一次付费决策。真实 Jev 不可用时不会在接口内替换 mock。`route` 是能力建议，不是操作完成，也不能越过操作员关闭状态。

本机默认打开独立的持久 profile，保留这个窗口的登录状态。不会自动取得日常 Chrome/Edge 的 cookies。配置 `browser.cdpUrl` 可接入已经由用户开放的 loopback CDP 会话并共享其登录状态；只创建和关闭自己的标签，不关闭日常浏览器。此入口须单独实测。Microsoft Playwright 扩展也是后续可选接入方式，当前不宣称已经安装或接入。

H5 支持 iframe 控件、弹窗、视口调整、Canvas 定点触控和固定键盘/触控回放。回放是 Jev 选中的有限事件序列；部分失败或失联后不整段重做。`browser_diagnostics` 读取 Canvas 尺寸、媒体状态、资源和错误；截图或 Canvas 存在不能证明碰撞逻辑、可听音频或真实 iPhone/微信行为。当前工具不接收任意 JavaScript。

## 一致性与恢复

1. 操作前私有存储固定意图、操作编号和请求编号；Windows 目录使用当前用户 ACL，其他平台使用 0700/0600。
2. 自动缓存 continuation，不把 token 放进聊天、普通工具响应、报告或 Git。
3. QUEUED/DISPATCHED 只查原 request_id。丢失提交响应后查原请求；缺失请求或失效 continuation 仍是不确定，不重新提交。
4. 请求、候选动作及执行器绑定不可变。检查 Jev 返回的 provider/model、签名载荷结构和请求/响应摘要绑定。客户端信任配置的 TLS 服务及 coordinator 的验签；这些绑定检查不等于使用独立公钥重新验签。
5. 本机先复核当前快照，再写 executing 和资源隔离记录，之后才输入。进程重开遇到 executing/unknown，或物理响应丢失，禁止重放，使用新编号也不能绕过同一资源隔离。
6. 已知 executed 但后验失败，只重新观察与 `verify_known`，不重复原动作。只有执行器明确证明未开始输入时，才能作为未执行错误处理。
7. `request_recover` 只查询原请求；`operation_status` 查看本机进度。不会重置账本或自动清除未知状态。调查确认后的人工处置应保留原始记录。
8. `release` 只释放本实例。未解决的网络或执行结果阻止释放；其他任务的 owner、共享服务及历史账本不受影响。

日志针对进程崩溃/断连恢复，未承诺已认证的断电持久性。日志、profile、截图、下载和私有配置都位于 `.runtime`，不提交 Git。结束进程时，仅在本机没有不确定输入时关闭自己的浏览器；不确定网络决策的原记录继续保留。

## 范围与验收

UI 自动化只执行当前用户任务授权的动作。工具可用不意味着允许发布消息、改变平台账号、付款或开始付费直播。手机流程保留既有媒体音量上限；当前工具不能替代所有应用的逐项授权和实际验证。

手机适配器拒绝直接或嵌套批处理中的 VOLUME_UP；数值音量设置不能超过 5。当前实际 host 没有音量读取工具，本轮真实测试不改变音量，也不宣称测得实际百分比。

Vidu 等控制面板的 HTTP 状态和回执验证，与实际云端画面/音频/RTC 分开报告。现有 Vidu 换人流程要求操作员确认实际画面，不能由通用 panel 模板代签该确认。没有真实会话时，只能报告本地适配和协议测试结果。

全局 AGENTS 规则负责让 Codex 优先选择正确入口；新 MCP 的写入接口内部强制经过 Jev。它不能从操作系统层面拦截 Codex 所有其他工具。上线前应完成 Windows 离线验收、真实 Jev 本机联调及 Mac 原服务回归，报告每项通过/失败/未测试，不将离线签名器当成真实 Jev。

## 显式真实测试与效率记录

以下命令会调用已配置的真实收费 Jev，不属于普通测试或 CI：

```powershell
node dist/bench/windows/live.js --config .runtime/windows-install/windows.json --report .runtime/windows-real-report.json --desktop --android --h5-root 'G:\Codex\婚礼H5项目\wedding-quest-h5-main\dist'
```

本地 workbench 使用真实浏览器、真实系统控件和真实 Jev；它仍是合成业务页面，不能冒充银行、税务或直播平台成功。`--h5-root` 以仅 GET/HEAD 的本机静态服务测试现有构建，不代理生产 API。原 Android host 必须仍由操作员启用。

runner 故意丢弃一次已经完成的真实 Jev 决策响应，再按原编号查询；这是传输故障注入，未替换模型、伪造决策或重放业务。日志按原 request_id 去重 usage，不将同一动作的重复查询再算一次费用。真实直播不自动开启，画面、音频、RTC 和人工确认仍单独验收。

三段真实 Android 短流程使用 `node dist/bench/windows/android-live.js --config 私有配置路径 --report 私有报告路径 --expected-model 实际已核实型号`。它先匹配单台在线设备，再验证 HOME 与进程重开后的原步骤缓存，最后在稳定页面批量读取尺寸、方向和层级；不分配云设备，不调整音量，不公开互动。

`bench/windows/compare.ts` 接收实测的 `codex-host` 和 `real-jev-windows` 两份同版本、同环境结果，逐项列出耗时和成功状态。它不会把确定性脚本当作 Codex 推理基线，不会相加存在包含关系的检查项，也不会在缺主模型用量或账单时宣称整体节费。
