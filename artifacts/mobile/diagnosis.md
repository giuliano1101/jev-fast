# S9 点击绑定诊断

正式 v1 共 12 次，M5-r1 和 M6-r2 在 `select_font` 后停留在搜索页，点击工具已返回成功，后验明确失败。执行器停止并请求 teacher；本轮未配置 teacher，因此计为失败。没有把点击回执当作任务成功，也没有重复点击。

补充宿主固定计划 M3 6 次均成功；这不是 Jev 成绩。随后使用原 v1 编译版本、同一真实 Jev 接口和授权预算，追加 M5 诊断。诊断额外记录公开目标的本地 ref/矩形，以及底层点击返回的实际坐标。它们与正式组分开，不用新增成功替换原失败。

源码调查发现，Mobile MCP `tapByRef` 调用 `mobilecli io tap @eN`，返回泛化的点击成功信息；mobilecli 上游 `resolveRefTapPoint` 会重新读取 UI，并用新的顺序编号解析旧 ref。因此最后观察与点击之间的结构变化可能改变 ref 指向。原正式记录未记录实际坐标，不能据此断言两次历史失败就是该原因。

来源：[Mobile MCP](https://github.com/mobile-next/mobile-mcp)、[mobilecli 点击实现](https://github.com/mobile-next/mobilecli/blob/main/commands/input.go)。本机锁定 Mobile MCP 1.0.8；其 mobilecli 二进制包含对应解析函数符号，构建 revision 为 `4123c6aa2c2fdb10e06f5e452285603429b5066a`。读取上游代码不等于已逐行核验该二进制源码。

v2 针对这个绑定风险：由本机语义匹配目标，要求两次观察的目标矩形一致，使用该矩形中心通过原 Mobile MCP 点击。模型不提供坐标。仍保留动作前重验、动作后页面验证、单次绑定、禁止未知动作重放。坐标绑定也不能消除最后观察之后的界面变化，必须保留失败停止与后验。

诊断中如果实际点击与目标中心一致、仍持续未跳转，原因可能在触摸命中或应用响应；不能归为 ref 错位。小样本复测成功不代表保证所有 Android 操作稳定，更不能写成“完美操作”。
