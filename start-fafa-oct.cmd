@echo off
cd /d %~dp0
node tunnel.js --port 5777 --ttl 12h --password fafaK7m2q9 --gateway 18082 --fixed-host >> logs\oct-fafa.out.log 2>&1
