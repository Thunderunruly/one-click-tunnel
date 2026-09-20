@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 一键隧道
echo 注意：这是命令行模式（前台跑一条隧道，关窗口=停）。
echo       要图形界面（桌面窗口 + 托盘）请双击同目录的 one-click-tunnel.exe
echo.
echo 正在启动图形化配置页（后台守护进程 + 托盘图标）...
"%~dp0oct.exe" gui --open %*
echo.
echo ---- 已退出 ----
pause
