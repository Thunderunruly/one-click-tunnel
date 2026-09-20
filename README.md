# one-click-tunnel

[![CI](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/ci.yml)
[![Release](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/release.yml/badge.svg)](https://github.com/Thunderunruly/one-click-tunnel/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-blue.svg)](#)

[中文文档](README.zh-CN.md) · [更新日志](CHANGELOG.md)

One-click temporary public tunnels for Windows, built on Cloudflare Quick Tunnels — with a password gate in front of
your service, a local config page, a system tray icon, a CLI **and** an MCP server (so an AI agent can manage tunnels too).
No admin rights, no dependencies, single-file executable.

## Install

From the [latest release](https://github.com/Thunderunruly/one-click-tunnel/releases):

| Download | What it is |
| --- | --- |
| one-click-tunnel-setup-<version>.exe | One-click installer (per-user, no admin). Adds Start Menu / Desktop shortcuts and an uninstall entry. |
| one-click-tunnel-<version>-win-x64.zip | Portable bundle: unpack and double-click install.cmd |

Verify your download against SHA256SUMS.txt in the release assets.

## What it does

- Publishes a local port to a temporary https://xxxx.trycloudflare.com URL that **requires a password**
- The password gate binds to 127.0.0.1 only, so public traffic must come through the tunnel
- Everything auto-closes when the TTL expires (per tunnel)
- Run **many tunnels at once**, each with its own local port, gateway port, password and expiry time
- Manage them from the config page, the tray icon, the CLI, or let an AI agent do it over MCP

## Four ways to start / manage tunnels

    # 1. graphical config page + tray (recommended)
    public-tunnel.exe gui --open

    # 2. tray only (background daemon is started automatically)
    public-tunnel.exe tray

    # 3. command line, many tunnels
    public-tunnel.exe add --name web --port 3000 --ttl 1h --auto-start
    public-tunnel.exe start web
    public-tunnel.exe list
    public-tunnel.exe stop --all

    # 4. MCP: let an AI host drive it
    public-tunnel.exe mcp

The classic single-tunnel flags still work exactly as before:

    public-tunnel.exe --port 3000 --ttl 1h --password mypassword

## Permanent address with your own domain (named tunnels)

Quick tunnels give you a random `*.trycloudflare.com` address that changes on every run. If you own a domain
managed by Cloudflare, you can give a tunnel a **permanent** address instead:

    public-tunnel.exe login                        # one browser authorization (pick the domain/zone)
    public-tunnel.exe domain web app.example.com   # creates the named tunnel + the DNS record
    public-tunnel.exe start web                    # now serving https://app.example.com, permanently

- `tunnel login` stores the origin certificate in `state/cloudflare/cert.pem` (once per account).
- `tunnel domain <id> <hostname>` creates the tunnel, copies its credentials into `state/cloudflare/` and
  points the hostname at it. It also writes `mode: named` and `ttl: forever` into the config, so the address
  never expires.
- The tunnel still terminates at the **password gate on 127.0.0.1**, so a permanent hostname is not an open door.
- `tunnel info [id]` shows mode, hostname, tunnel id and anything still missing.
- `--dry-run` prints the generated cloudflared config and command without starting anything.
- Config page: a Cloudflare login button, plus a per-tunnel quick/named switch and domain binding.
- AI hosts get the same through the MCP tools `cloudflare_login`, `set_custom_domain` and `cloudflare_status`.
- Requirements: the domain's DNS must be managed by Cloudflare (the free plan is enough).

Generated `state/cloudflare/<id>.cloudflared.yml`:

    tunnel: <tunnel-id>
    credentials-file: '<...>/<id>.credentials.json'
    no-autoupdate: true
    ingress:
      - hostname: app.example.com
        service: http://127.0.0.1:18080      # <- the local password gate, not your app port
      - service: http_status:404

## Where is the tray icon?

The tray is **not** part of the web page - a browser page cannot own a notification-area icon. The background
daemon starts a tiny Windows process (PowerShell WinForms, no extra dependency) that shows the icon:

- Windows 11 hides new tray icons by default: click the **^** (show hidden icons) next to the clock, or open
  Settings -> Personalization -> Taskbar -> Other system tray icons and switch the
  "one-click-tunnel / 临时公网映射" entry on to keep it visible.
- The icon only lives while the daemon runs. In 1.2.x the daemon lived in the console window, so closing that
  window killed the tray as well. From 1.3.0 the launcher is windowless and the daemon is detached, so closing
  the app window keeps the tunnels **and** the tray alive.
- Start it manually any time: public-tunnel.exe tray  (reuses the running daemon; exits if one is already there)
- Turn it off: config page -> Global settings -> Tray, or tray.enabled=false in config.json.
- If the daemon dies, the tray closes itself within ~10 seconds (watchdog), so no ghost icons are left behind.

## Desktop app (no console window)

The shortcut starts the background daemon **hidden** and opens the config page inside a chromeless desktop
window (Edge/Chrome app mode: no address bar, no tabs, its own taskbar entry and icon). Closing that window
does **not** stop the tunnels - the tray icon stays, and the tray menu (or the "close everything" shortcut,
which runs stop-all.vbs) quits everything. No cmd window appears: the shortcut runs a .vbs launcher and the
daemon is spawned detached and hidden.

    public-tunnel.exe app             # open the desktop window (starts the daemon when needed)
    public-tunnel.exe gui --browser   # use a normal browser tab instead of the app window

## Config file (config.json, next to the exe)

    {
      "version": 1,
      "gui":  { "port": 18400, "token": "<auto generated>", "openBrowser": true },
      "mcp":  { "enabled": true, "allowStart": true, "allowStop": true },
      "tray": { "enabled": true },
      "defaults": { "ttl": "1h", "passwordMode": "random", "gatewayStart": 18080, "rateLimit": 3000 },
      "update": { "enabled": true, "repo": "Thunderunruly/one-click-tunnel",
                  "apiBase": "https://api.github.com", "checkIntervalHours": 6,
                  "autoDownload": false, "includePrerelease": false,
                  "downloadMirror": "", "ignoredVersion": "" },
      "profiles": [
        { "id": "web", "name": "web 3000", "enabled": true, "autoStart": false,
          "port": 3000, "gateway": 18080, "ttl": "30m",
          "passwordMode": "random", "password": "", "host": "127.0.0.1" }
      ]
    }

One profile = one local port + one gateway port + one password + one TTL. Each profile runs as its own child process,
so session keys, rate limits, lockouts and timers are isolated per tunnel.

## MCP (AI integration)

    {
      "mcpServers": {
        "one-click-tunnel": {
          "command": "C:\\Users\\<you>\\AppData\\Local\\one-click-tunnel\\public-tunnel.exe",
          "args": ["mcp"]
        }
      }
    }

Tools exposed: list_tunnels, create_tunnel, start_tunnel, stop_tunnel, update_tunnel, delete_tunnel,
set_password, tunnel_status, stop_all. Tunnels created by the AI show up in the config page and can be
stopped by hand at any time. Use mcp.allowStart / mcp.allowStop to limit what the AI may do.

## Updates

The program checks the GitHub release channel for a newer version (default: every 6 hours, configurable) and shows a
banner on the config page when one exists. You can also check on demand:

    public-tunnel.exe update               # check now
    public-tunnel.exe update --notes       # print the release notes
    public-tunnel.exe update --download    # download the installer into updates\ (SHA-256 verified)
    public-tunnel.exe update --install     # silently run the downloaded setup.exe
    public-tunnel.exe version              # print the current version

- Downloads are verified against the release SHA256SUMS.txt; a mismatch deletes the file and fails loudly.
- Auto-download (never auto-install) can be enabled with update.autoDownload.
- Behind a blocked network, point update.apiBase at a GitHub API mirror and/or set update.downloadMirror to something
  like https://your-mirror.example/{url} -- the {url} placeholder is replaced with the real asset URL.
- Ignore a version from the banner (it is stored as update.ignoredVersion).
- AI hosts get the same capability through the MCP tool check_update.

## Security

- Password gate on 127.0.0.1 only; constant-time password comparison; per-IP lockout (8 failures / 5 min) and rate limit
- Session cookie: HMAC signature, random per-session id, HttpOnly, SameSite=Lax, Secure over https, server-side revocation on logout
- Requests are sanitised before proxying: hop-by-hop headers stripped, Host rewritten unless allow-listed,
  X-Forwarded-For / X-Real-IP overwritten with the real client IP, gateway credentials never forwarded upstream
- TRACE/TRACK, CONNECT and absolute-form request lines rejected; unauthenticated requests never reach your service
- Config page: loopback only, token required, same-origin enforced on writes, strict CSP, no external resources
- TTL auto-shutdown, process-tree cleanup, orphan cloudflared reaping, logs never contain the password

Verified by re-runnable suites (offline unless noted):

    npm test                      # 72 + 25 + 29 + 27 checks
    npm run test:exe              # packaged exe: CLI / GUI / self-spawn
    npm run test:installer        # installer end-to-end
    npm run test:live             # real Cloudflare tunnel from the public side (needs internet)

## Build from source

    git clone https://github.com/Thunderunruly/one-click-tunnel.git
    cd one-click-tunnel
    node build/make-exe.mjs       # dist/public-tunnel.exe (single file, Node SEA)
    node build/make-zip.mjs       # release/one-click-tunnel-<version>-win-x64.zip
    node build/make-setup.mjs     # release/one-click-tunnel-setup-<version>.exe (needs Inno Setup 6)

Releases are produced automatically by GitHub Actions: push a tag like v1.1.0 and the
[Release workflow](.github/workflows/release.yml) runs the test suites, builds the exe, the portable zip and the
Inno Setup installer, then publishes them to the GitHub release.

MIT licensed. cloudflared is a separate binary by Cloudflare (Apache-2.0).

## Why not Go? (measured, not guessed)

The password gate is I/O bound, not CPU bound. On a local loopback benchmark (`build/bench.mjs`, 4000 requests,
40 concurrent, keep-alive) it adds **+0.62 ms p50** and keeps ~86% of the raw throughput (14.0k vs 16.3k req/s),
while the real request path - Internet -> Cloudflare edge -> cloudflared -> gate -> your app - is dominated by the
network and by cloudflared, which is itself written in Go.

| metric | measured |
| --- | --- |
| gate overhead | +0.62 ms p50, +1.25 ms p95 |
| throughput | 14,035 req/s gated vs 16,260 req/s direct |
| per-tunnel memory | 72 MB gate process + 46 MB cloudflared |
| cold start | 55 ms |
| artifacts | exe 83.4 MB, cloudflared 52.4 MB, portable zip 49.2 MB |

A Go rewrite would mostly buy a smaller binary (~10 MB) and less memory per tunnel - packaging wins, not throughput -
so the Node implementation stays. Re-measure any time with `node build/bench.mjs` (or `npm run bench`); if a real
workload ever reaches these numbers, revisit the decision with data.

## Launcher: no console window, no VBScript

The desktop/Start-Menu shortcut points at `one-click-tunnel.exe` - a ~7 KB native launcher compiled from
build/launcher/Launcher.cs with the csc.exe that ships with Windows. It is a **GUI-subsystem** binary
(PE Subsystem=2), so it starts `public-tunnel.exe app` hidden and exits immediately: **no console window flashes**.
It also removed the old VBScript launcher, which matters because Microsoft is deprecating VBScript
(optional feature since Windows 11 24H2). Rebuild it with `node build/make-launcher.mjs`.

