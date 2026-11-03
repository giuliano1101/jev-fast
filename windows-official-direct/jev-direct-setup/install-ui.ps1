$ErrorActionPreference='Stop'
$source='G:\Codex\Jev control\jev-direct-setup'
$runtime='C:\Users\Admin\.codex\jev-direct'
$skill='C:\Users\Admin\.codex\skills\jev-ui'
New-Item -ItemType Directory -Path $skill -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'ui.mjs') -Destination (Join-Path $runtime 'ui.mjs') -Force
Copy-Item -LiteralPath (Join-Path $source 'SKILL.ui.md') -Destination (Join-Path $skill 'SKILL.md') -Force
$rules='C:\Users\Admin\.codex\AGENTS.md'
$current=Get-Content -LiteralPath $rules -Raw
if($current -notmatch 'JEV_UI_EXECUTOR_V1'){
 Copy-Item -LiteralPath $rules -Destination (Join-Path $runtime 'AGENTS.before-ui-20261104.md') -Force
 $addition=@'

<!-- JEV_UI_EXECUTOR_V1 -->
- 网页及 Windows App 的适用操作，默认读取 `C:/Users/Admin/.codex/skills/jev-ui/SKILL.md`，优先让 Jev 通过官方 API 选择当前真实控件，再由本机固定执行器执行与核验；失败、不可用、无匹配或结果不确定时由 Codex 接手。
- 全局界面入口为 `C:/Users/Admin/.codex/jev-direct/ui.mjs`：`status` 检查；`start RUN.json` 启动；`desktop RUN_DIR PLAN.json` / `chrome RUN_DIR PLAN.json` 执行。内置浏览器走该 skill 的 CUA 适配器；保留两条网页路径，分别记录性能。
- 当前桌面验收为控件点击、固定文本填写/提交、结果读取及截图。OCR 与 Jev 图片定位用于识别辅助；自动坐标点击尚未激活。未知结果必须先核验，不自动重放。继续遵守有效收费授权及累计预算，不恢复 Jev MCP。
'@
 Set-Content -LiteralPath $rules -Value ($current.TrimEnd()+"`n"+$addition) -Encoding utf8
}
@{installed_at=(Get-Date).ToUniversalTime().ToString('o');entry=(Join-Path $runtime 'ui.mjs');skill=(Join-Path $skill 'SKILL.md');rules=$rules;workspace='G:\Codex\Jev control';mcp=$false}|ConvertTo-Json|Set-Content (Join-Path $runtime 'ui-install.json') -Encoding utf8
Write-Output 'Global Jev UI entry and agent rules installed.'
