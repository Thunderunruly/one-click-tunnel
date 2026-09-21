// OCT (One Click Tunnel) 桌面外壳 — Flutter 版（桌面版界面）
// 这是桌面程序，不是网页：左侧导航 + 顶栏 + 内容区 + 底部状态栏，全部走本地 HTTP API。
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
      size: Size(1180, 760),
      minimumSize: Size(980, 640),
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
        visualDensity: VisualDensity.compact,
        colorScheme: const ColorScheme.dark(primary: kAccent, surface: kCard),
      ),
      home: const SplashGate(),
    );
  }
}

class Core {
  final String base = 'http://127.0.0.1:18400';
  String? token;

  List<String> searchDirs() {
    final sep = Platform.pathSeparator;
    final list = <String>[];
    void add(String? d) {
      if (d != null && d.isNotEmpty && !list.contains(d)) list.add(d);
    }

    add(Platform.environment['ONE_CLICK_TUNNEL_DIR']);
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

  Future<Map<String, dynamic>?> getJson(String path) async {
    try {
      final r = await http.get(Uri.parse(base + path), headers: headers).timeout(const Duration(seconds: 10));
      if (r.statusCode == 200) return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {}
    return null;
  }

  Future<Map<String, dynamic>?> postJson(String path, Map<String, dynamic> body) async {
    try {
      final r = await http
          .post(Uri.parse(base + path), headers: headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 180));
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.statusCode >= 400) return <String, dynamic>{'error': (j['error'] ?? ('HTTP ' + r.statusCode.toString()))};
      return j;
    } catch (e) {
      return <String, dynamic>{'error': e.toString()};
    }
  }

  Future<String> logOf(String id) async {
    final j = await getJson('/api/log?id=' + id);
    if (j == null) return '';
    return (j['log'] ?? '') as String;
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
    await Future.delayed(const Duration(milliseconds: 350));
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
            width: 88,
            height: 88,
            decoration: BoxDecoration(color: kAccent, borderRadius: BorderRadius.circular(22)),
            child: const Center(
              child: Text('OCT',
                  style: TextStyle(fontSize: 25, fontWeight: FontWeight.bold, color: Colors.white, letterSpacing: 1.5)),
            ),
          ),
          const SizedBox(height: 20),
          const Text('OCT - One Click Tunnel', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          const Text('一键隧道：把本机或局域网端口临时映射到公网', style: TextStyle(fontSize: 12.5, color: kMuted)),
          const SizedBox(height: 24),
          const SizedBox(width: 180, child: LinearProgressIndicator(minHeight: 3)),
          const SizedBox(height: 12),
          Text(msg, style: const TextStyle(fontSize: 12.5, color: kMuted)),
        ]),
      ),
    );
  }
}

String humanUptime(Object? v) {
  final s = v is num ? v.toInt() : 0;
  if (s < 60) return s.toString() + ' 秒';
  if (s < 3600) return (s ~/ 60).toString() + ' 分 ' + (s % 60).toString() + ' 秒';
  return (s ~/ 3600).toString() + ' 小时 ' + ((s % 3600) ~/ 60).toString() + ' 分';
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
  int page = 0;
  String? selectedId;
  String logText = '';
  String busMsg = '';
  Timer? poller;
  Timer? logPoller;
  final ttlCtrl = TextEditingController();
  final gwCtrl = TextEditingController();
  final rlCtrl = TextEditingController();
  bool settingLoaded = false;

  List<Map<String, dynamic>> get channels {
    final raw = st?['profiles'];
    if (raw is! List) return <Map<String, dynamic>>[];
    return raw.whereType<Map<String, dynamic>>().toList();
  }

  Map<String, dynamic>? get sel {
    final list = channels;
    if (list.isEmpty) return null;
    final want = selectedId ?? list.first['id'];
    for (final c in list) {
      if (c['id'] == want) return c;
    }
    return list.first;
  }

  Map<String, dynamic> get dmon => ((st?['daemon'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();
  Map<String, dynamic> get trs => ((st?['trayStatus'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();

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
    final rec = ui.PictureRecorder();
    final cv = Canvas(rec);
    cv.drawRRect(
        RRect.fromRectAndRadius(const Rect.fromLTWH(0, 0, 32, 32), const Radius.circular(7)), Paint()..color = kAccent);
    cv.drawCircle(const Offset(16, 16), 8, Paint()..color = Colors.white);
    cv.drawCircle(const Offset(16, 16), 4.5, Paint()..color = kAccent);
    final img = await rec.endRecording().toImage(32, 32);
    final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
    final dir = Directory.systemTemp.createTempSync('oct_shell');
    final f = File(dir.path + Platform.pathSeparator + 'oct-tray.png');
    await f.writeAsBytes(bytes!.buffer.asUint8List());
    return f.path;
  }

  void loadSettingsOnce() {
    if (settingLoaded || st == null) return;
    final d = ((st?['defaults'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();
    ttlCtrl.text = (d['ttl'] ?? '1h').toString();
    gwCtrl.text = (d['gatewayStart'] ?? 18080).toString();
    rlCtrl.text = (d['rateLimit'] ?? 0).toString();
    settingLoaded = true;
  }

  Future<void> refresh() async {
    final s = await widget.core.state();
    if (!mounted) return;
    setState(() {
      online = s != null;
      if (s != null) st = s;
      loadSettingsOnce();
    });
  }

  Future<void> refreshLog() async {
    if (page != 0) return;
    final c = sel;
    if (c == null) return;
    final t = await widget.core.logOf(c['id'] as String);
    if (!mounted) return;
    setState(() => logText = t.length > 8000 ? t.substring(t.length - 8000) : t);
  }

  Future<void> act(String action, {String? id}) async {
    final body = <String, dynamic>{'action': action};
    if (id != null) body['id'] = id;
    final r = await widget.core.postJson('/api/action', body);
    if (!mounted) return;
    setState(() => busMsg = (r != null && r['error'] != null) ? ('失败: ' + r['error'].toString()) : ('完成: ' + action));
    await refresh();
  }

  Future<void> updateAction(String a) async {
    final r = await widget.core.postJson('/api/update', <String, dynamic>{'action': a});
    if (!mounted) return;
    setState(() => busMsg = (r != null && r['error'] != null) ? ('失败: ' + r['error'].toString()) : ('更新: ' + a));
    await refresh();
  }

  Color dotColor(Map<String, dynamic> c) {
    if (c['running'] == true) return kOk;
    final e = c['error'];
    if (e is String && e.isNotEmpty) return kErr;
    return const Color(0xFF6B7280);
  }

  String targetText(Map<String, dynamic> c) {
    final t = c['target'];
    if (t is String && t.isNotEmpty) return t;
    return '127.0.0.1:' + (c['port'] ?? '').toString();
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
      await widget.core.postJson('/api/action', <String, dynamic>{'action': 'stopAll'});
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
      await widget.core.postJson('/api/action', <String, dynamic>{'action': 'stopAll'});
      await trayManager.destroy();
      await windowManager.destroy();
      return;
    }
    if (item.key == 'startAll') await act('startAll');
    if (item.key == 'stopAll') await act('stopAll');
  }

  Widget card(String title, List<Widget> kids) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 13, 16, 15),
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(color: kCard, border: Border.all(color: kLine), borderRadius: BorderRadius.circular(10)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
        Text(title, style: const TextStyle(fontSize: 12, color: kMuted, letterSpacing: 0.5)),
        const SizedBox(height: 10),
        ...kids,
      ]),
    );
  }

  Widget kv(String k, String v) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: <Widget>[
        SizedBox(width: 110, child: Text(k, style: const TextStyle(fontSize: 12.5, color: kMuted))),
        Expanded(child: SelectableText(v, style: const TextStyle(fontSize: 12.5))),
      ]),
    );
  }

  Widget mono(String text, double h) {
    return Container(
      height: h,
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: const Color(0xFF0B0D11), border: Border.all(color: kLine), borderRadius: BorderRadius.circular(8)),
      child: SingleChildScrollView(
        child: SelectableText(text.isEmpty ? '（暂无输出）' : text,
            style: const TextStyle(fontSize: 11.5, fontFamily: 'monospace', height: 1.5)),
      ),
    );
  }

  Widget field(String label, TextEditingController c, String hint) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
      Text(label, style: const TextStyle(fontSize: 11.5, color: kMuted)),
      const SizedBox(height: 5),
      TextField(
        controller: c,
        style: const TextStyle(fontSize: 13),
        decoration: InputDecoration(
          isDense: true,
          hintText: hint,
          hintStyle: const TextStyle(fontSize: 12, color: Color(0xFF5A6472)),
          contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(6), borderSide: const BorderSide(color: kLine)),
        ),
      ),
    ]);
  }

  Widget switchRow(String label, bool value, void Function(bool) onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: <Widget>[
        Expanded(child: Text(label, style: const TextStyle(fontSize: 13))),
        Switch(value: value, onChanged: onChanged),
      ]),
    );
  }

  Widget channelsPage() {
    final s = sel;
    return Row(children: <Widget>[
      SizedBox(
        width: 288,
        child: Container(
          decoration: const BoxDecoration(border: Border(right: BorderSide(color: kLine))),
          child: ListView(children: <Widget>[
            const Padding(
                padding: EdgeInsets.fromLTRB(14, 12, 14, 6), child: Text('通道', style: TextStyle(color: kMuted, fontSize: 12))),
            for (final c in channels)
              InkWell(
                onTap: () => setState(() => selectedId = c['id'] as String),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                  color: c['id'] == (s == null ? null : s['id']) ? const Color(0xFF1E2530) : null,
                  child: Row(children: <Widget>[
                    Container(width: 8, height: 8, decoration: BoxDecoration(color: dotColor(c), shape: BoxShape.circle)),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
                        Text((c['name'] ?? c['id']).toString(),
                            maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                        const SizedBox(height: 2),
                        Text(targetText(c) + '  →  ' + (((c['url'] ?? '') as String).isEmpty ? '未启动' : c['url'].toString()),
                            maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: kMuted)),
                      ]),
                    ),
                  ]),
                ),
              ),
            if (channels.isEmpty)
              Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                      widget.core.token == null
                          ? '核心在线，但没读到 config.json（拿不到 token）。\n把本程序放到 oct 同目录，或设置环境变量 ONE_CLICK_TUNNEL_DIR。'
                          : '还没有通道。用命令行 oct add 添加。',
                      style: const TextStyle(fontSize: 12, color: kMuted))),
          ]),
        ),
      ),
      Expanded(
        child: s == null
            ? const Center(child: Text('左侧还没有通道', style: TextStyle(color: kMuted)))
            : ListView(padding: const EdgeInsets.all(16), children: <Widget>[
                card('状态', <Widget>[
                  Text(((s['url'] ?? '') as String).isEmpty ? '未启动' : s['url'].toString(),
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 10),
                  Row(children: <Widget>[
                    FilledButton.icon(
                        onPressed: () => act('start', id: s['id'] as String),
                        icon: const Icon(Icons.play_arrow, size: 18),
                        label: const Text('启动')),
                    const SizedBox(width: 8),
                    OutlinedButton.icon(
                        onPressed: () => act('stop', id: s['id'] as String),
                        icon: const Icon(Icons.stop, size: 18),
                        label: const Text('停止')),
                    const SizedBox(width: 8),
                    TextButton.icon(
                      onPressed: () => Clipboard.setData(ClipboardData(
                          text: (s['url'] ?? '').toString() + '  密码: ' + (s['password'] ?? '').toString())),
                      icon: const Icon(Icons.copy, size: 16),
                      label: const Text('复制链接和密码'),
                    ),
                  ]),
                ]),
                card('参数', <Widget>[
                  kv('目标地址', targetText(s)),
                  kv('有效期 TTL', (s['ttl'] ?? '').toString()),
                  kv('隧道类型', s['mode'] == 'named' ? ('命名隧道 · ' + (s['hostname'] ?? '').toString()) : '快速隧道（地址随机）'),
                  kv('访问密码', (s['passwordMode'] == 'fixed' ? '手动固定' : '每次随机') + ' · ' + (s['password'] ?? '').toString()),
                  kv('本地网关', '127.0.0.1:' + (s['gateway'] ?? '').toString()),
                ]),
                card('实时日志', <Widget>[mono(logText, 220)]),
              ]),
      ),
    ]);
  }

  Widget settingsPage() {
    final tray = ((st?['tray'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();
    final mcp = ((st?['mcp'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();
    final up = ((st?['update'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();
    return ListView(padding: const EdgeInsets.all(16), children: <Widget>[
      card('新建通道的默认值', <Widget>[
        Row(children: <Widget>[
          Expanded(child: field('默认 TTL', ttlCtrl, '1h / 30m / forever')),
          const SizedBox(width: 12),
          Expanded(child: field('网关起始端口', gwCtrl, '18080')),
          const SizedBox(width: 12),
          Expanded(child: field('限速(次/分, 0=不限)', rlCtrl, '0')),
        ]),
        const SizedBox(height: 10),
        Row(children: <Widget>[
          FilledButton(
              onPressed: () async {
                final r = await widget.core.postJson('/api/settings', <String, dynamic>{
                  'defaults': <String, dynamic>{
                    'ttl': ttlCtrl.text.trim(),
                    'gatewayStart': int.tryParse(gwCtrl.text.trim()) ?? 18080,
                    'rateLimit': int.tryParse(rlCtrl.text.trim()) ?? 0,
                  },
                });
                if (!mounted) return;
                setState(() => busMsg = (r != null && r['error'] != null) ? ('失败: ' + r['error'].toString()) : '设置已保存');
                await refresh();
              },
              child: const Text('保存设置')),
          const SizedBox(width: 10),
          const Text('密码默认每次随机生成；这些值只影响之后新建的通道。', style: TextStyle(fontSize: 11.5, color: kMuted)),
        ]),
      ]),
      card('集成开关', <Widget>[
        switchRow('托盘图标常驻（Windows）', tray['enabled'] != false, (v) async {
          await widget.core.postJson('/api/settings', <String, dynamic>{'tray': <String, dynamic>{'enabled': v}});
          await refresh();
        }),
        switchRow('MCP 服务（给 AI 客户端用）', mcp['enabled'] == true, (v) async {
          await widget.core.postJson('/api/settings', <String, dynamic>{'mcp': <String, dynamic>{'enabled': v}});
          await refresh();
        }),
        switchRow('自动检查更新', up['enabled'] != false, (v) async {
          await widget.core.postJson('/api/settings', <String, dynamic>{'update': <String, dynamic>{'enabled': v}});
          await refresh();
        }),
        switchRow('自动下载更新包', up['autoDownload'] == true, (v) async {
          await widget.core.postJson('/api/settings', <String, dynamic>{'update': <String, dynamic>{'autoDownload': v}});
          await refresh();
        }),
        const SizedBox(height: 8),
        OutlinedButton(onPressed: () => act('startTray'), child: const Text('立即启动托盘')),
      ]),
      card('运行环境', <Widget>[
        kv('核心版本', (st?['version'] ?? '?').toString()),
        kv('守护进程 pid', (st?['pid'] ?? '?').toString()),
        kv('本地 API 端口', (st?['guiPort'] ?? '?').toString()),
        kv('配置文件', (st?['configFile'] ?? '?').toString()),
        kv('运行时长', humanUptime(dmon['uptimeSec'])),
      ]),
    ]);
  }

  Widget updatePage() {
    final up = ((st?['update'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();
    final when = up['checkedAt'] == null
        ? '从未检查'
        : DateTime.fromMillisecondsSinceEpoch((up['checkedAt'] as num).toInt()).toString();
    final has = up['hasUpdate'] == true;
    final inst = (up['installer'] is Map) ? (up['installer'] as Map) : null;
    final dl = (up['downloaded'] is Map) ? (up['downloaded'] as Map) : null;
    return ListView(padding: const EdgeInsets.all(16), children: <Widget>[
      card('版本', <Widget>[
        kv('当前版本', (up['currentVersion'] ?? st?['version'] ?? '?').toString()),
        kv('最新版本', (up['latestVersion'] ?? '（未检查）').toString()),
        kv('上次检查', when + (up['staleCache'] == true ? '（升级后待重查）' : '')),
        if (up['error'] != null) kv('错误', up['error'].toString()),
        const SizedBox(height: 10),
        Row(children: <Widget>[
          FilledButton(onPressed: () => updateAction('check'), child: const Text('检查更新')),
          const SizedBox(width: 8),
          OutlinedButton(onPressed: has ? () => updateAction('download') : null, child: const Text('下载更新包')),
          const SizedBox(width: 8),
          OutlinedButton(onPressed: has ? () => updateAction('install') : null, child: const Text('静默安装')),
          const SizedBox(width: 8),
          TextButton(onPressed: has ? () => updateAction('ignore') : null, child: const Text('忽略此版本')),
        ]),
      ]),
      if (has)
        card('新版本 ' + (up['latestVersion'] ?? '').toString(), <Widget>[
          kv('发布时间', (up['publishedAt'] ?? '?').toString()),
          kv('安装包', inst == null ? '（未提供）' : (inst['name'] ?? '').toString()),
          kv('发布页', (up['htmlUrl'] ?? '').toString()),
          kv('已下载到', dl == null ? '（未下载）' : (dl['path'] ?? '').toString()),
        ]),
    ]);
  }

  Widget aboutPage() {
    final cf = ((st?['cloudflare'] ?? <String, dynamic>{}) as Map).cast<String, dynamic>();
    return ListView(padding: const EdgeInsets.all(16), children: <Widget>[
      card('OCT - One Click Tunnel', <Widget>[
        const Text('把本机或局域网的一个端口，临时或长期映射到公网。', style: TextStyle(fontSize: 13)),
        const SizedBox(height: 10),
        kv('核心版本', (st?['version'] ?? '?').toString()),
        kv('配置文件', (st?['configFile'] ?? '?').toString()),
        kv('项目地址', 'https://github.com/Thunderunruly/one-click-tunnel'),
      ]),
      card('Cloudflare（自定义域名）', <Widget>[
        kv('登录状态', cf['loggedIn'] == true ? '已登录' : '未登录'),
        kv('cloudflared', cf['cloudflared'] == true ? '就绪' : '未就绪'),
        kv('命名隧道', (cf['namedCount'] ?? 0).toString() + ' 条'),
        if (cf['certValidTo'] != null) kv('证书有效期至', cf['certValidTo'].toString()),
        const SizedBox(height: 8),
        const Text('登录 Cloudflare、绑定自定义域名属于一次性流程，先在网页版配置页里做；桌面版这里只显示状态。',
            style: TextStyle(fontSize: 11.5, color: kMuted)),
      ]),
      card('命令行', <Widget>[
        mono('./oct help              全部命令\n./oct daemon start     只起后台守护进程\n./oct list              看通道状态\n./oct add --port 3000   新增一条通道', 130),
      ]),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final tiles = <String>['通道', '设置', '更新', '关于'];
    final live = channels.where((c) => c['running'] == true).length;
    return Scaffold(
      body: Column(children: <Widget>[
        Container(
          height: 46,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: const BoxDecoration(color: kCard, border: Border(bottom: BorderSide(color: kLine))),
          child: Row(children: <Widget>[
            Container(
              width: 24,
              height: 24,
              decoration: BoxDecoration(color: kAccent, borderRadius: BorderRadius.circular(6)),
              child: const Center(
                  child: Text('O', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white, fontSize: 13))),
            ),
            const SizedBox(width: 9),
            const Text('OCT · 一键隧道', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(width: 14),
            Container(width: 8, height: 8, decoration: BoxDecoration(color: online ? kOk : kErr, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Text(online ? ('核心在线 ' + (st?['version'] ?? '').toString()) : '核心离线',
                style: const TextStyle(fontSize: 12, color: kMuted)),
            const Spacer(),
            FilledButton.tonal(onPressed: () => act('startAll'), child: const Text('全部启动')),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: () => act('stopAll'), child: const Text('全部停止')),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: refresh, child: const Text('刷新')),
          ]),
        ),
        Expanded(
          child: Row(children: <Widget>[
            Container(
              width: 132,
              decoration: const BoxDecoration(color: Color(0xFF13161C), border: Border(right: BorderSide(color: kLine))),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[
                const SizedBox(height: 10),
                for (var i = 0; i < tiles.length; i++)
                  InkWell(
                    onTap: () => setState(() => page = i),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      color: page == i ? const Color(0xFF1E2530) : null,
                      child: Row(children: <Widget>[
                        Container(width: 3, height: 16, color: page == i ? kAccent : Colors.transparent),
                        const SizedBox(width: 9),
                        Text(tiles[i], style: TextStyle(fontSize: 13, color: page == i ? Colors.white : kMuted)),
                      ]),
                    ),
                  ),
                const Spacer(),
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text('运行中 ' + live.toString() + ' / ' + channels.length.toString(),
                      style: const TextStyle(fontSize: 11, color: kMuted)),
                ),
              ]),
            ),
            Expanded(
              child: IndexedStack(
                index: page,
                children: <Widget>[channelsPage(), settingsPage(), updatePage(), aboutPage()],
              ),
            ),
          ]),
        ),
        Container(
          height: 26,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: const BoxDecoration(color: kCard, border: Border(top: BorderSide(color: kLine))),
          child: Row(children: <Widget>[
            Text(online ? ('pid ' + (st?['pid'] ?? '?').toString()) : '核心未连接',
                style: const TextStyle(fontSize: 11, color: kMuted)),
            const SizedBox(width: 14),
            Text('运行 ' + humanUptime(dmon['uptimeSec']), style: const TextStyle(fontSize: 11, color: kMuted)),
            const SizedBox(width: 14),
            Text(
                trs['supported'] == false
                    ? '托盘: 不支持'
                    : (trs['running'] == true ? ('托盘: 运行中 (pid ' + (trs['running'] == true ? (trs['pid'] ?? '').toString() : '') + ')') : '托盘: 未运行'),
                style: const TextStyle(fontSize: 11, color: kMuted)),
            const Spacer(),
            Text(busMsg, style: const TextStyle(fontSize: 11, color: kMuted)),
          ]),
        ),
      ]),
    );
  }
}
