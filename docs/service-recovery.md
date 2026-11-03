# 本机生命周期与恢复

保留启动锁、私有文件检查、持久 running/stopped 意图、profile fingerprint 和 proven-dead 恢复原语；删除集中式 relay/connector/tunnel 的 Supervisor 和 CLI 外壳。各主机由自己的进程管理器管理本地宿主，不能继续使用旧的四进程集中服务配置。

宿主调用 `startService({runtime, recover:true})` 时仅恢复原先明确 running 的配置；manual off 不重开，缺少/变化/不安全的 profile 失败关闭，不自动切 mock。正常显式启动使用 `startService({runtime,configFile})`，停止使用 `stopService(runtime)`。具体 API 见[快速开始](quickstart-agent.md)。

不能根据超时就认定旧进程已死。删除锁前必须确认标记属于已退出进程，且保留 SQLite/journal/UNKNOWN 记录。配置和凭据需实际安全权限；同用户权限不抵御同用户恶意程序。

源码更新不自动升级或终止已运行进程。旧部署服务、launchd/systemd、隧道和服务器配置是否已停用，见[本轮报告](reports/2026-11-04-per-host-core.md)。当前仓库不再为旧公网服务提供恢复脚本。
