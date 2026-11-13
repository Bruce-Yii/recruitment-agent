# 一条命令里完成：起 0.2.2 服务 → 浏览器验证 → 收工杀进程
$ErrorActionPreference = 'Continue'
$log = 'D:\12412\dsh工作区\projects\recruitment-agent\work\scratch\web-boot-022c.log'
Remove-Item -Force $log, "$log.err" -ErrorAction SilentlyContinue
$env:DSH_HOME = 'D:\12412\dsh-home-recruitment'
$env:RECRUITMENT_DB_PASSWORD = '123456'

# 旧会话会把模型选择钉在旧 provider 上（no adapter registered for "opencode-go-openai-key2"）。
# 这里把**产品 home** 的会话清空（只动 D:\12412\dsh-home-recruitment，不碰桌面 home），
# 让新会话用 profile 里的新默认模型。
Get-ChildItem "$env:DSH_HOME\sessions" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$wsFile = "$env:DSH_HOME\storages\workspace.json"
if (Test-Path $wsFile) {
  $ws = Get-Content $wsFile -Raw | ConvertFrom-Json
  foreach ($p in $ws.tables.workspaces.PSObject.Properties) { $p.Value.sessionIds = @() }
  $ws | ConvertTo-Json -Depth 10 | Set-Content $wsFile -Encoding utf8
}
Write-Output 'SESSIONS_CLEARED'
$proc = Start-Process -FilePath 'D:\12412\recruitment-runtime\node_modules\.bin\dsh.cmd' `
  -ArgumentList @('--profile', 'recruitment', '--no-open', '--port', '49303') `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
Write-Output "SERVER_PID=$($proc.Id)"

$url = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Test-Path $log) {
    $line = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($line -match 'http://127\.0\.0\.1:49303/\?token=\S+') { $url = $Matches[0]; break }
  }
}
Write-Output "URL=$url"
if (-not $url) {
  Write-Output '=== LOG ==='; Get-Content $log -Raw -ErrorAction SilentlyContinue
  Write-Output '=== ERR ==='; Get-Content "$log.err" -Raw -ErrorAction SilentlyContinue
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

Push-Location 'D:\12412\dsh工作区\projects\recruitment-agent\work\scratch'
node verify-022.mjs $url 'v022'
$code = $LASTEXITCODE
Pop-Location
Write-Output "VERIFY_EXIT=$code"
Write-Output '=== SERVER ERR (model/provider) ==='
Get-Content "$log.err" -Raw -ErrorAction SilentlyContinue | Select-Object -First 8
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
# .cmd 包装进程死了不等于 node 子进程死了：按端口找真正的监听进程再杀
$conns = Get-NetTCPConnection -LocalPort 49303 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
Write-Output "PORT_AFTER_KILL=$((Test-NetConnection -ComputerName 127.0.0.1 -Port 49303 -InformationLevel Quiet -WarningAction SilentlyContinue))"
exit $code
