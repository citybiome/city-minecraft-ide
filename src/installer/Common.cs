using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Installer
{
    const string AppName = "City Minecraft Java IDE";
    public const string Version = "1.shot1.0";
    public const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CityMinecraftIDE";

    [STAThread]
    static void Main(string[] args)
    {
        string dir = null;
        bool silent = false;
        bool uninstall = false;

        try
        {
            // 安装过程如果出问题，留一个痕迹方便排查
            string log = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "setup.log");
            if (!File.Exists(log)) File.WriteAllText(log, "");
        }
        catch { }
        foreach (string a in args)
        {
            if (a.StartsWith("--dir=")) dir = a.Substring(6).Trim('"');
            else if (a == "--silent" || a == "/S") silent = true;
            else if (a == "--uninstall") uninstall = true;
        }

        if (uninstall)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UninstallForm());
            return;
        }

        if (silent)
        {
            if (dir == null) dir = DefaultDir();
            try
            {
                Payload.ExtractAll(dir);
                Shortcuts.Create(dir, true, true);
                Registry.Register(dir, Version);
            }
            catch (Exception ex)
            {
                try
                {
                    File.WriteAllText(Path.Combine(Path.GetTempPath(), "cityide-install-error.txt"),
                        DateTime.Now + "\r\ndir=" + dir + "\r\n" + ex);
                }
                catch { }
            }
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(dir ?? DefaultDir()));
    }

public static string DefaultDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                            "CityMinecraftIDE");
    }
}

/* ------------------------------------------------------------------ payload */
static class Payload
{
    public static void ExtractAll(string dir, Action<string, int> progress = null)
    {
        Directory.CreateDirectory(dir);
        Assembly asm = Assembly.GetExecutingAssembly();
        string[] names = asm.GetManifestResourceNames();
        string resName = null;
        foreach (string n in names) if (n.EndsWith("payload.zip", StringComparison.OrdinalIgnoreCase)) resName = n;
        using (Stream s = asm.GetManifestResourceStream(resName ?? "payload.zip"))
        {
            if (s == null) throw new Exception("安装包内容损坏（找不到 payload.zip）");
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                int total = zip.Entries.Count;
                int i = 0;
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    i++;
                    string target = Path.Combine(dir, e.FullName.Replace('/', '\\'));
                    if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    e.ExtractToFile(target, true);
                    if (progress != null && i % 5 == 0) progress(e.Name, i * 100 / total);
                }
                if (progress != null) progress("完成", 100);
            }
        }

        // 卸载程序 = 安装包自己
        string self = Assembly.GetExecutingAssembly().Location;
        string uninst = Path.Combine(dir, "Uninstall.exe");
        try { File.Copy(self, uninst, true); } catch { }
    }
}

/* ------------------------------------------------------------------ shortcuts */
static class Shortcuts
{
    static object Shell()
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        return Activator.CreateInstance(t);
    }

    public static void Create(string dir, bool desktop, bool startMenu)
    {
        string target = Path.Combine(dir, "CityIDE.exe");
        if (!File.Exists(target)) return;

        if (desktop)
        {
            string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                                      "City Minecraft Java IDE.lnk");
            Make(lnk, target, dir);
        }
        if (startMenu)
        {
            string sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                                     "City Minecraft Java IDE");
            Directory.CreateDirectory(sm);
            Make(Path.Combine(sm, "City Minecraft Java IDE.lnk"), target, dir);
            Make(Path.Combine(sm, "卸载.lnk"), Path.Combine(dir, "Uninstall.exe"), dir);
        }
    }

    static void Make(string lnkPath, string target, string workdir)
    {
        try
        {
            object shell = Shell();
            object lnk = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod,
                null, shell, new object[] { lnkPath });
            Type lt = lnk.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workdir });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk,
                new object[] { target + ",0" });
            lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { AppName });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }
        catch { }
    }

    public static void RemoveAll()
    {
        try
        {
            string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                                      "City Minecraft Java IDE.lnk");
            if (File.Exists(lnk)) File.Delete(lnk);
            string sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                                     "City Minecraft Java IDE");
            if (Directory.Exists(sm)) Directory.Delete(sm, true);
        }
        catch { }
    }

    const string AppName = "City Minecraft Java IDE";
}

/* ------------------------------------------------------------------ registry */
static class Registry
{
    public static void Register(string dir, string version)
    {
        try
        {
            using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Installer.RegKey))
            {
                if (k == null) return;
                k.SetValue("DisplayName", "City Minecraft Java IDE");
                k.SetValue("DisplayVersion", version);
                k.SetValue("Publisher", "City");
                k.SetValue("InstallLocation", dir);
                k.SetValue("DisplayIcon", Path.Combine(dir, "CityIDE.exe") + ",0");
                k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\" --uninstall");
                k.SetValue("NoModify", 1, Microsoft.Win32.RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, Microsoft.Win32.RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", 20000, Microsoft.Win32.RegistryValueKind.DWord);
            }
        }
        catch { }
    }

    public static void Unregister()
    {
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(Installer.RegKey, false); } catch { }
    }
}

/* ------------------------------------------------------------------ theme */
static class T
{
    public static readonly Color Bg = Color.FromArgb(13, 16, 20);
    public static readonly Color Panel = Color.FromArgb(22, 27, 34);
    public static readonly Color Line = Color.FromArgb(40, 50, 63);
    public static readonly Color Text = Color.FromArgb(219, 227, 238);
    public static readonly Color Muted = Color.FromArgb(127, 139, 156);
    public static readonly Color Accent = Color.FromArgb(79, 140, 255);
    public static readonly Color Accent2 = Color.FromArgb(47, 106, 224);

    public static GraphicsPath Round(Rectangle r, int radius)
    {
        GraphicsPath p = new GraphicsPath();
        int d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static Button Flat(string text, bool primary)
    {
        Button b = new Button();
        b.Text = text;
        b.FlatStyle = FlatStyle.Flat;
        b.FlatAppearance.BorderSize = primary ? 0 : 1;
        b.FlatAppearance.BorderColor = Line;
        b.BackColor = primary ? Accent : Panel;
        b.ForeColor = primary ? Color.White : Text;
        b.Font = new Font("Microsoft YaHei UI", 10f, primary ? FontStyle.Bold : FontStyle.Regular);
        b.Cursor = Cursors.Hand;
        b.Height = 38;
        b.Width = 110;
        return b;
    }
}
