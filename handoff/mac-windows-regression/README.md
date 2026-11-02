# Mac 端执行任务：Windows 执行器兼容性回归

这是给 Mac 端 AI/操作员的执行指令。用户已授权通过私有 GitHub 仓库传递本轮待验证源码，并要求完成后清理。此分支为临时测试交付，不代表正式合并、部署或全局启用。

分支：`handoff/mac-windows-regression-20261102`

源代码基线：`56d4cd5e8fc80064aa112b11cf6abe2c2cc0524b`，加本轮 Windows 统一执行器及私有目录权限修复。Windows 实测已经通过；本任务只补 Mac 平台回归。

## 请立即执行

使用 Mac 上已有 GitHub 凭据，创建独立临时克隆；不要在运行服务的源码目录中 checkout、pull 或安装依赖：

```bash
JEV_MAC_TASK_DIR="$(mktemp -d /tmp/jev-windows-mac.XXXXXX)"
git clone --single-branch --branch handoff/mac-windows-regression-20261102 \
  https://github.com/giuliano1101/jev-fast.git "$JEV_MAC_TASK_DIR/repo"
bash -n "$JEV_MAC_TASK_DIR/repo/handoff/mac-windows-regression/run.sh" &&
bash "$JEV_MAC_TASK_DIR/repo/handoff/mac-windows-regression/run.sh"
```

如果已有凭据采用 SSH，可将 clone 地址换为 `git@github.com:giuliano1101/jev-fast.git`。不要索取或上传 token、Key、profile。GitHub 是本次唯一源码传递方式；不用 Windows 下载服务器。

脚本要求 Node >=24.19、npm、Python3、pip 和 Xcode Command Line Tools/Swift；会安装锁定 npm 依赖、Chromium、哈希锁定的 pypdf 并编译本地驱动。使用独立源码和 npm 缓存；Playwright/Swift 可能更新其标准编译或浏览器缓存。依赖或编译失败会生成失败/未运行报告，不能算测试通过。

测试包括 typecheck、lint、unit、integration、safety、Python deployment 和只读原生协议回归。不会运行 `bench/windows/*live*` 或调用收费 Jev 服务。部分 Windows 专用测试在 Mac 上会跳过，报告必须保留 skip 数。测试创建的浏览器只用于测试；不复用日常登录。

不要重启、停止或重配 `/tmp/jev-501` 的现有真实 Jev、relay、connector；不要切 mock、重置账本、改计费/授权或清理其他 owner。不要申请额外辅助功能/屏幕录制权限：此任务没有真实 App 输入验收。

## 回传结果

读取 `$JEV_MAC_TASK_DIR/repo/.runtime/mac-regression/result.json`，把完整汇总 JSON 返回 Windows 端 AI。失败时补充脱敏的失败测试名、错误码和必要堆栈；原始日志留在临时目录，不上传账号/设备/路径隐私。失败必须如实报告，不静默修改测试、跳过失败项或宣称全通过。

如果需通过仓库回传，只在本临时分支新增 `handoff/mac-windows-regression/result.json`，内容仅为上述汇总 JSON；提交前核对 `tested_revision` 为实际被测提交。不要推送 main，不要提交 `.runtime`、日志、依赖、凭据或修改业务源码。Windows 端会按此路径取回结果。

## 完成后清理并提醒

1. 先让 Windows 端收到并保存结果；失败日志仍需排查时暂留，说明原因。
2. 确认没有本次测试子进程仍在运行。只清理自己这次创建的浏览器、驱动和临时目录。
3. 删除前解析并核对绝对路径：只能删除本次 `mktemp` 创建的 `/private/tmp/jev-windows-mac.XXXXXX`（或等价 `/tmp` 路径），不能删除现有服务目录、用户源码或系统浏览器缓存。
4. 向 Windows 端明确提醒：“结果已回传，请删除 GitHub 临时分支 handoff/mac-windows-regression-20261102。”在 Windows 确认收件并保存源码/结果后，可用 `git push origin --delete handoff/mac-windows-regression-20261102` 删除该分支。临时交付内容只在此分支，无需在 main 删除任何功能代码。

不要把此说明的上传视作 Mac 测试已执行；以实际结果 JSON 为准。
