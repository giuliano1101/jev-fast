# Windows 本地浏览器与 Jev 常驻恢复

日期：2026-11-02。

## 交付内容

公网 `jev.browser_*` 原本就在 Mac 服务进程中创建隔离无头浏览器。Windows 客户端调用这些工具不会把浏览器搬到 Windows；这次新增独立 **jev-local-browser stdio MCP**，将实际执行放在调用方机器，继续使用现有公网真实 Jev 选择动作。

四个入口是 `jev.local_status`、`jev.local_tools`、`jev.local_observe`、`jev.local_act`。默认启动可见的 Edge/Chrome，也支持本机 CDP、官方浏览器扩展连接已有登录浏览器。观察读取真实后端 schema，动作参数留在本地；传给 Jev 的是任务、状态和候选描述。沿用 HostService 的持久 journal、顺序与 UNKNOWN 规则。

安装与接入步骤见[Windows 本地浏览器说明](../local-browser.md)。未新增 Windows public host，没有替换原 Android 配置。

## 常驻服务部署验收

原 Mac 的协调器和网关保持原 PID，没有为上线本地浏览器重启。网络连接器与 relay 做了一次排空维护后恢复同一个设备登记；旧 continuation 失效，旧 Windows 已完成请求的记录摘要前后一致，未重放。

Mac 已安装用户级 `com.jev.service-watchdog`，通过 launchd KeepAlive 运行；caffeinate 防止守护运行期间的空闲系统睡眠。接管的五项状态均为 running：协调器、网关、连接器、统一控制台、压缩管理隧道。relay 已设置 systemd `Restart=always`、3秒恢复间隔与已死亡审计锁检查。显式 `systemctl stop` 仍保持停止。

原服务已将开关意图绑定到用户持久私有目录，`/tmp` 清理后仍保留；`/tmp` 与 `/private/tmp` 匹配同一物理 runtime，别名不能分裂权威来源。本地服务总开关先持久记录 stopped，再请求停止；恢复只用原选定 profile。手动设备关闭也跨重启保留，不创建新设备绕过关闭，不复活旧 AI owner。进程恢复仅处理已证明死亡且路径/inode/所有者校验通过的临时标记，不删除 SQLite、计数或 UNKNOWN。

上线后实测：`enabled=true`、`connector_online=true`、`local_ready=true`、真实 `remote · Jev` ready。原控制台访问能力继续有效，Android 实际后端仍返回33个工具。Key、原 profile、usage-only 指令、连接器配置摘要均未改变，账本未重置。持久意图只保存开关与 profile 选择，不将临时会话目录自动备份。验收记录见[服务恢复证据](../../artifacts/local-browser/deployed-recovery.json)及[Android 证据](../../artifacts/local-browser/android-ready.json)。

## 测试题目与结果

| 场景 | 操作及验收条件 | 结果 |
| --- | --- | --- |
| 原设备恢复 | 持续运行连接器，重启隔离 TLS relay；同一设备 ID 恢复，旧 AI owner 保持撤销 | 通过 |
| 手动关闭 | 关闭隔离设备再重启 relay；desiredEnabled 和 enabled 都保持 false | 通过 |
| 无效旧设备 | 私有句柄不属于原 relay；报 DEVICE_RESUME_INVALID，不能创建替代登记 | 通过 |
| 临时网络异常 | 注册先收到503 HTML，第一次同步收到空410；恢复时沿用原句柄 | 通过 |
| 协调器崩溃 | 对隔离协调器 SIGKILL；守护恢复原 profile，保留账本；健康时不重启 | 通过 |
| 服务链崩溃 | 隔离网关、协调器、连接器等退出；先网关后协调器和连接器恢复 | 通过 |
| 开机恢复意图 | 删除隔离运行目录后仍读取同一持久 running/off；路径别名共用唯一权威 | 通过 |
| 本地总开关 | RPC 不可达也先保存 off；守护不会重开；panel/tunnel 仍可恢复 | 通过 |
| 控制台恢复 | 重启隔离面板，原私有能力继续访问；空 token-file 拒绝 | 通过 |
| 已有浏览器 | 本机实际 CDP 标签输入，关闭 MCP 后浏览器/标签/输入值仍存在 | Mac 通过；Windows CI 见下 |
| 可见新浏览器 | 实际可见窗口导航、输入，页面收到输入事件 | Mac 和 Windows runner 通过 |
| 云端选择恢复 | 丢 choose 回复只查原 UUID；并发首调等待 initialize；无效 continuation 不换身份 | 通过 |
| 本地幂等 | 同 key 重开、移动同一私有状态目录后不重放；动作参数未进云请求 | 通过 |

完整本机检查：typecheck、lint 通过；单元541/541；集成116通过、0失败、1个可见窗口用例默认跳过。随后显式开启该用例，两项本地浏览器实际交互均通过。安全测试40/40，部署 Python 测试16/16。普通测试与 CI 都没有调用付费模型。

第一轮并发单元中有一个既有 continuation 用例失败；单独五项通过，完成修改后的完整538项重跑通过。CDP 初版用原始进程启动新版测试 Chromium，页面 load 超时；改为 Playwright 正式 persistent-context 启动后通过，未增加超时。旧 remote CLI 测试原先期望未传配置时报错；现在明确复用已选择的 remote profile，测试改为核对同 profile、身份和 PID，不回退 mock。

Windows CI 发现了路径分隔符、PowerShell 模块解析及冷启动问题。旧 JSON cmdlet 的阶段记录停在 ConvertFrom-Json；改成 .NET JSON 后曾整套通过，但主分支再跑仍有一次超时，没有将它归因到未经证明的唯一原因。最终助手只使用系统核心 ACL API：路径作为环境数据传入，输出只含已校验的 SID 字符及固定布尔值，去掉模块发现、额外 JSON 程序集和 stdin EOF 依赖。SID/DACL 保护与超时保持不变。新增五个全新 SDK 最小环境子进程，覆盖中文、&、$ 路径。失败和通过记录均保留，没有跳过测试。

Windows runner 最终验收：[GitHub Actions 41407017995](https://github.com/giuliano1101/jev-fast/actions/runs/41407017995) 全部通过。12/12 单元检查包含五个全新 SDK 最小环境子进程；2/2 真实浏览器集成检查包含可见输入与 CDP 标签存活；Edge 扩展配置生成通过。同一代码修订 `8c42723` 的 [Mac 完整 CI](https://github.com/giuliano1101/jev-fast/actions/runs/41407018028) 也通过。这是 hosted Windows runner，尚非用户实体 Windows 的登录浏览器/扩展验收。

## 真实 Jev 验收

在这台 Mac 的可见本地浏览器中，由现有公网真实 `jev-1.14.0` 从各两个候选中选择正确动作：

1. 打开本机临时验收表单：12.67秒，实际执行 open。
2. 在 Local note 输入 `jev-local-visible-verified`：8.87秒，实际执行 type。

独立 HTTP 输入事件和重新读取的页面 snapshot 都验证到正确文字。导航时间包含浏览器冷启动，不能当作稳定速度基准。两条返回 usage 合计766 input / 62 output tokens；按当前账本0.042美元/百万输入 tokens，已知输入费用约0.000032172美元。原 usage-only 账本继续记录实际调用，未创建或重置审批。[真实验收证据](../../artifacts/local-browser/live-verification.json)。此实测证明 Mac 上的同一入口能使用真实 Jev；不能替代用户 Windows 的实机验收。

## 使用与边界

Windows 端仍需安装本地 MCP，服务端无法直接访问一台尚未安装执行器的 Windows 浏览器。请按[使用说明](../local-browser.md)生成本机绝对路径配置，再确认 platform=win32、execution_host=local 和页面实际后验。现有浏览器的调试许可/扩展首次授权由浏览器自身要求，仍需在目标 Windows 上完成。

常驻需要 Mac 开机并登录，上游网络和证书仍需运维；当前私有客户端证书有效期至2026-12-01。API Key 和管理能力已保存为0600的私有持久副本，值未改变；未来后台启动使用持久引用，避免临时文件清理后失联。[凭据持久化验收](../../artifacts/local-browser/persistent-credentials.json)。守护不会绕过证书校验、切换 mock 或删除历史。[守护运维说明](../service-recovery.md)。
