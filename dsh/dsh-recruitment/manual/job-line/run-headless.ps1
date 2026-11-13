<#
.SYNOPSIS
  跑一次真实 headless 的岗位线会话，并把 stdout/stderr 落到 evidence\<yyyyMMdd-HHmmss>\。

.DESCRIPTION
  为什么用 `--patch` 而不是改 profile：本 lane 不允许修改 profile 目录，也不允许改
  `src/index.ts`；岗位写工具通过 `manual/job-line/patch.yml` 以独立插件
  `recruitment-job-line` 叠加进 `rec-agent-test`。patch 内部的 `./plugin-entry.ts`
  由 dsh-app-boot 锚定成 file URL（按 patch 文件所在目录），所以这里始终传**绝对路径**。

  密码只从环境变量来：脚本设置 `$env:RECRUITMENT_DB_PASSWORD`（不写进任何文件）。
  证据目录里落：goal.txt / command.txt / dsh-stdout.txt / dsh-stderr.txt / exit-code.txt。

.PARAMETER Goal
  一句话目标（不写工具名，让 Agent 自己决定）。

.PARAMETER DumpConfig
  只跑 `--dump-config`（不花模型额度），用于证明 `recruitment-job-line` 条目可见。

.EXAMPLE
  pwsh -NoProfile -File manual\job-line\run-headless.ps1
  pwsh -NoProfile -File manual\job-line\run-headless.ps1 -Goal "建一个后端工程师岗位并读回状态"
  pwsh -NoProfile -File manual\job-line\run-headless.ps1 -DumpConfig
#>
[CmdletBinding()]
param(
  [string]$Goal = '为「后端工程师（演示）」建一个岗位，给出两条硬性标准，然后读回确认它现在的状态。',
  [string]$Profile = 'rec-agent-test',
  [switch]$DumpConfig
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$pluginRoot = Split-Path -Parent (Split-Path -Parent $here)   # dsh\dsh-recruitment
$patchFile = Join-Path $here 'patch.yml'
if (-not (Test-Path -LiteralPath $patchFile)) {
  throw "patch.yml not found: $patchFile"
}
$patchFile = (Resolve-Path -LiteralPath $patchFile).Path

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $here "evidence\$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 密码只从环境变量读；配置里只有变量名。这里显式设置是为了"可复跑"，不写盘。
$env:RECRUITMENT_DB_PASSWORD = '123456'

if ($DumpConfig) {
  $command = "dsh --profile $Profile --patch `"$patchFile`" --dump-config"
} else {
  $command = "dsh --profile $Profile --patch `"$patchFile`" `"$Goal`""
}

Set-Content -LiteralPath (Join-Path $outDir 'command.txt') -Value $command -Encoding utf8
Set-Content -LiteralPath (Join-Path $outDir 'goal.txt') -Value $Goal -Encoding utf8
Set-Content -LiteralPath (Join-Path $outDir 'cwd.txt') -Value $pluginRoot -Encoding utf8

$stdoutPath = Join-Path $outDir 'dsh-stdout.txt'
$stderrPath = Join-Path $outDir 'dsh-stderr.txt'
$started = Get-Date
Write-Host "[run-headless] $command"
Write-Host "[run-headless] cwd=$pluginRoot"
Write-Host "[run-headless] evidence=$outDir"

Push-Location $pluginRoot
try {
  if ($DumpConfig) {
    & dsh --profile $Profile --patch $patchFile --dump-config 1> $stdoutPath 2> $stderrPath
  } else {
    & dsh --profile $Profile --patch $patchFile $Goal 1> $stdoutPath 2> $stderrPath
  }
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

$elapsed = [int]((Get-Date) - $started).TotalSeconds
Set-Content -LiteralPath (Join-Path $outDir 'exit-code.txt') -Value "$code (elapsed ${elapsed}s)" -Encoding utf8
Write-Host "[run-headless] exit=$code elapsed=${elapsed}s"
Write-Host "[run-headless] stdout=$stdoutPath"
Write-Host "[run-headless] stderr=$stderrPath"

if (Test-Path -LiteralPath $stdoutPath) {
  Write-Host ''
  Write-Host '--- stdout (tail 40) ---'
  Get-Content -LiteralPath $stdoutPath -Tail 40 -Encoding utf8
}
if ((Test-Path -LiteralPath $stderrPath) -and (Get-Item -LiteralPath $stderrPath).Length -gt 0) {
  Write-Host ''
  Write-Host '--- stderr (tail 40) ---'
  Get-Content -LiteralPath $stderrPath -Tail 40 -Encoding utf8
}

# 会话日志不在 profile 里，而在 $DSH_HOME/sessions/<cwd-encoded>/session-*/；给下一步取证命令。
Write-Host ''
Write-Host '[run-headless] 会话日志：'
Write-Host "  D:\Python3.12.9\python.exe manual\job-line\extract-tool-trace.py --list"
exit $code
