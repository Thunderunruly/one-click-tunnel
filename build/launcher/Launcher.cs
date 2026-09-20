using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

// one-click-tunnel 无控制台启动器（GUI 子系统小程序）
//   one-click-tunnel.exe              隐藏启动 oct.exe app（桌面窗口 + 托盘）
//   one-click-tunnel.exe --stop-all   隐藏执行 stop --all 与 daemon stop，然后弹提示
//   one-click-tunnel.exe --selfcheck <文件> [--spawn-args "<参数>"]   自检（自动化测试用）
static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string exe = Path.Combine(dir, "oct.exe");
        // 从 1.5.x 升上来的安装目录里还是旧名字，兜底找一下，避免刚更新完快捷方式打不开
        if (!File.Exists(exe)) { string legacy = Path.Combine(dir, "public-tunnel.exe"); if (File.Exists(legacy)) exe = legacy; }
        bool stopAll = false;
        string selfcheck = null;
        string spawnArgs = "app";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--stop-all") stopAll = true;
            else if (args[i] == "--selfcheck" && i + 1 < args.Length) selfcheck = args[++i];
            else if (args[i] == "--spawn-args" && i + 1 < args.Length) spawnArgs = args[++i];
        }
        StringBuilder log = new StringBuilder();
        log.AppendLine("DIR=" + dir);
        log.AppendLine("EXE=" + exe);
        log.AppendLine("EXISTS=" + (File.Exists(exe) ? "1" : "0"));

        if (!File.Exists(exe))
        {
            if (selfcheck != null) { File.WriteAllText(selfcheck, log.ToString(), Encoding.UTF8); return 2; }
            MessageBox.Show("找不到 oct.exe：" + Environment.NewLine + exe,
                "one-click-tunnel", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        if (stopAll)
        {
            RunHidden(exe, "stop --all", log, selfcheck != null);
            RunHidden(exe, "daemon stop", log, selfcheck != null);
            if (selfcheck != null) { File.WriteAllText(selfcheck, log.ToString(), Encoding.UTF8); return 0; }
            MessageBox.Show("已关闭所有通道与后台进程。" + Environment.NewLine + "对应的公网地址会变成 Cloudflare 530。",
                "one-click-tunnel", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        if (selfcheck != null)
        {
            string outp = CaptureOutput(exe, spawnArgs);
            log.AppendLine("SPAWN_ARGS=" + spawnArgs);
            log.AppendLine("CHILD_OUTPUT_START");
            log.AppendLine(outp);
            log.AppendLine("CHILD_OUTPUT_END");
            File.WriteAllText(selfcheck, log.ToString(), Encoding.UTF8);
            return 0;
        }

        // 正式路径：ShellExecute + SW_HIDE —— 子进程有自己的（隐藏）控制台，不经过管道，父进程立刻退出
        ProcessStartInfo psi = new ProcessStartInfo(exe, spawnArgs);
        psi.UseShellExecute = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.WorkingDirectory = dir;
        Process.Start(psi);
        return 0;
    }

    static void RunHidden(string exe, string args, StringBuilder log, bool capture)
    {
        try
        {
            if (capture)
            {
                log.AppendLine("RUN " + args + " ->");
                log.AppendLine(CaptureOutput(exe, args));
                return;
            }
            ProcessStartInfo psi = new ProcessStartInfo(exe, args);
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.WorkingDirectory = Path.GetDirectoryName(exe);
            Process p = Process.Start(psi);
            p.WaitForExit(120000);
            log.AppendLine("RUN " + args + " exit=" + p.ExitCode);
        }
        catch (Exception e)
        {
            log.AppendLine("RUN " + args + " error=" + e.Message);
        }
    }

    static string CaptureOutput(string exe, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Path.GetDirectoryName(exe);
            Process p = Process.Start(psi);
            string o = p.StandardOutput.ReadToEnd();
            string e2 = p.StandardError.ReadToEnd();
            p.WaitForExit(120000);
            return (o + e2).Trim();
        }
        catch (Exception e)
        {
            return "ERROR: " + e.Message;
        }
    }
}
