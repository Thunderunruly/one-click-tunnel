' 临时公网映射 - 无控制台"全部关闭"
' 快捷方式/双击均可：隐藏窗口关闭所有通道与后台守护进程，然后弹一个提示
Option Explicit
Dim fso, shell, dir, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\public-tunnel.exe"
If fso.FileExists(exe) Then
  shell.CurrentDirectory = dir
  shell.Run """" & exe & """ stop --all", 0, True
  shell.Run """" & exe & """ daemon stop", 0, True
End If
MsgBox "已关闭所有通道与后台进程。" & vbCrLf & "对应的公网地址会变成 Cloudflare 530。", 64, "临时公网映射"
