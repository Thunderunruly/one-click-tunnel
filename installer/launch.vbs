' 临时公网映射 - 无控制台启动器
' 安装目录里的快捷方式指向：wscript.exe //nologo "<安装目录>\launch.vbs"
' 作用：隐藏窗口拉起后台守护进程（配置页 + 托盘），并打开桌面窗口
Option Explicit
Dim fso, shell, dir, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\public-tunnel.exe"
If Not fso.FileExists(exe) Then
  MsgBox "找不到 " & exe & vbCrLf & "请重新安装。", 16, "临时公网映射"
  WScript.Quit 1
End If
shell.CurrentDirectory = dir
' app 子命令：守护进程没跑就自动拉起（隐藏窗口），然后打开桌面窗口
shell.Run """" & exe & """ app", 0, False
