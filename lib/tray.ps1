<#
  临时公网映射 托盘图标（Windows 自带 WinForms，无第三方依赖）
  由 tunnel tray 调用：powershell -File tray.ps1 -GuiPort 18400 -Token xxx
#>
param(
  [int]$GuiPort = 18400,
  [string]$Token = '',
  [string]$ConfigFile = '',
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$base = 'http://127.0.0.1:' + $GuiPort
$headers = @{ 'x-tunnel-token' = $Token }
$guiUrl = $base + '/?token=' + $Token

function Get-State {
  try { return Invoke-RestMethod -Uri ($base + '/api/state') -Headers $headers -TimeoutSec 4 } catch { return $null }
}
function Post-Action($action, $id) {
  $body = @{ action = $action }
  if ($id) { $body.id = $id }
  try {
    Invoke-RestMethod -Uri ($base + '/api/action') -Method Post -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json) -TimeoutSec 120 | Out-Null
    return $true
  } catch { return $false }
}

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Text = '临时公网映射'
$icon = $null
try {
  $exe = Join-Path (Split-Path -Parent $PSScriptRoot) 'public-tunnel.exe'
  if (Test-Path $exe) { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe) }
} catch {}
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }
$script:notify.Icon = $icon
$script:notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('打开配置页')
$miStartAll = $menu.Items.Add('全部启动')
$miStopAll = $menu.Items.Add('全部停止')
$menu.Items.Add('-') | Out-Null
$miStatus = $menu.Items.Add('查看状态')
$menu.Items.Add('-') | Out-Null
$miQuit = $menu.Items.Add('退出（关闭所有通道）')
$miQuitTray = $menu.Items.Add('只关托盘（通道继续跑）')

$script:balloon = {
  param($title, $text)
  try { $script:notify.ShowBalloonTip(4000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
}

$miOpen.add_Click({ try { Start-Process $guiUrl } catch {} })
$miStartAll.add_Click({ $ok = Post-Action 'startAll' $null; & $script:balloon '临时公网映射' ($(if ($ok) { '已启动所有启用的通道' } else { '启动失败，请打开配置页查看' })) })
$miStopAll.add_Click({ $ok = Post-Action 'stopAll' $null; & $script:balloon '临时公网映射' ($(if ($ok) { '已停止所有通道' } else { '停止失败' })) })
$miStatus.add_Click({
  $st = Get-State
  if (-not $st) { & $script:balloon '临时公网映射' '守护进程没有响应'; return }
  $run = @($st.profiles | Where-Object { $_.running })
  $lines = @()
  foreach ($p in $run) { $lines += ($p.name + ': ' + $p.url) }
  $text = $(if ($lines.Count -gt 0) { $lines -join [Environment]::NewLine } else { '当前没有运行中的通道' })
  & $script:balloon ('运行中 ' + $run.Count + ' / 共 ' + @($st.profiles).Count + ' 个通道') $text
})
$miQuitTray.add_Click({
  $script:notify.Visible = $false
  $script:notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$miQuit.add_Click({
  try { Invoke-RestMethod -Uri ($base + '/api/shutdown') -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 8 | Out-Null } catch {}
  Start-Sleep -Milliseconds 600
  $script:notify.Visible = $false
  $script:notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$script:notify.ContextMenuStrip = $menu
$script:notify.add_DoubleClick({ try { Start-Process $guiUrl } catch {} })
$script:notify.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { & $miStatus.PerformClick() }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if ($ParentPid -gt 0) {
    $alive = $null
    try { $alive = Get-Process -Id $ParentPid -ErrorAction Stop } catch { $alive = $null }
    if (-not $alive) {
      $script:notify.Visible = $false
      $script:notify.Dispose()
      [System.Windows.Forms.Application]::Exit()
      return
    }
  }
  $st = Get-State
  if (-not $st) { $script:notify.Text = '临时公网映射：守护进程未响应'; return }
  $run = @($st.profiles | Where-Object { $_.running })
  $tip = '临时公网映射：' + $run.Count + ' 个运行中 / 共 ' + @($st.profiles).Count + ' 个通道'
  if ($run.Count -eq 1 -and $run[0].url) { $tip += [Environment]::NewLine + $run[0].url }
  if ($tip.Length -gt 120) { $tip = $tip.Substring(0, 120) }
  $script:notify.Text = $tip
})
$timer.Start()

$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
$timer.Stop()
