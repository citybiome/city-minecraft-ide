using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    public const string Backend = "http://127.0.0.1:8777";
    public const string Home = Backend + "/index.html";

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [STAThread]
    static void Main()
    {
        ServicePointManager.Expect100Continue = false;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        EnsureServer(dir);
        Application.Run(new MainForm(dir));
    }

    /// <summary>只认真正的游戏窗口：java/javaw 进程 + 标题是 Minecraft 开头，排除本 IDE 和浏览器。</summary>
    public static List<IntPtr> GameWindows()
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            int len = GetWindowTextLength(h);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (!title.StartsWith("Minecraft", StringComparison.OrdinalIgnoreCase)) return true;
            if (title.StartsWith("City Minecraft", StringComparison.OrdinalIgnoreCase)) return true;

            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string pname = "";
            try { pname = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
            if (pname != "java" && pname != "javaw") return true;

            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.Right - r.Left) < 400 || (r.Bottom - r.Top) < 300) return true;

            found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool ServerUp()
    {
        try
        {
            using (System.Net.Sockets.TcpClient c = new System.Net.Sockets.TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", 8777, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static string FindPython(string dir)
    {
        string local = Path.Combine(dir, "runtime", "python.exe");
        if (File.Exists(local)) return local;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string p in path.Split(';'))
        {
            if (p.Trim().Length == 0) continue;
            try
            {
                string c = Path.Combine(p.Trim(), "python.exe");
                if (File.Exists(c)) return c;
            }
            catch { }
        }
        return null;
    }

    /// <summary>端口被别的目录的 CityIDE 占着（比如旧安装目录被删了），先把它结束掉。</summary>
    public static void KillStrayServer(string dir)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Backend + "/api/state");
            req.Proxy = null;
            req.Timeout = 1500;
            string body;
            using (WebResponse resp = req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream(), System.Text.Encoding.UTF8))
                body = sr.ReadToEnd();

            System.Text.RegularExpressions.Match mRoot =
                System.Text.RegularExpressions.Regex.Match(body, "\"root\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            System.Text.RegularExpressions.Match mPid =
                System.Text.RegularExpressions.Regex.Match(body, "\"pid\"\\s*:\\s*(\\d+)");
            if (!mRoot.Success) return;

            string root = System.Text.RegularExpressions.Regex.Unescape(mRoot.Groups[1].Value);
            int pid = mPid.Success ? int.Parse(mPid.Groups[1].Value) : 0;

            if (string.Equals(root.TrimEnd('\\'), dir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return;

            if (pid > 0)
            {
                try { Process.GetProcessById(pid).Kill(); } catch { }
            }
            for (int k = 0; k < 25 && ServerUp(); k++) Thread.Sleep(150);
        }
        catch { }
    }

    public static void EnsureServer(string dir)
    {
        if (ServerUp())
        {
            KillStrayServer(dir);
            if (ServerUp()) return;
        }
        string py = FindPython(dir);
        if (py == null) return;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(py, "\"" + Path.Combine(dir, "server.py") + "\"");
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
        }
        catch { }
        for (int i = 0; i < 60 && !ServerUp(); i++) Thread.Sleep(250);
    }
}

class MainForm : Form
{
    private readonly string dir;
    private WebView2 web;
    private System.Windows.Forms.Timer watchdog;
    private System.Windows.Forms.Timer scanner;
    private CoreWebView2Environment sharedEnv;
    private readonly Dictionary<IntPtr, IslandForm> islands = new Dictionary<IntPtr, IslandForm>();

    public MainForm(string dir)
    {
        this.dir = dir;
        Text = "City Minecraft Java IDE";
        Width = 1480;
        Height = 940;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1100, 680);
        BackColor = Color.FromArgb(13, 16, 20);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.FromArgb(13, 16, 20);
        Controls.Add(web);
        Load += OnLoaded;

        watchdog = new System.Windows.Forms.Timer();
        watchdog.Interval = 15000;
        watchdog.Tick += delegate
        {
            if (!Program.ServerUp())
            {
                Program.EnsureServer(dir);
                try { web.CoreWebView2.Reload(); } catch { }
            }
        };
        watchdog.Start();

        scanner = new System.Windows.Forms.Timer();
        scanner.Interval = 800;
        scanner.Tick += delegate { ScanGameWindows(); };
        scanner.Start();

        FormClosed += delegate { CloseAllIslands(); };
    }

    public void ReloadPage()
    {
        try { web.CoreWebView2.Reload(); } catch { }
    }

    private void ScanGameWindows()
    {
        if (sharedEnv == null) return;
        List<IntPtr> alive = Program.GameWindows();

        foreach (IntPtr h in alive)
        {
            if (islands.ContainsKey(h)) continue;
            IslandForm f = new IslandForm(dir, h);
            f.ShowIsland(sharedEnv);
            islands[h] = f;
        }

        foreach (IntPtr h in islands.Keys.ToList())
        {
            if (alive.Contains(h)) continue;
            try { islands[h].CloseIsland(); } catch { }
            islands.Remove(h);
        }
    }

    private void CloseAllIslands()
    {
        foreach (IslandForm f in islands.Values)
        {
            try { f.CloseIsland(); } catch { }
        }
        islands.Clear();
    }

    private async void OnLoaded(object sender, EventArgs e)
    {
        try
        {
            string dataDir = Path.Combine(dir, ".webview2");
            sharedEnv = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await web.EnsureCoreWebView2Async(sharedEnv);
            CoreWebView2Settings st = web.CoreWebView2.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.AreDevToolsEnabled = false;
            st.IsStatusBarEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsZoomControlEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            st.IsSwipeNavigationEnabled = false;
            st.AreDefaultScriptDialogsEnabled = false;

            web.CoreWebView2.WebMessageReceived += delegate (object s, CoreWebView2WebMessageReceivedEventArgs args)
            {
                string msg = "";
                try { msg = args.TryGetWebMessageAsString(); } catch { }
                if (msg == "launched" || msg == "activity")
                {
                    ScanGameWindows();
                    foreach (IslandForm f in islands.Values) f.Pop(msg == "activity");
                }
                else if (msg == "login")
                {
                    AccountForm af = new AccountForm(sharedEnv, this);
                    af.Show(this);
                }
            };

            web.CoreWebView2.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs args)
            {
                args.Handled = true;
                try { Process.Start(args.Uri); } catch { }
            };

            web.CoreWebView2.Navigate(Program.Home);
            ScanGameWindows();
        }
        catch (Exception ex)
        {
            MessageBox.Show("界面初始化失败：" + ex.Message + "\n\n请确认已安装 WebView2 运行时。", "City Minecraft Java IDE");
        }
    }
}

/// <summary>绑定到某一个 Minecraft 窗口的灵动岛：跟着那个窗口走，一个游戏窗口配一个。</summary>
class IslandForm : Form
{
    private const int W_COLLAPSED = 340;
    private const int H_COLLAPSED = 46;
    private const int W_EXPANDED = 920;
    private const int H_EXPANDED = 440;

    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Program.RECT r);

    private readonly string dir;
    private readonly IntPtr gameHwnd;
    private WebView2 web;
    private System.Windows.Forms.Timer tick;
    private bool expanded;
    private bool awaitingGame;
    private DateTime lastActivity = DateTime.Now;
    private bool alive = true;

    private double animT = 1.0;
    private double fromW = W_COLLAPSED, fromH = H_COLLAPSED, toW = W_COLLAPSED, toH = H_COLLAPSED;
    private Point target = new Point(-1, -1);

    public IslandForm(string dir, IntPtr hwnd)
    {
        this.dir = dir;
        this.gameHwnd = hwnd;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(16, 21, 28);
        Size = new Size(W_COLLAPSED, H_COLLAPSED);
        Opacity = 0;

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.FromArgb(16, 21, 28);
        Controls.Add(web);

        tick = new System.Windows.Forms.Timer();
        tick.Interval = 16;
        tick.Tick += delegate { Step(); };
        tick.Start();
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // 不抢游戏焦点
            cp.ExStyle |= 0x00000080; // 不进 Alt+Tab
            return cp;
        }
    }

    public async void ShowIsland(CoreWebView2Environment env)
    {
        try
        {
            if (!Visible) Show();
            await web.EnsureCoreWebView2Async(env);
            CoreWebView2Settings st = web.CoreWebView2.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.AreDevToolsEnabled = false;
            st.IsStatusBarEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsZoomControlEnabled = false;
            st.AreDefaultScriptDialogsEnabled = false;
            web.CoreWebView2.WebMessageReceived += delegate (object s, CoreWebView2WebMessageReceivedEventArgs args)
            {
                string msg = "";
                try { msg = args.TryGetWebMessageAsString(); } catch { }
                if (msg == "toggle") Toggle();
                else if (msg == "busy") lastActivity = DateTime.Now;
            };
            web.CoreWebView2.Navigate(Program.Backend + "/island.html");
            Pop(false);
        }
        catch { alive = false; }
    }

    public void CloseIsland()
    {
        alive = false;
        tick.Stop();
        try { Hide(); } catch { }
        try { Close(); } catch { }
    }

    public void Pop(bool waiting)
    {
        awaitingGame = waiting;
        lastActivity = DateTime.Now;
        if (expanded) Toggle();
        Opacity = 1;
        if (!Visible) Show();
    }

    private void Toggle()
    {
        expanded = !expanded;
        fromW = Width;
        fromH = Height;
        toW = expanded ? W_EXPANDED : W_COLLAPSED;
        toH = expanded ? H_EXPANDED : H_COLLAPSED;
        animT = 0;
        lastActivity = DateTime.Now;
    }

    private void Step()
    {
        if (!alive || !Visible) return;

        if (animT < 1)
        {
            animT = Math.Min(1, animT + 0.075);
            double k = 1 - Math.Pow(1 - animT, 3);
            int w = (int)(fromW + (toW - fromW) * k);
            int h = (int)(fromH + (toH - fromH) * k);
            if (w != Width || h != Height)
            {
                Size = new Size(w, h);
                ApplyRound();
            }
        }

        if (!UpdateTarget()) return;

        int dx = target.X - Left;
        int dy = target.Y - Top;
        if (Math.Abs(dx) > 1 || Math.Abs(dy) > 1)
        {
            Left += (int)(dx * 0.25);
            Top += (int)(dy * 0.25);
        }
        else
        {
            Left = target.X;
            Top = target.Y;
        }
    }

    private bool UpdateTarget()
    {
        if (!IsWindowVisible(gameHwnd) || IsIconic(gameHwnd))
        {
            if (Opacity > 0) Opacity = 0;
            return false;
        }
        if (Opacity < 1) Opacity = 1;

        Program.RECT r;
        if (!GetWindowRect(gameHwnd, out r)) return false;
        int w = r.Right - r.Left;
        target = new Point(r.Left + (w - Width) / 2, r.Top - Height - 10);
        if (target.Y < 0) target = new Point(r.Left + (w - Width) / 2, r.Top + 8);
        return true;
    }

    private void ApplyRound()
    {
        int rd = 16;
        using (GraphicsPath path = new GraphicsPath())
        {
            path.AddArc(0, 0, rd * 2, rd * 2, 180, 90);
            path.AddArc(Width - rd * 2, 0, rd * 2, rd * 2, 270, 90);
            path.AddArc(Width - rd * 2, Height - rd * 2, rd * 2, rd * 2, 0, 90);
            path.AddArc(0, Height - rd * 2, rd * 2, rd * 2, 90, 90);
            path.CloseFigure();
            Region = new Region(path);
        }
    }
}

/// <summary>微软正版登录窗口：登录成功后自动把授权码交给后台换令牌。</summary>
class AccountForm : Form
{
    private const string AuthUrl =
        "https://login.live.com/oauth20_authorize.srf" +
        "?client_id=00000000402b5328" +
        "&scope=service%3A%3Auser.auth.xboxlive.com%3A%3AMBI_SSL" +
        "&response_type=code" +
        "&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf" +
        "&display=touch&locale=zh_CN";

    private readonly CoreWebView2Environment env;
    private readonly MainForm owner;
    private WebView2 web;
    private bool done;

    public AccountForm(CoreWebView2Environment env, MainForm owner)
    {
        this.env = env;
        this.owner = owner;
        Text = "登录 Microsoft 账户";
        Width = 520;
        Height = 760;
        StartPosition = FormStartPosition.CenterParent;
        BackColor = Color.FromArgb(13, 16, 20);

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        Controls.Add(web);
        Load += OnLoaded;
    }

    private async void OnLoaded(object sender, EventArgs e)
    {
        try
        {
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.NavigationStarting += OnNav;
            web.CoreWebView2.Navigate(AuthUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show("登录窗口打不开：" + ex.Message, "登录");
            Close();
        }
    }

    private async void OnNav(object sender, CoreWebView2NavigationStartingEventArgs e)
    {
        string uri = e.Uri ?? "";
        if (done || !uri.StartsWith("https://login.live.com/oauth20_desktop.srf", StringComparison.OrdinalIgnoreCase))
            return;
        done = true;
        e.Cancel = true;

        string code = "";
        int idx = uri.IndexOf("code=", StringComparison.Ordinal);
        if (idx >= 0)
        {
            code = uri.Substring(idx + 5);
            int amp = code.IndexOf('&');
            if (amp >= 0) code = code.Substring(0, amp);
        }
        if (code.Length == 0)
        {
            MessageBox.Show("没有拿到授权码，登录可能被取消。", "登录失败");
            Close();
            return;
        }

        try
        {
            using (HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false }))
            {
                http.Timeout = TimeSpan.FromSeconds(60);
                string json = "{\"code\":\"" + code + "\"}";
                StringContent content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
                string resp = await http.PostAsync(Program.Backend + "/api/account/msa/code", content).Result.Content.ReadAsStringAsync();
                bool ok = resp.Contains("\"ok\":true") || resp.Contains("\"ok\": true");
                if (ok)
                {
                    MessageBox.Show("登录成功，账户信息已保存。", "完成");
                    try { owner.ReloadPage(); } catch { }
                }
                else
                {
                    MessageBox.Show("登录失败：\n" + resp, "登录失败");
                }
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("提交授权码失败：" + ex.Message, "登录失败");
        }
        Close();
    }
}
