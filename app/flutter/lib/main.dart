// OCT (One Click Tunnel) 桌面外壳 — Flutter 版
// 只通过本地 HTTP API（127.0.0.1:18400）与核心通信
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

const kBg = Color(0xFF0F1115);
const kCard = Color(0xFF171A21);
const kLine = Color(0xFF262B36);
const kAccent = Color(0xFF2563EB);
const kOk = Color(0xFF22C55E);
const kErr = Color(0xFFEF4444);
const kMuted = Color(0xFF8B95A5);
final navKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  const opts = WindowOptions(
      size: Size(1100, 720),
      minimumSize: Size(900, 600),
      center: true,
      title: 'OCT - One Click Tunnel',
      backgroundColor: kBg);
  await windowManager.waitUntilReadyToShow(opts, () async {
    await windowManager.show();
    await windowManager.focus();
  });
  runApp(const OctApp());
}

class OctApp extends StatelessWidget {
  const OctApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navKey,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: kBg,
        colorScheme: const ColorScheme.dark(primary: kAccent, surface: kCard),
      ),
      home: const SplashGate(),
    );
  }
}

class Core {
  final String base = 'http://127.0.0.1:18400';
  String? token;
  String? appDir;

  List<String> searchDirs() {
    final sep = Platform.pathSeparator;
    final list = <String>[];
    void add(String? d) {
      if (d != null && d.isNotEmpty && !list.contains(d)) list.add(d);
    }

    add(Platform.environment['ONE_CLICK_TUNNEL_DIR']);
    // 从可执行文件所在目录逐级往上找：macOS 的 .app 里 exe 在 oct_shell.app/Contents/MacOS/，
    // 核心是放在 .app 外面的，所以必须往上找几层。
    Directory cur = File(Platform.resolvedExecutable).parent;
    for (var i = 0; i < 4; i++) {
      add(cur.path);
      final up = cur.parent;
      if (up.path == cur.path) break;
      cur = up;
    }
    if (Platform.isWindows) {
      final la = Platform.environment['LOCALAPPDATA'];
      final pd = Platform.environment['PROGRAMDATA'];
      final pf = Platform.environment['ProgramFiles'];
      add(la == null ? null : la + sep + 'one-click-tunnel');
      add(la == null ? null : la + sep + 'Programs' + sep + 'one-click-tunnel');
      add(pd == null ? null : pd + sep + 'one-click-tunnel');
      add(pf == null ? null : pf + sep + 'one-click-tunnel');
    } else if (Platform.isMacOS) {
      final h = Platform.environment['HOME'];
      add(h == null ? null : h + '/Library/Application Support/one-click-tunnel');
      add('/usr/local/one-click-tunnel');
      add('/opt/one-click-tunnel');
    } else {
      final h = Platform.environment['HOME'];
      add(h == null ? null : h + '/.config/one-click-tunnel');
      add('/usr/local/one-click-tunnel');
      add('/opt/one-click-tunnel');
    }
    return list;
  }

  List<String> candidates() {
    final sep = Platform.pathSeparator;
    return searchDirs().map((d) => d + sep + 'config.json').toList();
  }

  Future<void> loadToken() async {
    for (final f in candidates()) {
      try {
        final j = jsonDecode(await File(f).readAsString()) as Map<String, dynamic>;
        final gui = j['gui'];
        if (gui is Map) {
          final t = gui['token'];
          if (t is String && t.isNotEmpty) {
            token = t;
            appDir = File(f).parent.path;
            return;
          }
        }
      } catch (_) {}
    }
  }

  Map<String, String> get headers {
    final h = <String, String>{'content-type': 'application/json'};
    if (token != null) h['x-tunnel-token'] = token as String;
    return h;
  }

  Future<Map<String, dynamic>?> health() async {
    try {
      final r = await http.get(Uri.parse(base + '/api/health')).timeout(const Duration(seconds: 2));
      if (r.statusCode == 200) return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {}
    return null;
  }

  Future<Map<String, dynamic>?> state() async {
    try {
      final r = await http.get(Uri.parse(base + '/api/state'), headers: headers).timeout(const Duration(seconds: 5));
      if (r.statusCode == 200) return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {}
    return null;
  }

  Future<String> logOf(String id) async {
    try {
      final r = await http.get(Uri.parse(base + '/api/log?id=' + id), headers: headers).timeout(const Duration(seconds: 5));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body) as Map<String, dynamic>;
        return (j['log'] ?? '') as String;
      }
    } catch (_) {}
    return '';
  }

  Future<bool> action(String action, {String? id}) async {
    try {
      final body = <String, dynamic>{'action': action};
      if (id != null) body['id'] = id;
      final r = await http
          .post(Uri.parse(base + '/api/action'), headers: headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 120));
      return r.statusCode < 400;
    } catch (_) {
      return false;
    }
  }

  Future<bool> startCore() async {
    final sep = Platform.pathSeparator;
    final names = Platform.isWindows ? <String>['oct.exe'] : <String>['oct'];
    for (final d in searchDirs()) {
      for (final n in names) {
        final c = d + sep + n;
        try {
          if (!File(c).existsSync()) continue;
          await Process.start(c, ['daemon', 'start'], mode: ProcessStartMode.detached);
          return true;
        } catch (_) {}
      }
    }
    return false;
  }
}

class SplashGate extends StatefulWidget {
  const SplashGate({super.key});
  @override
  State<SplashGate> createState() => SplashGateState();
}

class SplashGateState extends State<SplashGate> {
  final core = Core();
  String msg = '正在连接核心...';

  @override
  void initState() {
    super.initState();
    boot();
  }

  Future<void> boot() async {
    await core.loadToken();
    var h = await core.health();
    if (h == null) {
      setState(() => msg = '核心未运行，正在尝试启动...');
      await core.startCore();
      for (var i = 0; i < 20 && h == null; i++) {
        await Future.delayed(const Duration(milliseconds: 800));
        h = await core.health();
      }
    }
    await Future.delayed(const Duration(milliseconds: 400));
    if (!mounted) return;
    Navigator.of(context).pushReplacement(MaterialPageRoute<dynamic>(
        builder: (_) => ShellPage(core: core, online: h != null)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[
          Container(
            width: 92,
            height: 92,
            decoration: BoxDecoration(color: kAccent, borderRadius: BorderRadius.circular(24)),
            child: const Center(
              child: Text('OCT',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold, color: Colors.white, letterSpacing: 1.5)),
            ),
          ),
          const SizedBox(height: 22),
          const Text('OCT - One Click Tunnel', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          const Text('一键隧道：把本机或局域网端口临时映射到公网', style: TextStyle(fontSize: 12.5, color: kMuted)),
          const SizedBox(height: 26),
          const SizedBox(width: 190, child: LinearProgressIndicator(minHeight: 3)),
          const SizedBox(height: 12),
          Text(msg, style: const TextStyle(fontSize: 12.5, color: kMuted)),
        ]),
      ),
    );
  }
}

class ShellPage extends StatefulWidget {
  const ShellPage({super.key, required this.core, required this.online});
  final Core core;
  final bool online;
  @override
  State<ShellPage> createState() => ShellPageState();
}

class ShellPageState extends State<ShellPage> with WindowListener, TrayListener {
  Map<String, dynamic>? st;
  bool online = false;
  String? selectedId;
  String logText = '';
  Timer? poller;
  Timer? logPoller;

  List<Map<String, dynamic>> get channels {
    final raw = st?['profiles'];
    if (raw is! List) return <Map<String, dynamic>>[];
    return raw.whereType<Map<String, dynamic>>().toList();
  }

  Map<String, dynamic>? get selected {
    final list = channels;
    if (list.isEmpty) return null;
    final want = selectedId ?? list.first['id'];
    for (final c in list) {
      if (c['id'] == want) return c;
    }
    return list.first;
  }

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    windowManager.setPreventClose(true);
    trayManager.addListener(this);
    online = widget.online;
    initTray();
    refresh();
    poller = Timer.periodic(const Duration(seconds: 2), (_) => refresh());
    logPoller = Timer.periodic(const Duration(seconds: 1), (_) => refreshLog());
  }

  @override
  void dispose() {
    poller?.cancel();
    logPoller?.cancel();
    windowManager.removeListener(this);
    trayManager.removeListener(this);
    super.dispose();
  }

  Future<void> initTray() async {
    try {
      await trayManager.setIcon(await trayIconFile());
      await trayManager.setToolTip('OCT - One Click Tunnel');
      await trayManager.setContextMenu(Menu(items: <MenuItem>[
        MenuItem(key: 'open', label: '打开窗口'),
        MenuItem.separator(),
        MenuItem(key: 'startAll', label: '全部启动'),
        MenuItem(key: 'stopAll', label: '全部停止'),
        MenuItem.separator(),
        MenuItem(key: 'quit', label: '退出（关闭所有通道）'),
      ]));
    } catch (_) {}
  }

  Future<String> trayIconFile() async {
    const int n = 32;
    final rec = ui.PictureRecorder();
    final cv = Canvas(rec);
    cv.drawRRect(
        RRect.fromRectAndRadius(const Rect.fromLTWH(0, 0, 32, 32), const Radius.circular(7)),
        Paint()..color = kAccent);
    cv.drawCircle(const Offset(16, 16), 8, Paint()..color = Colors.white);
    cv.drawCircle(const Offset(16, 16), 4.5, Paint()..color = kAccent);
    final img = await rec.endRecording().toImage(n, n);
    final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
    final dir = Directory.systemTemp.createTempSync('oct_shell');
    final f = File(dir.path + Platform.pathSeparator + 'oct-tray.png');
    await f.writeAsBytes(bytes!.buffer.asUint8List());
    return f.path;
  }

  Future<void> refresh() async {
    final s = await widget.core.state();
    if (!mounted) return;
    setState(() {
      online = s != null;
      if (s != null) st = s;
    });
  }

  Future<void> refreshLog() async {
    final c = selected;
    if (c == null) return;
    final t = await widget.core.logOf(c['id'] as String);
    if (!mounted) return;
    setState(() => logText = t.length > 8000 ? t.substring(t.length - 8000) : t);
  }

  String tokenHint() {
    if (widget.core.token == null) {
      return '核心在线，但没读到 config.json（拿不到 token）。\n'
          '把本程序放到 oct.exe 同目录，或设置环境变量 ONE_CLICK_TUNNEL_DIR 指向数据目录。';
    }
    return '还没有通道。用 oct add 或配置页创建。';
  }

  Color dotColor(Map<String, dynamic> c) {
    if (c['running'] == true) return kOk;
    final e = c['error'];
    if (e is String && e.isNotEmpty) return kErr;
    return const Color(0xFF6B7280);
  }

  @override
  void onWindowClose() async {
    final ctx = navKey.currentContext;
    if (ctx == null) {
      await windowManager.hide();
      return;
    }
    final ans = await showDialog<String>(
      context: ctx,
      builder: (c) => AlertDialog(
        backgroundColor: kCard,
        title: const Text('关闭窗口'),
        content: const Text('最小化到托盘继续跑，还是退出程序（会停掉所有通道）？'),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(c, 'hide'), child: const Text('最小化到托盘')),
          TextButton(onPressed: () => Navigator.pop(c, 'quit'), child: const Text('退出程序')),
        ],
      ),
    );
    if (ans == 'quit') {
      await widget.core.action('stopAll');
      await trayManager.destroy();
      await windowManager.destroy();
    } else {
      await windowManager.hide();
    }
  }

  @override
  void onTrayMenuItemClick(MenuItem item) async {
    if (item.key == 'open') {
      await windowManager.show();
      await windowManager.focus();
      return;
    }
    if (item.key == 'quit') {
      await widget.core.action('stopAll');
      await trayManager.destroy();
      await windowManager.destroy();
      return;
    }
    if (item.key == 'startAll') await widget.core.action('startAll');
    if (item.key == 'stopAll') await widget.core.action('stopAll');
    await refresh();
  }

  Widget card(String title, List<Widget> kids) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: kCard, border: Border.all(color: kLine), borderRadius: BorderRadius.circular(14)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
        Text(title, style: const TextStyle(fontSize: 12, color: kMuted)),
        const SizedBox(height: 10),
        ...kids,
      ]),
    );
  }

  Widget kv(String k, String v) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: <Widget>[
        SizedBox(width: 96, child: Text(k, style: const TextStyle(fontSize: 12.5, color: kMuted))),
        Expanded(child: SelectableText(v, style: const TextStyle(fontSize: 12.5))),
      ]),
    );
  }

  String targetText(Map<String, dynamic> c) {
    final t = c['target'];
    if (t is String && t.isNotEmpty) return t;
    return '127.0.0.1:' + (c['port'] ?? '').toString();
  }

  @override
  Widget build(BuildContext context) {
    final sel = selected;
    final ver = st?['version'] ?? '';
    return Scaffold(
      body: Column(children: <Widget>[
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: const BoxDecoration(color: kCard, border: Border(bottom: BorderSide(color: kLine))),
          child: Row(children: <Widget>[
            Container(
              width: 26,
              height: 26,
              decoration: BoxDecoration(color: kAccent, borderRadius: BorderRadius.circular(7)),
              child: const Center(child: Text('O', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white))),
            ),
            const SizedBox(width: 8),
            const Text('OCT - One Click Tunnel', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(width: 14),
            Container(width: 8, height: 8, decoration: BoxDecoration(color: online ? kOk : kErr, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Text(online ? ('核心在线 ' + ver.toString()) : '核心离线', style: const TextStyle(fontSize: 12, color: kMuted)),
            const Spacer(),
            FilledButton(onPressed: () => widget.core.action('startAll').then((_) => refresh()), child: const Text('全部启动')),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: () => widget.core.action('stopAll').then((_) => refresh()), child: const Text('全部停止')),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: refresh, child: const Text('刷新')),
          ]),
        ),
        Expanded(
          child: Row(children: <Widget>[
            SizedBox(
              width: 265,
              child: Container(
                decoration: const BoxDecoration(border: Border(right: BorderSide(color: kLine))),
                child: ListView(children: <Widget>[
                  const Padding(padding: EdgeInsets.all(12), child: Text('通道', style: TextStyle(color: kMuted, fontSize: 12))),
                  for (final c in channels)
                    InkWell(
                      onTap: () => setState(() => selectedId = c['id'] as String),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        color: c['id'] == sel?['id'] ? const Color(0xFF1E2530) : null,
                        child: Row(children: <Widget>[
                          Container(width: 8, height: 8, decoration: BoxDecoration(color: dotColor(c), shape: BoxShape.circle)),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
                              Text((c['name'] ?? c['id']).toString(),
                                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                              const SizedBox(height: 2),
                              Text(
                                  targetText(c) + ' -> ' + (((c['url'] ?? '') as String).isEmpty ? '未启动' : c['url'].toString()),
                                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: kMuted)),
                            ]),
                          ),
                        ]),
                      ),
                    ),
                  if (channels.isEmpty)
                    Padding(
                        padding: const EdgeInsets.all(14),
                        child: Text(tokenHint(), style: const TextStyle(fontSize: 12, color: kMuted))),
                ]),
              ),
            ),
            Expanded(
              child: sel == null
                  ? const Center(child: Text('左侧还没有通道', style: TextStyle(color: kMuted)))
                  : Column(children: <Widget>[
                      Expanded(
                        child: ListView(padding: const EdgeInsets.all(16), children: <Widget>[
                          card('状态', <Widget>[
                            Text(((sel['url'] ?? '') as String).isEmpty ? '未启动' : sel['url'].toString(),
                                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 8),
                            TextButton.icon(
                              onPressed: () => Clipboard.setData(ClipboardData(
                                  text: (sel['url'] ?? '').toString() + '  密码: ' + (sel['password'] ?? '').toString())),
                              icon: const Icon(Icons.copy, size: 16),
                              label: const Text('复制链接和密码'),
                            ),
                          ]),
                          const SizedBox(height: 12),
                          card('参数', <Widget>[
                            kv('目标地址', targetText(sel)),
                            kv('有效期 TTL', (sel['ttl'] ?? '').toString()),
                            kv('隧道类型', sel['mode'] == 'named' ? ('命名隧道 · ' + (sel['hostname'] ?? '').toString()) : '快速隧道（地址随机）'),
                            kv('访问密码', (sel['passwordMode'] == 'fixed' ? '手动固定' : '每次随机') + ' · ' + (sel['password'] ?? '').toString()),
                            kv('本地网关', '127.0.0.1:' + (sel['gateway'] ?? '').toString()),
                          ]),
                          const SizedBox(height: 12),
                          card('操作', <Widget>[
                            Row(children: <Widget>[
                              FilledButton.icon(
                                  onPressed: () => widget.core.action('start', id: sel['id'] as String).then((_) => refresh()),
                                  icon: const Icon(Icons.play_arrow, size: 18),
                                  label: const Text('启动')),
                              const SizedBox(width: 8),
                              OutlinedButton.icon(
                                  onPressed: () => widget.core.action('stop', id: sel['id'] as String).then((_) => refresh()),
                                  icon: const Icon(Icons.stop, size: 18),
                                  label: const Text('停止')),
                            ]),
                          ]),
                        ]),
                      ),
                      Container(
                        height: 190,
                        decoration: const BoxDecoration(
                            color: Color(0xFF0B0D11), border: Border(top: BorderSide(color: kLine))),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
                          const Padding(
                              padding: EdgeInsets.fromLTRB(12, 8, 12, 4),
                              child: Text('实时日志', style: TextStyle(fontSize: 12, color: kMuted))),
                          Expanded(
                            child: SingleChildScrollView(
                              padding: const EdgeInsets.symmetric(horizontal: 12),
                              child: SelectableText(logText.isEmpty ? '（暂无输出）' : logText,
                                  style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace', height: 1.5)),
                            ),
                          ),
                        ]),
                      ),
                    ]),
            ),
          ]),
        ),
      ]),
    );
  }
}
