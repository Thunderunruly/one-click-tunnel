
param([string]$Match = '', [switch]$Kill)
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $Match + '*') -and $_.ProcessId -ne $PID })
$n = $procs.Count
if ($Kill) { foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force } catch {} } ; Start-Sleep -Milliseconds 800 }
Write-Output ('COUNT=' + $n)
exit 0
