# 服务常驻与故障恢复

当前 Mac 使用用户级 launchd 守护进程监测原 `/tmp/jev-501` 服务链；公网 relay 使用 systemd 自动恢复。守护恢复针对程序异常退出，不保证断电、未登录、上游中断或证书失效期间可用。不会为了恢复删除 SQLite、重置账本或启动 mock。

## 操作人员日常使用

统一控制台仍是同一页。服务总开关通过 CLI 保存 `service-intent.json` 中的 running/stopped 意图：

- 开启：保存选定配置的绝对路径与 fingerprint，然后启动或复用原服务。
- 关闭：先持久保存 stopped，再请求协调器停止。守护不会将其重新打开。
- 崩溃：仅在 running 时，使用保存的原配置恢复。配置缺失、改变或不安全时失败关闭，不退回 mock。

原来的 CLI 命令仍可使用；守护内部额外使用 `service start --recover --runtime ...`。`--recover` 不接受替换配置，不写入新的 running 意图。不要通过删运行目录来“修复”状态。

设备登记新增私有 `manual/registration.json`：它只允许恢复同一个设备，保留设备开关和 generation；不恢复旧 AI owner 或 relay 重启前的 continuation。失效的登记不会自动创建另一设备绕过关闭。已有客户端若收到 CONTINUATION_INVALID，应保留旧请求记录、停止重放，并在核查后从新的独立任务开始。

## 安装到其他机器的运维说明

这不是公网业务工具。操作者创建 owner-only 的守护配置（目录0700、文件0600），使用实际绝对路径：

```json
{
  "version": 1,
  "runtime": "/absolute/private/runtime",
  "coordinator": {
    "node": "/absolute/node",
    "cli": "/absolute/jev-fast/dist/src/cli/index.js"
  },
  "jobs": [
    {"id":"gateway","command":"/absolute/node","args":["/absolute/private/gateway-runner.mjs"],"cwd":"/absolute/jev-fast"},
    {"id":"connector","command":"/absolute/node","args":["/absolute/jev-fast/dist/src/network/main.js","connector","--config","/absolute/private/connector.json"],"cwd":"/absolute/jev-fast","locks":[{"directory":"/absolute/private/runtime","name":"network-connector.lock"},{"directory":"/absolute/private/connector-journal/manual","name":"owner.lock"}]}
  ]
}
```

可选 job id 还有 `panel`、`tunnel`。命令由私有运维配置固定，不能通过公网工具传入。网关先恢复，协调器就绪后恢复连接器；控制台和管理隧道独立恢复，便于停机时操作。

```sh
node /absolute/jev-fast/dist/src/service/supervisor.js --config /absolute/private/supervisor.json --once
# 由 launchd 持续运行时去掉 --once
```

**不要直接覆盖已有运行环境安装守护**。守护以 `watchdog-<id>.json` 的 PID 和配置摘要识别已有 job。操作者必须先核对并接管现有进程，或完成受控排空后安装；无标记时按新 job 启动。存活但身份不确定的 PID 不会被杀掉重启。job 配置改变后需要操作者重新核对接管，守护不会自行替换运行命令。

遗留锁只在所属 PID 确认 ESRCH、父目录/文件私有且 inode 未改变时移除；EPERM、未知 PID、符号链接等均不当作已死亡。协调器仅清理已死亡进程的 socket/凭据/锁，Ledger 自身将未完成操作保留为 UNKNOWN。即使恢复在线，也不能重放 UNKNOWN 操作。

公网部署模板为 relay 设置 `Restart=always`、3秒重启间隔和三个 Audit 锁的 `ExecStartPre` 检查。显式 `systemctl stop jev-network` 仍会保持停止。请使用 `deploy/network` 中与实际 Node/存储路径匹配的模板；不能把 Mac 原服务私有路径复制到另一机器。

控制台可指定 `--token-file`，relay 私有配置可指定 `adminTokenFile`，复用操作者提供的现有0600随机能力文件，使进程恢复后原管理链接仍可用。未配置时保留原来的每次随机能力行为。这些能力仅管理端使用，不能发布到 Git 或发给接入 AI。
