# 本机 Mac / Windows App 执行器

原生执行器保留真实窗口观察、辅助功能、鼠标键盘与截图能力。CLI/MCP 外壳已删除；通过本地模块使用，不经过公共 Mac 桥。

## 安装与直接调用

```sh
npm run build
```

Mac 需要 Swift 编译工具链。Windows 使用原 PowerShell / UI Automation / Win32 实现，必须在目标 Windows 的交互式登录会话中验证。

```js
import {DesktopExecutor} from './direct/index.mjs';
const desktop = new DesktopExecutor();
try {
  const status = await desktop.call('desktop_status', {});
  console.log(status); // 检查实际 accessibility / screen_capture，不公开账号状态。
  const state = await desktop.call('desktop_get_state', {app: 'com.google.Chrome'});
  // 从 state 读取真实 observation_id、element_id 和窗口，不猜测控件。
} finally {
  await desktop.close();
}
```

`.tools` 提供 14 项 schema，`.call(name,input)` 返回原生结果对象，截图像素位于 image，与 image_metadata 坐标信息一起处理。输入方法依旧要求最新观察 ID；直接调用不会自动产生 Jev 决策、计费或业务幂等，宿主须组合本机决策和 journal。

## 保留的能力

| 方法 | 用途 |
| --- | --- |
| desktop_status / desktop_list_apps | 平台、权限、运行中的 App |
| desktop_launch_app / desktop_open_document | 启动已装 App、打开指定文档 |
| desktop_get_state / desktop_screenshot | 窗口、AX 控件、截图与坐标映射 |
| desktop_activate_app / desktop_click | 激活窗口、点击真实控件或观察坐标 |
| desktop_type_text / desktop_set_value | Unicode 输入与控件赋值 |
| desktop_press_key | 命名按键与组合键 |
| desktop_scroll / desktop_drag | 滚动、拖拽 |
| desktop_perform_action | 调用控件实际暴露的原生动作 |

Mac App 可使用 bundle ID、PID、名称或安装路径。日常 Chrome 使用 `com.google.Chrome`，复用其当前窗口和登录状态，不重启 Chrome、不复制 cookie。Windows 使用该主机的进程、路径和控件，Mac 驱动不能代替 Windows 本机执行。

## 已保留的经验与边界

新观察替换同 App 的旧观察；发生控件变化时拒绝 STALE_OBSERVATION。原生 helper 丢失动作结果时不自动重放；关闭会尽力释放输入并收尾自己的 helper。

Chrome 的 AX 窗口标题可能带“ - Google Chrome”或“ - Google Chrome - 个人资料名称”，截图窗口可能只有文档标题。匹配仅规范化实际 App 后缀，以及已观察到的 Chrome 资料后缀格式；仍要求精确 PID、窗口矩形和唯一候选。不会把任意 App 的任意尾部文字都删掉，也不会随意选一个同名窗口。

2026-11-05 原验收 Mac 实测：宿主在实际图形登录会话运行时，accessibility / screen_capture 均为 true，已完成 Jev 官方直连 → Chrome 原生点击 → 独立后验与窗口截图。沙盒内可能返回 false、APP_NOT_RUNNING 或空 App 列表，不能据此断言系统缺少授权。应先核对执行上下文。[实测记录](reports/2026-11-05-official-direct-acceptance.md)。

截图带坐标原点及 scale，不能猜 Retina 比例。优先指定 App/窗口；整屏会包含其他窗口。Mac 辅助功能/录屏权限、Windows UIPI/受保护桌面、App 的 AX 支持和主机是否登录影响可用性。无应用白名单不等于所有应用都已验收。

历史实测保留：[原生桌面报告](reports/2026-11-02-native-desktop.md)、[Chrome / TextEdit 与窗口截图报告](reports/2026-11-03-public-mac-automation.md)。这些记录证明当时版本的指定题目，不是当前所有主机的权限或成功保证。

## 未决桌面步骤的安全核查

默认会话目录是安装目录下的 `.runtime/direct/native-session`。`openDesktopSession` 不传 `directory` 时使用它。不要另建目录绕过 `physical-host`。

离线测试不能代替这台 Mac 的图形会话核查。下面的步骤只读或只恢复账本，不要求发出新的点击、按键或出图任务。

1. 在实际图形登录会话中，用本机 Node 24.19+ 从安装目录执行只读核查：

```sh
npm --prefix direct ci --ignore-scripts
npm run build
node --input-type=module -e "import {inspectDesktopSession} from './direct/index.mjs'; console.log(JSON.stringify(inspectDesktopSession(), null, 2))"
```

2. `CLEAR`：没有 pending，也没有 `PLANNING` / `EXECUTING` / `UNKNOWN` 步骤。可以另开只读观察：`openDesktopSession({app})` 后 `session.observe()`，然后 `close()`。不要为了验证恢复去跑出图步骤。
3. `BUSY`：`physical/owner.lock` 仍在。`lock.owner` 只说明 pid 看起来是否存活，程序不会据此删锁。确认该 pid 确实没有进程后，把整个 `native-session` 目录复制到备份，再只把这把死进程锁移入备份。保留 `executions.json`、`steps.sqlite`、`-wal` 和 `-shm`。然后重新执行第 1 步。
4. `QUARANTINED`：先看 `steps[].code` 和 `matchingResolutions[]`。只读观察一次，关闭 Session，再把新的 `observation_id` 交给 `reconcileDesktopSession`。Session 开着时恢复会返回 `JOURNAL_BUSY`。证明规则、官方字段和 2026-11-07 journal 已清但 steps 仍 UNKNOWN 的处理方式见 [Session API](../skills/jev-direct/references/api.md)。恢复后再次 `inspect`，期望 `CLEAR`；再开一次 Session 做只读 `observe()`，然后关闭。同一步的旧幂等键会返回缓存且不会重放。不要为了这项核查发送新的按键或出图任务。
5. `UNREADABLE`：停止。先备份，不要删除或手改账本来换一个可读结果。
