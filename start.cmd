@echo off
chcp 65001 >nul
cd /d %~dp0
node tunnel.js %*
echo.
echo ---- 已退出 ----
pause
