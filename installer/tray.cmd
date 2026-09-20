@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 一键隧道 - 托盘
"%~dp0oct.exe" tray %*
echo.
echo ---- 托盘已退出（守护进程仍在后台，双击 stop-all.cmd 可全部关掉）----
pause
