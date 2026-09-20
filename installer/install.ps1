<#
  临时公网映射（public-tunnel）一键安装脚本（免管理员：只写当前用户目录 + HKCU）
  用法：install.cmd            → 默认装到 %LOCALAPPDATA%\public-tunnel
        install.cmd -InstallDir D:\tools\public-tunnel -NoShortcut
#>
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'public-tunnel'),
  [string]$ShortcutDir = '',
  [switch]$NoShortcut,
  [switch]$NoLaunch,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$exeName = 'public-tunnel.exe'
$srcExe = Join-Path $src $exeName

function Say($msg) { if (-not $Quiet) { Write-Host $msg } }

Say ''
Say '=========================================='
Say '  临时公网映射 安装程序（免管理员）'
Say '=========================================='
Say ''

if (-not (Test-Path $srcExe)) {
  Write-Host ('找不到 ' + $srcExe) -ForegroundColor Red
  Write-Host '请确认安装包解压完整（public-tunnel.exe 与 install.cmd 在同一目录）' -ForegroundColor Red
  exit 1
}

Say ('安装目录: ' + $InstallDir)
if (Test-Path $InstallDir) {
  $old = Get-Process -Name 'public-tunnel' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($InstallDir + '*') }
  if ($old) { Say '检测到旧实例正在运行，先关闭...'; $old | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

foreach ($f in @($exeName, 'cloudflared.exe', 'start.cmd', 'tray.cmd', 'stop-all.cmd', 'stop.cmd', 'README.md')) {
  $s = Join-Path $src $f
  if (Test-Path $s) { Copy-Item $s (Join-Path $InstallDir $f) -Force; Say ('  已安装 ' + $f) }
}
$uninstallPath = Join-Path $InstallDir 'uninstall.cmd'
Copy-Item (Join-Path $src 'uninstall.cmd') $uninstallPath -Force
Copy-Item (Join-Path $src 'uninstall.ps1') (Join-Path $InstallDir 'uninstall.ps1') -Force

if (-not $NoShortcut) {
  $ws = New-Object -ComObject WScript.Shell
  $targets = @()
  if ([string]::IsNullOrEmpty($ShortcutDir)) {
    $targets += (Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') '临时公网映射.lnk')
    $targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) '临时公网映射.lnk')
  } else {
    New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
    $targets += (Join-Path $ShortcutDir '临时公网映射.lnk')
  }
  foreach ($t in $targets) {
    try {
      $lnk = $ws.CreateShortcut($t)
      $lnk.TargetPath = Join-Path $InstallDir 'start.cmd'
      $lnk.WorkingDirectory = $InstallDir
      $lnk.IconLocation = ($srcExe + ',0')
      $lnk.Description = '临时把本机端口映射到公网（带密码门 + 定时自动关闭）'
      $lnk.Save()
      Say ('  已创建快捷方式 ' + $t)
    } catch { Write-Host ('  快捷方式创建失败: ' + $_.Exception.Message) -ForegroundColor Yellow }
  }
}

$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PublicTunnel'
New-Item -Path $regKey -Force | Out-Null
$sz = 0
foreach ($f in @($exeName, 'cloudflared.exe')) { $p = Join-Path $InstallDir $f; if (Test-Path $p) { $sz += [int]((Get-Item $p).Length / 1KB) } }
Set-ItemProperty -Path $regKey -Name 'DisplayName' -Value '临时公网映射 (public-tunnel)'
Set-ItemProperty -Path $regKey -Name 'DisplayVersion' -Value '1.0.0'
Set-ItemProperty -Path $regKey -Name 'Publisher' -Value 'fafa-local'
Set-ItemProperty -Path $regKey -Name 'InstallLocation' -Value $InstallDir
Set-ItemProperty -Path $regKey -Name 'DisplayIcon' -Value $srcExe
Set-ItemProperty -Path $regKey -Name 'UninstallString' -Value ('"' + $uninstallPath + '"')
Set-ItemProperty -Path $regKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $regKey -Name 'NoRepair' -Value 1 -Type DWord
Set-ItemProperty -Path $regKey -Name 'EstimatedSize' -Value $sz -Type DWord
Say '  已注册到「设置 → 应用」卸载列表'

Say ''
Say '安装完成。'
Say ('  启动: 双击桌面「临时公网映射」，或运行 ' + (Join-Path $InstallDir 'start.cmd'))
Say '  默认: 把 127.0.0.1:5777 映射出去，1 小时后自动关闭，密码随机生成并显示在窗口里'
Say ('  卸载: ' + $uninstallPath + '   或「设置 → 应用」里卸载')
Say ''

if (-not $NoLaunch) {
  Say '正在启动...'
  Start-Process -FilePath (Join-Path $InstallDir 'start.cmd') -WorkingDirectory $InstallDir
}
