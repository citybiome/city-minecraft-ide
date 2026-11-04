using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading;
using System.Windows.Forms;

/// <summary>安装向导：欢迎 → 进度 → 完成</summary>
class SetupForm : Form
{
    const int W = 660, H = 460;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ReleaseCapture();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    private string installDir;
    private int step = 0;

    private TextBox pathBox;
    private CheckBox cbDesktop, cbStart, cbRun;
    private Button btnMain, btnCancel;
    private Label lblTip;
    private int progress;
    private bool closeHot;
    private string progressText = "";

    public SetupForm(string dir)
    {
        installDir = dir;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(W, H);
        BackColor = T.Bg;
        DoubleBuffered = true;
        Text = "安装 City Minecraft Java IDE";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        BuildWelcome();
        MouseDown += DragWindow;
        Paint += OnPaint;
        Region = new Region(T.Round(new Rectangle(0, 0, W, H), 16));
    }


    private void BuildClose()
    {
        Label x = new Label();
        x.Text = "✕";
        x.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
        x.ForeColor = Color.FromArgb(230, 238, 250);
        x.BackColor = Color.Transparent;
        x.TextAlign = ContentAlignment.MiddleCenter;
        x.SetBounds(W - 46, 12, 32, 32);
        x.Cursor = Cursors.Hand;
        x.MouseEnter += delegate { x.ForeColor = Color.White; };
        x.MouseLeave += delegate { x.ForeColor = Color.FromArgb(230, 238, 250); };
        x.Click += delegate { Close(); };
        Controls.Add(x);
        x.BringToFront();
    }

    private void DragWindow(object s, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        if (e.X > W - 58 && e.Y < 54)
        {
            Close();
            return;
        }
        if (e.Y < 60)
        {
            ReleaseCapture();
            SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        bool hot = e.X > W - 58 && e.Y < 54;
        if (hot != closeHot) { closeHot = hot; Cursor = hot ? Cursors.Hand : Cursors.Default; Invalidate(); }
    }

    private void OnPaint(object s, PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (LinearGradientBrush b = new LinearGradientBrush(new Rectangle(0, 0, W, 74), T.Accent2, T.Accent, 0f))
            g.FillRectangle(b, 0, 0, W, 74);

        try
        {
            Icon ic = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (ic != null) g.DrawIcon(ic, new Rectangle(22, 17, 40, 40));
        }
        catch { }

        using (Font f = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold))
        using (SolidBrush br = new SolidBrush(Color.White))
            g.DrawString("City Minecraft Java IDE", f, br, 76, 20);
        using (Font f = new Font("Microsoft YaHei UI", 9f))
        using (SolidBrush br = new SolidBrush(Color.FromArgb(225, 235, 255)))
            g.DrawString("安装程序 · v" + Installer.Version, f, br, 78, 46);

        using (Font f = new Font("Segoe UI", 11f, FontStyle.Bold))
        using (SolidBrush br = new SolidBrush(closeHot ? Color.White : Color.FromArgb(225, 235, 255)))
            g.DrawString("✕", f, br, W - 44, 18);

        if (step == 1)
        {
            Rectangle bar = new Rectangle(40, 300, W - 120, 10);
            using (GraphicsPath p = T.Round(bar, 5))
            using (SolidBrush bg = new SolidBrush(Color.FromArgb(30, 38, 48)))
                g.FillPath(bg, p);
            if (progress > 0)
            {
                Rectangle fill = new Rectangle(bar.X, bar.Y, Math.Max(6, bar.Width * progress / 100), bar.Height);
                using (GraphicsPath p = T.Round(fill, 5))
                using (LinearGradientBrush b = new LinearGradientBrush(fill, T.Accent, T.Accent2, 0f))
                    g.FillPath(b, p);
            }
        }

        using (Pen pen = new Pen(T.Line))
        using (GraphicsPath p = T.Round(new Rectangle(0, 0, W - 1, H - 1), 16))
            g.DrawPath(pen, p);
    }

    private void BuildWelcome()
    {
        Controls.Clear();

        Label head = new Label();
        head.Text = "选择安装位置";
        head.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
        head.ForeColor = T.Text;
        head.SetBounds(40, 104, 400, 26);
        Controls.Add(head);

        Label sub = new Label();
        sub.Text = "装到当前用户目录，不需要管理员权限。";
        sub.Font = new Font("Microsoft YaHei UI", 9f);
        sub.ForeColor = T.Muted;
        sub.SetBounds(40, 132, 560, 20);
        Controls.Add(sub);

        Panel pathWrap = new Panel();
        pathWrap.SetBounds(40, 166, W - 190, 36);
        pathWrap.BackColor = T.Panel;
        pathWrap.Region = new Region(T.Round(new Rectangle(0, 0, W - 190, 36), 8));
        pathWrap.Paint += delegate (object s2, PaintEventArgs e2)
        {
            using (Pen pen = new Pen(T.Line))
            using (System.Drawing.Drawing2D.GraphicsPath p2 = T.Round(new Rectangle(0, 0, pathWrap.Width - 1, pathWrap.Height - 1), 8))
                e2.Graphics.DrawPath(pen, p2);
        };
        Controls.Add(pathWrap);

        pathBox = new TextBox();
        pathBox.Text = installDir;
        pathBox.BorderStyle = BorderStyle.None;
        pathBox.BackColor = T.Panel;
        pathBox.ForeColor = T.Text;
        pathBox.Font = new Font("Consolas", 9.5f);
        pathBox.SetBounds(10, 9, pathWrap.Width - 20, 20);
        pathWrap.Controls.Add(pathBox);

        Button browse = T.Flat("浏览…", false);
        browse.SetBounds(W - 140, 166, 100, 36);
        Round(browse, 10);
        browse.Click += delegate
        {
            FolderBrowserDialog d = new FolderBrowserDialog();
            d.SelectedPath = installDir;
            if (d.ShowDialog() == DialogResult.OK) { pathBox.Text = d.SelectedPath; }
        };
        Controls.Add(browse);

        cbDesktop = Check("创建桌面快捷方式", 220, true);
        cbStart = Check("添加到开始菜单", 254, true);
        cbRun = Check("安装完成后立即启动", 288, true);

        Label need = new Label();
        need.Text = "需要 Windows 10 及以上，自带 WebView2 运行时和 Python，不用另外装。";
        need.Font = new Font("Microsoft YaHei UI", 8.5f);
        need.ForeColor = T.Muted;
        need.SetBounds(40, 330, 560, 20);
        Controls.Add(need);

        Panel line = new Panel();
        line.SetBounds(34, H - 92, W - 68, 1);
        line.BackColor = T.Line;
        Controls.Add(line);

        btnMain = T.Flat("安装", true);
        btnMain.SetBounds(W - 244, H - 66, 124, 40);
        btnMain.Click += delegate { StartInstall(); };
        Round(btnMain, 10);
        Controls.Add(btnMain);

        btnCancel = T.Flat("取消", false);
        btnCancel.SetBounds(W - 110, H - 66, 86, 40);
        btnCancel.Click += delegate { Close(); };
        Round(btnCancel, 10);
        Controls.Add(btnCancel);

        Invalidate();
    }

    private static void Round(Control c, int radius)
    {
        EventHandler apply = delegate
        {
            if (c.Width > 4 && c.Height > 4)
                c.Region = new Region(T.Round(new Rectangle(0, 0, c.Width, c.Height), radius));
        };
        c.Resize += apply;
        apply(null, EventArgs.Empty);
    }

    private CheckBox Check(string text, int y, bool on)
    {
        CheckBox c = new CheckBox();
        c.Text = text;
        c.ForeColor = T.Text;
        c.Font = new Font("Microsoft YaHei UI", 9.5f);
        c.SetBounds(42, y, 400, 26);
        c.Checked = on;
        Controls.Add(c);
        return c;
    }

    private void StartInstall()
    {
        installDir = pathBox.Text.Trim();
        if (installDir.Length == 0) { MessageBox.Show("请选择安装位置"); return; }

        step = 1;
        Controls.Clear();

        Label title = new Label();
        title.Text = "正在安装…";
        title.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
        title.ForeColor = T.Text;
        title.SetBounds(40, 110, 400, 26);
        Controls.Add(title);

        lblTip = new Label();
        lblTip.Text = "准备中";
        lblTip.Font = new Font("Microsoft YaHei UI", 9f);
        lblTip.ForeColor = T.Muted;
        lblTip.SetBounds(40, 322, W - 80, 22);
        Controls.Add(lblTip);

        Invalidate();

        Thread t = new Thread(delegate ()
        {
            try
            {
                Payload.ExtractAll(installDir, delegate (string name, int pct)
                {
                    BeginInvoke((Action)delegate
                    {
                        progress = pct;
                        lblTip.Text = pct >= 100 ? "写入快捷方式…" : name;
                        Invalidate();
                    });
                });
                Shortcuts.Create(installDir, cbDesktop.Checked, cbStart.Checked);
                Registry.Register(installDir, Installer.Version);
                BeginInvoke((Action)delegate { Finish(cbRun.Checked); });
            }
            catch (Exception ex)
            {
                BeginInvoke((Action)delegate
                {
                    MessageBox.Show("安装失败：" + ex.Message, "安装 City Minecraft Java IDE");
                    Close();
                });
            }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
    }

    private void Finish(bool launch)
    {
        step = 2;
        Controls.Clear();
        Invalidate();

        Label ok = new Label();
        ok.Text = "✓";
        ok.Font = new Font("Segoe UI", 34f, FontStyle.Bold);
        ok.ForeColor = Color.FromArgb(55, 201, 139);
        ok.SetBounds(40, 100, 70, 70);
        Controls.Add(ok);

        Label t1 = new Label();
        t1.Text = "安装完成";
        t1.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
        t1.ForeColor = T.Text;
        t1.SetBounds(112, 112, 400, 30);
        Controls.Add(t1);

        Label t2 = new Label();
        t2.Text = "已安装到：" + installDir;
        t2.Font = new Font("Microsoft YaHei UI", 9f);
        t2.ForeColor = T.Muted;
        t2.SetBounds(112, 146, W - 140, 20);
        Controls.Add(t2);

        Label t3 = new Label();
        t3.Text = "桌面和开始菜单都有快捷方式，随时可以在 Windows 的「应用」里卸载。";
        t3.Font = new Font("Microsoft YaHei UI", 9f);
        t3.ForeColor = T.Muted;
        t3.SetBounds(40, 210, W - 80, 22);
        Controls.Add(t3);

        Button run = T.Flat("立即启动", true);
        Round(run, 10);
        run.SetBounds(W - 244, H - 66, 124, 40);
        run.Click += delegate
        {
            try { Process.Start(Path.Combine(installDir, "CityIDE.exe")); } catch { }
            Close();
        };
        Controls.Add(run);

        Button done = T.Flat("完成", false);
        Round(done, 10);
        done.SetBounds(W - 110, H - 66, 86, 40);
        done.Click += delegate { Close(); };
        Controls.Add(done);

        if (launch)
        {
            try { Process.Start(Path.Combine(installDir, "CityIDE.exe")); } catch { }
            Close();
        }
    }
}
