# Fyne PoC（OCT 桌面壳可行性验证）

目的：在三个平台上验证用 Fyne 做桌面壳是否可行，并就地测出体积与依赖。

## 为什么要这个 PoC

- 核心（密码门 + 多通道 + cloudflared + 更新 + MCP）准备改用 Go，UI 用 Fyne 就能做到
  **一个语言、一个进程、一个二进制**（比 Flutter 少一层 sidecar 和一层 HTTP 往返）
- 但 Fyne 在 Windows 上要 **cgo**（需要 MinGW），而且它的**中文输入法**历史上偏弱
  → 先用最小程序验证这两点，再决定投不投入

## 里面验什么

- 窗口（1100x720）、左侧通道列表、中间详情卡片、底部实时日志区
- 系统托盘菜单（打开窗口 / 全部启动 / 全部停止 / 复制链接 / 退出）
- 关窗口 = 隐藏到托盘（而不是退出）
- **一个中文输入框**：请用中文输入法打几个字，验证候选框与上屏
- 每 3 秒探测 127.0.0.1:18400/api/health，显示"核心在线/离线"

## 怎么构建

本地（Windows，需要 MinGW/gcc）：

    cd poc/fyne
    go mod tidy
    go build -ldflags "-H windowsgui" -o oct-poc.exe .

或者直接推代码让 GitHub Actions 构建三平台（.github/workflows/fyne-poc.yml），产物在 Actions 的 artifacts 里。

## 人工验证清单（只有人能测）

1. 中文输入法在"通道名"输入框里能否正常输入（Windows/macOS/Linux 各一次）
2. 托盘图标是否出现（GNOME 可能需要扩展；macOS 在菜单栏）
3. 点 × 是隐藏到托盘，托盘菜单能再打开窗口、能退出
4. 字号 / 清晰度 / 滚动流畅度是否可接受
