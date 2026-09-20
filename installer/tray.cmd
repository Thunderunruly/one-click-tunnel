@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 临时公网映射 - 托盘
"%~dp0public-tunnel.exe" tray %*
echo.
echo ---- 托盘已退出（守护进程仍在后台，双击 stop-all.cmd 可全部关掉）----
pause
