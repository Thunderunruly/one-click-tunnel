@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 临时公网映射
echo 正在启动图形化配置页（后台守护进程 + 托盘图标）...
"%~dp0public-tunnel.exe" gui --open %*
echo.
echo ---- 已退出 ----
pause
