
import io, os, re, subprocess
ROOT = r'D:\Program\public-tunnel'

def to_utf16_crlf(text):
    # 统一成 CRLF，再以 UTF-16LE + BOM 写盘（WSH 原生支持）
    t = text.replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\r\n')
    return t

for name in ['launch.vbs', 'stop-all.vbs']:
    p = os.path.join(ROOT, 'installer', name)
    src = io.open(p, encoding='utf-8').read()
    fixed = to_utf16_crlf(src)
    io.open(p, 'w', encoding='utf-16', newline='').write(fixed)   # utf-16 => LE + BOM
    d = io.open(p, 'rb').read()
    print('%-14s BOM=%s CRLF=%d bytes=%d' % (name, d[:2] == b'\xff\xfe', d.count(b'\r\x00\n\x00'), len(d)))

# 生成"只解析不执行"的探针副本，用 cscript 验证语法（UTF-16）
probe_dir = os.path.join(ROOT, 'build', '_vbsprobe')
os.makedirs(probe_dir, exist_ok=True)
for name in ['launch.vbs', 'stop-all.vbs']:
    src = io.open(os.path.join(ROOT, 'installer', name), encoding='utf-16').read()
    src = re.sub(r'shell\.Run[^\r\n]*', 'WScript.Echo "PARSED-OK:' + name + '"', src)
    src = re.sub(r'MsgBox[^\r\n]*', 'WScript.Echo "MSGBOX-SKIPPED"', src)
    io.open(os.path.join(probe_dir, name), 'w', encoding='utf-16', newline='').write(to_utf16_crlf(src))
print('探针已生成')
