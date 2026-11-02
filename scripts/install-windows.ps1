param(
    [string]$NodePath = '',
    [string]$Runtime = '',
    [string[]]$AllowedFileRoots = @(),
    [switch]$RegisterCodex
)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $NodePath) { $NodePath=(Get-Command node.exe -ErrorAction Stop).Source }
$NodePath=[IO.Path]::GetFullPath($NodePath)
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist/src/windows/main.js'))) { throw '先在仓库运行 npm ci --ignore-scripts 和 npm run build。' }
if (-not $Runtime) { $Runtime=Join-Path $repoRoot '.runtime/windows' }
$Runtime=[IO.Path]::GetFullPath($Runtime)
$configFolder=Join-Path $repoRoot '.runtime/windows-install'
$aclModule=Join-Path $repoRoot 'dist/src/service/private-directory.js'
& $NodePath --input-type=module -e 'import {pathToFileURL} from "node:url";const acl=await import(pathToFileURL(process.argv[1]).href);acl.preparePrivateDirectory(process.argv[2]);' $aclModule $configFolder
if ($LASTEXITCODE -ne 0) { throw '安装目录无法通过私密权限校验；未写入配置。' }
$configPath=Join-Path $configFolder 'windows.json'
if (Test-Path -LiteralPath $configPath) { throw '已有 Windows 安装配置；请检查原配置，不自动覆盖。' }
$config=@{endpoint='https://jev.43-160-233-161.sslip.io/mcp';runtime=$Runtime;allowedFileRoots=@($AllowedFileRoots | ForEach-Object {[IO.Path]::GetFullPath($_)});browser=@{headless=$false};panels=@()}
$utf8=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 8),$utf8)
$entry=Join-Path $repoRoot 'dist/src/windows/main.js'
function TomlString([string]$value) { if ($value.Contains("'")) { throw '路径含单引号；请用 Codex MCP 设置手动登记。' }; return "'"+$value+"'" }
$block="[mcp_servers.jev_windows]`ncommand = $(TomlString $NodePath)`nargs = [$(TomlString $entry), '--config', $(TomlString $configPath)]`nstartup_timeout_sec = 30`ntool_timeout_sec = 180`n"
$preview=Join-Path $configFolder 'codex-mcp.toml'
[IO.File]::WriteAllText($preview,$block,$utf8)
if ($RegisterCodex) {
    $codexFolder=Join-Path $env:USERPROFILE '.codex'
    $codexConfig=Join-Path $codexFolder 'config.toml'
    if (-not (Test-Path -LiteralPath $codexConfig)) { throw '未找到现有 Codex 配置；不创建替代配置。' }
    $existing=[IO.File]::ReadAllText($codexConfig)
    if ($existing -match '(?m)^\[mcp_servers\.jev_windows(?:\]|\.)') { throw 'Codex 已配置 jev_windows；请检查原条目，不自动覆盖。' }
    $backup=$codexConfig+'.before-jev-windows-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
    [IO.File]::Copy($codexConfig,$backup,$false)
    [IO.File]::WriteAllText($codexConfig,$existing.TrimEnd()+"`n`n"+$block,$utf8)
}
@{config=$configPath;mcp_preview=$preview;registered=[bool]$RegisterCodex;note='重载 MCP 或新开聊天后核对实际工具；此安装不改 Jev 管理开关、Key、计费或原 jev 连接。'} | ConvertTo-Json -Compress
