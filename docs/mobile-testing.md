# 安卓真实交互研究工具使用说明

这是 S9 的固定题库适配器，不是任意手机操作接口。正式 CLI/MCP 的六工具仍使用隔离浏览器；本研究工具通过已有 Mobile MCP stdio 服务操纵一台明确指定的安卓设备。

## 准备

安装锁定依赖、编译项目；独立准备 Mobile MCP、其 Android 连接依赖及已授权设备。原测试使用 Mobile MCP 1.0.8、OPPO Find X3 Pro、Android 12；不同系统的设置页结构需要单独适配，不能直接宣称兼容。

```sh
npm ci --ignore-scripts
npm run build
```

在仓库外或被忽略的 `.runtime/` 内保存权限为 `0600` 的配置文件。以下占位值必须替换，文件不得提交：

```json
{
  "serverCommand": "/absolute/path/to/node",
  "serverArgs": ["/absolute/path/to/mobile-mcp/lib/index.js", "--stdio"],
  "serverEnv": {"PATH": "/absolute/adb/directory:/usr/bin:/bin", "MOBILEMCP_DISABLE_TELEMETRY": "1"},
  "device": "PRIVATE_DEVICE_ID",
  "runtimeDirectory": "/absolute/private/mobile-runtime",
  "scope": {
    "applicationId": "android_settings_browser",
    "pageType": "mobile_public_research",
    "accountScope": "64_CHARACTER_SHA256_HEX",
    "language": "zh",
    "environmentFingerprint": "64_CHARACTER_SHA256_HEX",
    "observerVersion": "mobile_observer_v1"
  }
}
```

使用独立、已有的批准预算账本。运行器只打开现存账本，不创建或重置预算。真实调用必须同时提供私有 key 文件、批准文件和预算目录；批准包含 `approval_id`、毫秒时间戳 `expires_at`、`public_controls_only: true`。每个请求开始前持久保留 $0.01；这个保守保留额不是供应商实际账单。严格保留同一个运行目录和设备账本；不能为了重试换目录。

## 执行与结果

先人工或通过 `resetMobileHome` 将手机恢复为设置首页，并验证没有未决动作。题目与通过条件见 [冻结协议](../artifacts/mobile/protocol.md)。每个正式试验使用新 ID 和新报告路径；已有报告路径会在连接设备前拒绝。

```sh
node dist/bench/mobile/run.js \
  --config /PRIVATE/host-config.json \
  --task M3 --trial M3-jev-r1 --mode jev \
  --key-file /PRIVATE/api-key \
  --approval-file /PRIVATE/approval.json \
  --budget-dir /PRIVATE/budget \
  --output /PRIVATE/results/M3-jev-r1.json
```

`--mode teacher-plan --plan /PRIVATE/plan.json` 可运行由宿主提供的固定动作 ID 列表。该模式不使用 Jev，结果标为 `host-plan-smoke-not-jev`，不可当作模型对照成绩。Jev 模式也会单独统计无需模型判断的确定步骤。

成功要求独立页面后验成立；工具返回点击成功并不等于任务成功。`result.elapsedMs` 是从已核验起点开始的工作流耗时；`elapsed_ms` 另含复位预检，均不含 SDK 建连。报告保留执行器分类、每次模型调用用量、每次工具耗时和失败原因。

如遇 `UNKNOWN`，停止新输入，保留持久账本，由可信宿主独立读取设备状态并核对原操作。不得删除记录、换试验 ID 或自动再次点击。真实模式没有配置 teacher 时，需接管会返回 `TEACHER_UNAVAILABLE`，不能记作成功。

## 汇总与边界

```sh
node scripts/mobile-summary.mjs
```

汇总读取 `artifacts/mobile/baseline`、`jev-v1`、`jev-v2` 的既有记录，不访问设备或网络。失败保留在成功率分母；速度只比较双方均成功的配对，并单列配对数量。复位、诊断和无模型 smoke 单列。

模型只收到固定题目、公开动作 ID 和谓词。设备标识、通知、网络名称、应用清单、实际控件引用与坐标留在本机。不得向报告复制完整 UI。当前不支持发送消息、支付、删除、权限修改、任意输入或任意第三方应用；M5 仅验证浏览器原生工具栏标题，不代表已测试网页正文操作。
