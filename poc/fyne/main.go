// OCT (One Click Tunnel) Fyne PoC
// 目的：验证三平台桌面壳的关键能力 —— 窗口 + 托盘 + 列表 + 日志区 + 中文输入(IME)
// 用法: go build -ldflags "-H windowsgui" -o oct-poc.exe .
package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// 生成一个 32x32 的托盘图标（品牌蓝圆角块 + 白色 O），避免出现"空白图标"
func trayIcon() fyne.Resource {
	const n = 32
	img := image.NewRGBA(image.Rect(0, 0, n, n))
	brand := color.NRGBA{R: 0x25, G: 0x63, B: 0xeb, A: 0xff}
	white := color.NRGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			dx, dy := x-n/2, y-n/2
			if dx*dx+dy*dy <= (n/2-1)*(n/2-1) {
				img.Set(x, y, brand)
			}
		}
	}
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			dx, dy := x-n/2, y-n/2
			d2 := dx*dx + dy*dy
			if d2 >= 36 && d2 <= 64 {
				img.Set(x, y, white)
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return fyne.NewStaticResource("oct-tray.png", buf.Bytes())
}

type channel struct {
	name    string
	running bool
	target  string
	public  string
	left    string
}

var (
	logLines  []string
	logLabel  *widget.Label
	logScroll *container.Scroll
	uiRunning int32
)

func setLogText() {
	if logLabel == nil {
		return
	}
	logLabel.SetText(strings.Join(logLines, "\n"))
	if logScroll != nil {
		logScroll.ScrollToBottom()
	}
}

func appendLog(s string) {
	logLines = append(logLines, time.Now().Format("15:04:05")+"  "+s)
	if len(logLines) > 400 {
		logLines = logLines[len(logLines)-400:]
	}
	if atomic.LoadInt32(&uiRunning) == 1 {
		fyne.Do(setLogText)
	} else {
		setLogText()
	}
}

func main() {
	a := app.NewWithID("com.thunderunruly.oct.poc")
	w := a.NewWindow("OCT — One Click Tunnel (Fyne PoC)")

	channels := []channel{
		{"web 3000（中文名试试：家里的 NAS）", true, "127.0.0.1:3000", "https://demo-a.trycloudflare.com", "58m"},
		{"nas 5000", false, "192.168.1.50:5000", "-", "-"},
		{"api 8080", true, "127.0.0.1:8080", "https://demo-b.trycloudflare.com", "12m"},
	}

	statusLabel := widget.NewLabel("核心: 检测中…")
	logLabel = widget.NewLabel("（日志区）")
	logLabel.Wrapping = fyne.TextWrapWord
	logScroll = container.NewVScroll(logLabel)

	list := widget.NewList(
		func() int { return len(channels) },
		func() fyne.CanvasObject { return widget.NewLabel("template") },
		func(i widget.ListItemID, o fyne.CanvasObject) {
			c := channels[i]
			mark := "○ 已停止"
			if c.running {
				mark = "● 运行中"
			}
			o.(*widget.Label).SetText(fmt.Sprintf("%s   %s\n     %s → %s  %s", mark, c.name, c.target, c.public, c.left))
		},
	)

	nameEntry := widget.NewEntry()
	nameEntry.SetPlaceHolder("通道名：请用中文输入法打几个字（例如 家里的 NAS）")
	hostEntry := widget.NewEntry()
	hostEntry.SetPlaceHolder("目标地址，例如 192.168.1.50:5000 或 127.0.0.1:3000")
	ttl := widget.NewSelect([]string{"15 分钟", "30 分钟", "1 小时", "6 小时", "1 天", "永不关闭"}, nil)
	ttl.SetSelected("1 小时")
	pwEntry := widget.NewPasswordEntry()
	pwEntry.SetText("vArSyjpWWS")
	pwPlain := widget.NewLabel("vArSyjpWWS")
	pwVisible := false

	urlText := "https://demo-a.trycloudflare.com"
	urlLabel := widget.NewLabelWithStyle(urlText, fyne.TextAlignLeading, fyne.TextStyle{Monospace: true, Bold: true})
	pwRow := container.NewBorder(nil, nil, nil,
		widget.NewButton("显示", func() {
			pwVisible = !pwVisible
			if pwVisible {
				pwPlain.Show()
				pwEntry.Hide()
			} else {
				pwPlain.Hide()
				pwEntry.Show()
			}
		}),
		container.NewStack(pwEntry, pwPlain),
	)
	pwPlain.Hide()

	actionLog := widget.NewLabel("")
	copyBtn := widget.NewButtonWithIcon("复制链接和密码", theme.ContentCopyIcon(), func() {
		a.Clipboard().SetContent(urlText + "    密码: vArSyjpWWS")
		actionLog.SetText("已复制到剪贴板（去别处粘贴一下，验证中文/特殊字符没坏）")
	})

	left := container.NewBorder(
		widget.NewLabelWithStyle("通道（3）", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		nil, nil, nil, list)

	middle := container.NewVBox(
		widget.NewCard("状态", "运行中 · 剩余 58 分钟", container.NewVBox(urlLabel, copyBtn, actionLog)),
		widget.NewCard("参数", "", container.NewVBox(
			widget.NewLabel("通道名（IME 测试点）"), nameEntry,
			widget.NewLabel("目标地址（本机或局域网设备）"), hostEntry,
			widget.NewLabel("有效期"), ttl,
			widget.NewLabel("访问密码"), pwRow,
		)),
		widget.NewCard("操作", "", container.NewHBox(
			widget.NewButtonWithIcon("启动", theme.MediaPlayIcon(), func() { appendLog("点击了：启动") }),
			widget.NewButtonWithIcon("停止", theme.MediaStopIcon(), func() { appendLog("点击了：停止") }),
			widget.NewButton("删除隧道", func() { appendLog("点击了：删除隧道") }),
		)),
	)
	right := container.NewVSplit(middle, container.NewBorder(
		widget.NewLabelWithStyle("实时日志", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}), nil, nil, nil, logScroll))
	right.Offset = 0.72

	split := container.NewHSplit(left, right)
	split.Offset = 0.3

	top := container.NewHBox(
		statusLabel,
		widget.NewButton("全部启动", func() { appendLog("点击了：全部启动") }),
		widget.NewButton("全部停止", func() { appendLog("点击了：全部停止") }),
		widget.NewButton("检查更新", func() { appendLog("点击了：检查更新") }),
	)

	w.SetContent(container.NewBorder(top, nil, nil, nil, split))
	w.Resize(fyne.NewSize(1100, 720))

	// 关窗口 = 隐藏到托盘（这正是我们要的行为）
	w.SetCloseIntercept(func() {
		dialog.NewCustomConfirm("关闭窗口", "最小化到托盘", "退出程序", widget.NewLabel("你想最小化到托盘继续跑，还是直接退出（会停掉所有通道）？"), func(minimize bool) {
			if minimize {
				w.Hide()
				appendLog("已选择：最小化到托盘（托盘菜单可再打开）")
			} else {
				appendLog("已选择：退出程序")
				a.Quit()
			}
		}, w).Show()
	})

	if desk, ok := a.(desktop.App); ok {
		menu := fyne.NewMenu("OCT — One Click Tunnel",
			fyne.NewMenuItem("打开窗口", func() { w.Show(); w.RequestFocus() }),
			fyne.NewMenuItemSeparator(),
			fyne.NewMenuItem("全部启动", func() { appendLog("托盘：全部启动") }),
			fyne.NewMenuItem("全部停止", func() { appendLog("托盘：全部停止") }),
			fyne.NewMenuItem("复制最近一条链接", func() { a.Clipboard().SetContent(urlText); appendLog("托盘：已复制链接") }),
			fyne.NewMenuItemSeparator(),
			fyne.NewMenuItem("退出（关闭所有通道）", func() { a.Quit() }),
		)
		desk.SetSystemTrayIcon(trayIcon())
		desk.SetSystemTrayMenu(menu)
		appendLog("托盘菜单已注册 —— 找任务栏右下角/顶栏菜单栏的图标（Windows 可能在 ^ 溢出区）")
	} else {
		appendLog("当前平台没有系统托盘接口")
	}

	// 事件循环起来之后再开定时器（fyne.Do 需要主循环）
	go func() {
		time.Sleep(600 * time.Millisecond)
		atomic.StoreInt32(&uiRunning, 1)
		appendLog("UI 就绪；下面每 2 秒一条心跳")
		n := 0
		for range time.Tick(2 * time.Second) {
			n++
			appendLog(fmt.Sprintf("心跳 #%d：守护进程正常，当前 2 条通道在跑", n))
		}
	}()
	go func() {
		client := &http.Client{Timeout: 1200 * time.Millisecond}
		for range time.Tick(3 * time.Second) {
			txt := "核心: 离线（oct 未运行）"
			resp, err := client.Get("http://127.0.0.1:18400/api/health")
			if err == nil {
				if resp.StatusCode == 200 {
					txt = "核心: 在线"
				}
				resp.Body.Close()
			}
			fyne.Do(func() { statusLabel.SetText(txt) })
		}
	}()

	w.ShowAndRun()
}
