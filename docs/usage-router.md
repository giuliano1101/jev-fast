# Usage router：调用 Jev 前的本地预检 / 重试闸门

更新：2026-11-02。适用于本仓库 jev-fast 及其公网 Streamable HTTP MCP `https://jev.43-160-233-161.sslip.io/mcp`。

> **不是 TypeSafe。** 本路由器只借鉴“先判断这一步该不该做”的思路，没有集成 TypeSafe、`typesafe-sdk` 或 `TYPESAFE_API_KEY`，也不调用任何托管服务。本文的 “Jev” 指本仓库的 jev-fast 服务；其他同名产品与此无关。

## 它是什么、不是什么

`scripts/usage-router.mjs` 是**调用方 AI 本地运行**的单文件 Node 脚本（零依赖，Node 18+ 即可；不需要 `npm ci`、build 或网络）。在花费真实 Jev 调用前，它根据几项简短状态返回唯一一个动作：

| action | 含义 | 调用方应做 |
| --- | --- | --- |
| `proceed` | 继续计划中的 MCP 步骤 | 照常调用 browser_* / host_act |
| `reuse_cache` | 已有新鲜产物或最近 observe 可用 | 读已有结果，不再打开/观察 |
| `stop_retry` | 同一做法以同一方式失败，或结果 UNKNOWN | 停止，保留 request_id/idempotency_key，报告 |
| `research_capped` | 观察/资料已够 | 用现有材料写结论，不再开新 observe/子任务 |
| `ask_human` | 需要发送/发布/上传/付款/删除，或遇登录墙/扫码/验证码/OS 权限 | 暂停，向人说明并等待 |

另返回 `confidence`（0–1）和可选 `reason`。它是 agent 的预检门，**不替代** `jev.choose_action` 的签名选择，不改变任何 MCP 契约，不访问服务端，也不能授权手册原本禁止的事。

## 调用点

1. **每次 `jev.browser_open` 之前**（`--task-type browser_open`）。有上次的结果/截图路径时带 `--artifact-path`。
2. **重试同一个失败的 browser_act / host_act 之前**（`--task-type retry`），带 `--last-error`、`--previous-error`、`--repeats`。
3. **第二次及以后的 observe 或额外调研/开子任务之前**（`--task-type browser_observe` 或 `research`），带 `--observes` 与 `--observed-at`。
4. 观察到疑似登录墙时，可把页面标题/短文本放进 `--observation`。

```sh
R="node /path/to/jev-fast/scripts/usage-router.mjs"     # 或在仓库内: npm run -s usage-router --
gate=$($R --task-type browser_open --goal "核验 example.com 标题" --artifact-path out/example.json)
case "$(echo "$gate" | node -pe 'JSON.parse(require("fs").readFileSync(0)).effective_action')" in
  proceed) ;;  # 调用 jev.browser_open
  *) echo "$gate"; exit 0 ;;  # reuse_cache / stop_retry / research_capped / ask_human：按上表处理
esac
```

宿主用 Node SDK 时直接导入（脚本可整体复制到宿主目录）：

```js
import {route,loadConfig} from './usage-router.mjs';
const gate=await route({goal:'核验 example.com 标题',task_type:'browser_open'},await loadConfig());
if(gate.effective_action!=='proceed')return gate; // 交给上表处理；ask_human 必须停下问人
```

**永远按 `effective_action` 分支，而不是 `action`。** shadow 下 `effective_action` 恒为 `proceed`，所以切换到 active 时调用方代码无需修改。没有 shell/Node 的纯 MCP 宿主无法运行脚本，可按上表同样的规则人工判断，但不会产生日志。

## 输入

| 参数（CLI / JSON 字段） | 说明 |
| --- | --- |
| `--task-type` / `task_type` | 必填：`browser_open`、`browser_act`、`host_act`、`retry`、`browser_observe`、`research` 等 |
| `--goal` / `goal` | 必填：这一步要达成什么 |
| `--last-error` / `last_error` | 上次错误码或文本，如 `LOGIN_BLOCKER`、`STALE_SNAPSHOT`、`HOST_ACTION_UNKNOWN` |
| `--previous-error` / `previous_error` | 再上一次的错误文本；与 last_error 归一化后相同即 `stop_retry` |
| `--repeats` / `repeats` | 同一做法已失败次数 |
| `--observes` / `observes` | 本问题已做的 observe/资料数 |
| `--artifact-path` / `artifact_path` | 已有结果/截图/报告路径；存在且未超过 `cache_max_age_s` 即 `reuse_cache` |
| `--observed-at` / `observed_at` | 上次 observe 的 ISO 时间；对观察/调研类步骤新鲜即 `reuse_cache` |
| `--observation` / `observation` | 最新观察的标题/短文本，用于识别“扫码登录 / 请先登录 / log in to continue / captcha” |
| `--notes` / `notes` | 备注；含 kill-switch 短语时绕过执行 |

也可 `--state '{"goal":"...","task_type":"..."}'` 一次传 JSON。未知字段直接拒绝（退出码 2），防止把 `continuation_token`、Cookie 或凭据写进日志。退出码 2 表示参数有误，修正参数即可；它不代表可以跳过手册规则。

## 规则（按优先级，首条命中即返回）

1. `ask_human`：错误含 `LOGIN_BLOCKER`/`LOGIN_WALL`/`LOGIN_REQUIRED`/`CAPTCHA`/`QR_REQUIRED`/权限拒绝；观察文本是明确的登录墙（创作者中心“扫码登录”“请先登录”等，普通页眉“登录”链接不算）；目标涉及登录、密码、验证码、二维码；或目标涉及发送、发布、上传、付款、购买、删除、转账、禁发（“已发布/未发布”筛选不算）。**ask_human 优先于其他所有规则。**
2. `stop_retry`：任何 UNKNOWN（`execution: unknown`、`DECISION_UNKNOWN`、`HOST_ACTION_UNKNOWN`）；`CONTINUATION_INVALID`、`ADMISSION_REQUIRED`、`REQUEST_NOT_FOUND` 等重复调用不会修好的错误；last_error 与 previous_error 文本相同（数字/UUID 归一化）；或 `repeats >= max_repeats`。
3. `reuse_cache`：无错误，且 `artifact_path` 存在并新鲜；或观察类步骤的 `observed_at` 新鲜。
4. `research_capped`：观察/调研类步骤且 `observes >= research_cap`。
5. 其余 `proceed`；有错误时置信度降低并提示先重新 observe 或改变做法。

## 配置与模式

`config/usage-router.json`（可用 `--config` 或 `JEV_USAGE_ROUTER_CONFIG` 指定其他文件；文件缺失时使用同样的默认值）：

```json
{"enabled": true, "mode": "shadow", "max_repeats": 2, "research_cap": 3, "cache_max_age_s": 900, "log_path": "artifacts/usage-router/decisions.jsonl"}
```

- **shadow（默认，第一周）**：照常计算并写日志，`effective_action` 恒为 `proceed`、`enforced:false`，不改变调用方行为。shadow 不放宽手册原有规则：发布/付款前仍须问人，UNKNOWN 仍须停止。
- **active**：把 `"mode"` 改成 `"active"` 即生效，这是唯一需要的改动。调用方必须执行 `effective_action`，尤其不得覆盖 `ask_human`。
- 建议流程：shadow 一周 → 按下文读日志，统计误判（例如把只读页面判成 ask_human）→ 调整阈值或提交规则修正 → 切 active。

## Kill switch

任一项即关闭执行，`effective_action` 回到 `proceed`：

- 配置 `"enabled": false`（不再写日志）；
- 环境变量 `JEV_USAGE_ROUTER=off`（也接受 `0/false/disabled`；不写日志）；
- 人在对话中说 **`bypass jev router`** 或 **`bypass usage router`**：agent 把这句原样放进 `--notes`，本次结果 `bypassed:true`，仍写日志以便复盘。该短语只能来自人，AI 不能自行添加。

关闭路由器只是去掉这道额外闸门；手册中的问人、UNKNOWN 不重放、禁发等规则照旧有效。

## 日志

`artifacts/usage-router/decisions.jsonl` 只追加、每行一个 JSON（`ts`、`input`、`action`、`confidence`、`reason`、`effective_action`、`enforced`、`enabled`、`mode`、`bypassed`），文件权限 0600，已被 `.gitignore` 排除；格式样例见 `artifacts/usage-router/decisions.example.jsonl`。在仓库内运行时相对 `log_path` 以仓库根为基准；脚本被单独复制到宿主目录时以当前工作目录为基准。写日志失败不会中断判断，结果中 `logged:false` 并带 `log_error`。

```sh
tail -n 20 artifacts/usage-router/decisions.jsonl
node -e 'const c={};for(const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")){const a=JSON.parse(l).action;c[a]=(c[a]??0)+1}console.log(c)' artifacts/usage-router/decisions.jsonl
```

`goal`/`observation` 会进入本地日志：不要放账号内容、token、手机号或原始截图文字；日志不进 Git 或公开报告。

## 验证范围

`tests/unit/usage-router.test.ts` 离线覆盖五个动作、ask_human 优先级、shadow/active/三种 kill switch、日志追加与 CLI 退出码；不连接公网 MCP、不启动浏览器。规则是启发式关键词判断，不保证识别所有登录墙或不可逆操作；漏判时手册原规则仍是最终约束。
