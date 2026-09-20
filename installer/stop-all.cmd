@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 临时公网映射 - 全部关闭
echo 正在关闭所有通道与后台守护进程...
"%~dp0public-tunnel.exe" stop --all
"%~dp0public-tunnel.exe" daemon stop
echo.
echo 已全部关闭（对应的公网地址会变成 Cloudflare 530）。
pause
