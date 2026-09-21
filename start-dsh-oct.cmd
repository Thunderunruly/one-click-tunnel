@echo off
cd /d %~dp0
node tunnel.js --port 3081 --ttl 12h --password dshK7m2q9 --gateway 18081 --fixed-host >> logs\oct-dsh.out.log 2>&1
