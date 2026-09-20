
param([string]$Match = 'tray.ps1', [switch]$Kill)
# 注意：本脚本自己的命令行里也有 -Match tray.ps1，必须把自身和同类计数脚本排除掉
$procs = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and
  $_.CommandLine -like ('*' + $Match + '*') -and $_.CommandLine -notlike '*ps-tray-count*'
})
$n = $procs.Count
if ($Kill) { foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force } catch {} } ; Start-Sleep -Milliseconds 800 }
Write-Output ('COUNT=' + $n)
exit 0
