@echo off
chcp 65001 >nul
cd /d %~dp0
setlocal enabledelayedexpansion
set GW=%~1
echo 正在关闭公网隧道...
if not "%GW%"=="" (
  call :killone %GW%
) else (
  for %%F in (.tunnel-*.node.pid) do (
    set NAME=%%~nF
    set GWX=!NAME:.tunnel-=!
    set GWX=!GWX:.node=!
    call :killone !GWX!
  )
)
if exist .cloudflared.pid (
  set /p OLDPID=<.cloudflared.pid
  taskkill /PID !OLDPID! /T /F >nul 2>&1
  del /q .cloudflared.pid >nul 2>&1
)
echo 已关闭（对应公网地址会变成 Cloudflare 530）。
pause
exit /b 0

:killone
set G=%1
if exist .tunnel-%G%.cloudflared.pid (
  set /p CFPID=<.tunnel-%G%.cloudflared.pid
  taskkill /PID !CFPID! /T /F >nul 2>&1
  del /q .tunnel-%G%.cloudflared.pid >nul 2>&1
)
if exist .tunnel-%G%.node.pid (
  set /p NPID=<.tunnel-%G%.node.pid
  taskkill /PID !NPID! /T /F >nul 2>&1
  del /q .tunnel-%G%.node.pid >nul 2>&1
)
echo   已关闭网关端口 %G% 的隧道
exit /b 0
