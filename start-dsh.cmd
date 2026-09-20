@echo off
cd /d %~dp0
node tunnel.js --port 3081 --ttl 4h --gateway 18081 --password OzM-9fcxwc >> logs\dsh-public.out.log 2>&1
