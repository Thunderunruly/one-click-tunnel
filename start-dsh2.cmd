@echo off
cd /d %~dp0
node tunnel.js --port 3081 --ttl 6h --gateway 18081 --password dshK7m2q9 --upstream-host 127.0.0.1:3081 >> logs\dsh2.out.log 2>&1
