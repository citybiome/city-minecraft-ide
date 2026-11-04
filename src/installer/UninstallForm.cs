using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

/// <summary>卸载窗口</summary>
class UninstallForm : Form
{
    const int W = 520, H = 300;
    private string dir;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ReleaseCapture();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    public UninstallForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(W, H);
        BackColor = T.Bg;
        DoubleBuffered = true;
        Text = "卸载 City Minecraft Java IDE";
        Region = new Region(T.Round(new Rectangle(0, 0, W, H), 14));

        dir = Path.GetDirectoryName(Application.ExecutablePath);

        MouseDown += delegate (object s, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && e.Y < 56)
            {
                ReleaseCapture();
                SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
            }
        };
        Paint += delegate (object s, PaintEventArgs e)
        {
            using (Pen pen = new Pen(T.Line))
            using (System.Drawing.Drawing2D.GraphicsPath p = T.Round(new Rectangle(0, 0, W - 1, H - 1), 14))
                e.Graphics.DrawPath(pen, p);
        };

        Label title = new Label();
        title.Text = "卸载 City Minecraft Java IDE";
        title.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
        title.ForeColor = T.Text;
        title.SetBounds(28, 28, 420, 28);
        Controls.Add(title);

        Label msg = new Label();
        msg.Text = "会删除程序文件和快捷方式。\n你的 .minecraft 存档、模组、日志不会被删除。";
        msg.Font = new Font("Microsoft YaHei UI", 9.5f);
        msg.ForeColor = T.Muted;
        msg.SetBounds(28, 76, W - 56, 70);
        Controls.Add(msg);

        Label path = new Label();
        path.Text = dir;
        path.Font = new Font("Consolas", 8.5f);
        path.ForeColor = Color.FromArgb(100, 112, 128);
        path.SetBounds(28, 150, W - 56, 20);
        Controls.Add(path);

        Button yes = T.Flat("卸载", true);
        yes.SetBounds(W - 230, H - 64, 110, 40);
        yes.Click += delegate { DoUninstall(); };
        Controls.Add(yes);

        Button no = T.Flat("取消", false);
        no.SetBounds(W - 110, H - 64, 82, 40);
        no.Click += delegate { Close(); };
        Controls.Add(no);
    }

    private void DoUninstall()
    {
        Registry.Unregister();
        Shortcuts.RemoveAll();
        try
        {
            string bat = Path.Combine(Path.GetTempPath(), "cityide-uninstall.bat");
            File.WriteAllText(bat,
                "@echo off\r\n" +
                "ping -n 3 127.0.0.1 >nul\r\n" +
                "rmdir /s /q \"" + dir + "\"\r\n" +
                "del /q \"" + bat + "\"\r\n", System.Text.Encoding.Default);
            Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + bat + "\"") { CreateNoWindow = true, UseShellExecute = false });
        }
        catch { }
        Close();
    }
}
