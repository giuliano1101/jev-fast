# S7 真实网页与抖音交互测试

测试日期：2026-10-30（北京时间）。所有题目在真实网站或已安装抖音 App 中执行。测试浏览器为本机 Codex 内置浏览器，不是独立 Chrome。

## 测试题目

| 编号 | 难度 | 工具 | 题目 | 验收信号 |
|---|---|---|---|---|
| W1 | 简单 | Wikipedia | 从多语言首页打开英文 Wikipedia | 英文首页 URL /wiki/Main_Page |
| W2 | 中等 | Wikipedia | 将搜索语言设为英文，搜索 Kyoto，打开词条 | 英文 Kyoto 词条 URL /wiki/Kyoto |
| W3 | 复杂 | Calculator.net | 计算 2026-11-01 到 2026-11-15 的天数，并包含结束日期 | 日期匹配，结果为 15 calendar days |
| D1 | 简单 | 本机抖音 App | 在内容管理中打开作品合集 | 合集视图显示创建合集控件；不创建合集 |
| D2 | 中等 | 本机抖音 App | 将作品审核状态筛选为已发布 | 审核状态控件显示已发布 |
| D3 | 复杂 | 本机抖音 App | 筛选已发布的图文作品，并按最高播放排序 | 三个控件同时显示已发布、图文、最高播放；不验证后台排序实现 |

完整起点：[tasks.json](tasks.json)。原始逐次记录：[all-trials.json](all-trials.json)。机器可读统计：[summary.json](summary.json)。

## 逐题结果

单元格为 **成功次数/开始次数；成功耗时中位数（秒）**。失败耗时不算完成速度。

| 题目 | 普通 computer use | Jev 原基线（外层交接） | 仅集成循环对照 | Jev 第一版优化 | Jev 最终修复版 |
|---|---|---|---|---|---|
| W1 | 2/2；20.79 | 2/2；27.54 | 1/3；5.52 | 2/2；2.83 | 2/2；4.67 |
| W2 | 2/2；36.22 | 0/2；— | 0/1；— | 0/2；— | 0/2；— |
| W3 | 2/2；28.85 | 0/2；— | 0/1；— | 0/2；— | 2/2；8.24 |
| D1 | 2/2；8.56 | 2/2；18.07 | 1/1；2.46 | 2/2；2.12 | 2/2；2.29 |
| D2 | 2/2；12.23 | 2/2；35.87 | 1/1；3.55 | 1/2；3.88 | 2/2；3.62 |
| D3 | 2/2；56.95 | 0/2；— | 0/1；— | 0/2；— | 0/2；— |

## 总体结果与解释

- 普通 computer use：12/12 成功；成功任务耗时中位数 20.79 秒；全部开始任务耗时中位数 20.79 秒（后者包含失败停止，不能作为完成速度）。
- Jev 原基线（外层交接）：6/12 成功；成功任务耗时中位数 27.54 秒；全部开始任务耗时中位数 24.71 秒（后者包含失败停止，不能作为完成速度）。
- 仅集成循环对照：3/8 成功；成功任务耗时中位数 3.55 秒；全部开始任务耗时中位数 1.72 秒（后者包含失败停止，不能作为完成速度）。
- Jev 第一版优化：5/12 成功；成功任务耗时中位数 2.38 秒；全部开始任务耗时中位数 2.12 秒（后者包含失败停止，不能作为完成速度）。
- Jev 最终修复版：8/12 成功；成功任务耗时中位数 3.62 秒；全部开始任务耗时中位数 2.68 秒（后者包含失败停止，不能作为完成速度）。

最终修复版与普通 computer use 双方成功的 8 个同题同轮配对，耗时比中位数为 **3.72×**。这是完整工作流的条件比值，不是纯模型速度，也不含失败的完成时间。

## 失败与诊断

| 试次 | 结果 | 耗时（秒） | 原因 |
|---|---|---|---|
| W3-cua-r1 | BLOCKED | 83.85 | SITE_ANTIBOT_INTERSTITIAL |
| W2-jev-baseline-r1 | FAILED | 21.53 | LOW_CONFIDENCE |
| W2-jev-baseline-r2 | FAILED | 26.56 | LOW_CONFIDENCE |
| W3-jev-baseline-r1 | FAILED | 101.03 | LOW_CONFIDENCE |
| W3-jev-baseline-r2 | FAILED | 54.73 | LOW_CONFIDENCE |
| D3-jev-baseline-r1 | FAILED | 22.87 | LOW_CONFIDENCE |
| D3-jev-baseline-r2 | FAILED | 16.14 | LOW_CONFIDENCE |
| D2-jev-optimized-r2 | FAILED | 2.72 | LOW_CONFIDENCE |
| D3-jev-final-r1 | FAILED | 0.54 | LOW_CONFIDENCE |
| D3-jev-final-r2 | FAILED | 1.08 | LOW_CONFIDENCE |
| D3-jev-integrated-baseline-r1 | FAILED | 0.44 | LOW_CONFIDENCE |
| D3-jev-optimized-r1 | FAILED | 0.67 | LOW_CONFIDENCE |
| D3-jev-optimized-r2 | FAILED | 0.96 | LOW_CONFIDENCE |
| W1-jev-integrated-baseline-r1 | FAILED | 0.45 | DECISION_FAILED |
| W1-jev-integrated-baseline-r2 | FAILED | 0.28 | DECISION_FAILED |
| W2-jev-final-r1 | FAILED | 1.20 | LOW_CONFIDENCE |
| W2-jev-final-r2 | FAILED | 0.71 | LOW_CONFIDENCE |
| W2-jev-integrated-baseline-r1 | FAILED | 0.98 | LOW_CONFIDENCE |
| W2-jev-optimized-r1 | FAILED | 0.38 | LOW_CONFIDENCE |
| W2-jev-optimized-r2 | FAILED | 1.10 | LOW_CONFIDENCE |
| W3-jev-integrated-baseline-r1 | FAILED | 3.99 | DECISION_FAILED |
| W3-jev-optimized-r1 | FAILED | 6.11 | EXECUTION_UNCERTAIN |
| W3-jev-optimized-r2 | FAILED | 7.23 | EXECUTION_UNCERTAIN |

- 原 timeanddate 日期任务被反机器人页面阻挡，保留为单独的未配对失败，未绕过。随后全部三方使用 Calculator.net。
- 最初两次集成循环的本地子进程无法解析官方 API 域名（第二次因 REPL 函数仍绑定旧通道），记录为连接失败并停止；改由已授权的本地请求工作进程处理，仍使用同一预算与 CLI 决策逻辑。两次试次均不删除、不当作成功。
- 原 Jev 基线的六次低置信度选择没有被执行；未降低 0.90 门槛。集成原规则日期题还收到一次不符合概率校验的返回，记录 INVALID_PROBABILITIES 并停止。
- 第一版优化日期题两次停在隐藏复选框：DOM input 尺寸为 0，而 AX 中存在可操作控件。改为仅在新观察确认未选中时点击 AX 控件；保留两次 EXECUTION_UNCERTAIN，重新从干净状态测试。
- 最终版本再次完整运行六题各两轮，8/12 成功；搜索与复杂组合筛选共四次仍因低置信度停止，不能作为稳定的通用替代品。
- D3 普通首轮观察到排序期间筛选标签变空，并进行了恢复。可能是短暂加载，不能断言网站永久清空筛选；第二轮及优化按排序、审核状态、体裁顺序执行。
- 原普通 W3 首轮修正了结果文字验证（实际是 15 calendar days）；Jev W2 首轮修复了 REPL 起始时间变量，使用此前已输出的精确时间戳。这些额外耗时和注释均保留。

## 优化及适用范围

1. 对同一可见表单的准备动作进行合并：语言和关键词、日期字段和包含结束日；提交仍单独决策，每个字段操作前重新绑定，提交前验证全部条件。
2. 删除当前已经满足的无进展候选，给筛选任务明确当前阶段。状态来自当前界面，不累加历史点击。
3. 用受限循环减少外层代理和工具交接；单独记录“集成循环 + 原候选规则”的消融对照，不能把全部提速归因于 Jev 本身。
4. 本轮成功返回的 API 决策耗时中位数为 0.84 秒；10 次只有一个有效候选，属于受约束选择，不能证明通用推理能力。

## 费用

本轮已知 API 费用 **$0.00126567**，另有 2 次用量未知。连同 S6，累计已知费用 **$0.00431600**，另有 3 次用量未知。累计 175 次保守预留，预留总额 $1.75 / $3.00；预留额不是实际账单。Codex computer use 会话费用不可得，未计作免费。

## 实验限制

- 六道预先知道的题，普通和原基线各两轮，第一版优化两轮、最终修复版两轮；方法分批执行，非随机交错，存在学习、网络和缓存影响。消融每题主要一轮，连接失败保留额外试次。
- 原基线包含外层代理思考、CLI/CUA 交接和验证；集成循环消除了部分这类开销。时间从初次观察前到终态验证，重置不计时。
- 优化使用当前题目的模板和阶段提示；不能外推任意网站、任意电脑操作或未见任务。
- 抖音仅测创作者中心导航与筛选，验收是可见控件状态，不是后台数据排序审计。没有发布、删除、上传、发消息或修改账号设置。
- 原始账号数据未上传；只有公开控件 ID、固定测试值、脱敏决策与公开网页截图。

## 证据与复现

- [运行与隐私边界](../../docs/real-testing.md)
- [优化前发现与假设](optimization.md)
- [优化前源码哈希](baseline-manifest.json) / [第一版复测源码哈希](optimized-manifest.json) / [最终修复版哈希](final-manifest.json)
- [完整检查记录](verification/checks.json)
- [公开网站结果截图](screenshots/date-result.jpg)

## 离线验证

最终类型检查、代码规范、144 项单元/核心测试、29 项浏览器集成测试和 40 项安全测试全部通过（不同测试命令存在重叠，不相加为唯一测试数）。首次集成测试 28/29 的失败日志保留；修复既有测试对异步完成的断言竞争后，定向 2/2、全套 29/29 通过。执行核心未修改。
