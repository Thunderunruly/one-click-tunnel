<#
  临时公网映射 卸载脚本（只清理当前用户目录 + HKCU，不需要管理员）
#>
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'public-tunnel'),
  [switch]$Quiet
)
$ErrorActionPreference = 'Continue'
function Say($msg) { if (-not $Quiet) { Write-Host $msg } }
Say '正在卸载 临时公网映射...'

$procs = Get-Process -Name 'public-tunnel' -ErrorAction SilentlyContinue
foreach ($p in $procs) { try { $p | Stop-Process -Force } catch {} }
Start-Sleep -Milliseconds 500

$pidFiles = @()
if (Test-Path $InstallDir) { $pidFiles = Get-ChildItem -Path $InstallDir -Filter '.tunnel-*.pid' -Force -ErrorAction SilentlyContinue }
foreach ($f in $pidFiles) {
  $procId = 0
  try { $procId = [int](Get-Content $f.FullName -ErrorAction Stop | Select-Object -First 1) } catch {}
  if ($procId -gt 0) {
    $img = ''
    try { $img = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    if ($img -eq 'cloudflared' -or $img -eq 'public-tunnel' -or $img -eq 'node') {
      Say ('  结束残留进程 ' + $img + ' pid=' + $procId)
      & taskkill /PID $procId /T /F 2>$null | Out-Null
    }
  }
}

foreach ($t in @(
  (Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') '临时公网映射.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) '临时公网映射.lnk')
)) {
  if (Test-Path $t) { Remove-Item $t -Force; Say ('  已删除快捷方式 ' + $t) }
}

$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PublicTunnel'
if (Test-Path $regKey) { Remove-Item $regKey -Recurse -Force; Say '  已移除注册表卸载项' }

if (Test-Path $InstallDir) {
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { Say ('  注意: ' + $InstallDir + ' 仍有文件被占用，请关闭窗口后手动删除') }
  else { Say ('  已删除 ' + $InstallDir) }
}
Say '卸载完成。'
