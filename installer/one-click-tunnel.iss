; one-click-tunnel Inno Setup 脚本（由 build/make-setup.mjs 调用 ISCC 编译）
; 生成 one-click-tunnel-setup-<版本>.exe：免管理员、按用户安装、带开始菜单/桌面快捷方式与卸载项
#ifndef MyAppVersion
  #define MyAppVersion "1.1.0"
#endif
#define MyAppName "one-click-tunnel"
#define MyAppExeName "public-tunnel.exe"

[Setup]
AppId={{7C3B1C9A-6C2E-4B7F-9A1D-2F5E8C4B7A31}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=Thunderunruly
AppPublisherURL=https://github.com/Thunderunruly/one-click-tunnel
AppSupportURL=https://github.com/Thunderunruly/one-click-tunnel/issues
DefaultDirName={localappdata}\one-click-tunnel
DefaultGroupName=one-click-tunnel
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=one-click-tunnel-setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
MinVersion=10.0

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\cloudflared.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\*.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\one-click-tunnel.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\one-click-tunnel"; Filename: "{app}\one-click-tunnel.exe"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Comment: "临时公网映射（桌面窗口 + 托盘，无命令行弹窗）"
Name: "{userprograms}\one-click-tunnel 全部关闭"; Filename: "{app}\one-click-tunnel.exe"; Parameters: "--stop-all"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Comment: "关闭所有通道与后台进程"
Name: "{userdesktop}\one-click-tunnel"; Filename: "{app}\one-click-tunnel.exe"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\one-click-tunnel.exe"; Description: "立即启动（桌面窗口 + 托盘）"; Flags: postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\state"
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\*.pid"
