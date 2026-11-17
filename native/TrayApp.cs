using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class TrayApp
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private const int HelperPort = 17843;

    [STAThread]
    private static void Main()
    {
        bool createdNew;
        using (var mutex = new Mutex(true, "TypedPostX_Tray_SingleInstance", out createdNew))
        {
            if (!createdNew)
            {
                MessageBox.Show(
                    "Typed PostX is already running in your Windows system tray.",
                    "Typed PostX",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayContext());
        }
    }

    private sealed class TrayContext : ApplicationContext
    {
        private readonly SynchronizationContext uiContext;
        private readonly string projectRoot;
        private readonly string dataDir;
        private readonly NotifyIcon trayIcon;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem copyTokenItem;
        private readonly ToolStripMenuItem toggleQueueItem;
        private readonly ToolStripMenuItem restartItem;
        private readonly ToolStripMenuItem exitItem;
        private readonly System.Windows.Forms.Timer pollTimer;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();

        private Process helperProcess;
        private IntPtr currentIconHandle = IntPtr.Zero;
        private string currentIconState = "";
        private bool helperPaused;
        private bool helperReachable;
        private int pollInFlight;

        public TrayContext()
        {
            uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            projectRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..\\.."));
            string envDir = Environment.GetEnvironmentVariable("TYPED_POSTX_DATA");
            dataDir = !string.IsNullOrEmpty(envDir)
                ? envDir
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TypedPostX");

            statusItem = new ToolStripMenuItem("Typed PostX: Starting...") { Enabled = false };
            copyTokenItem = new ToolStripMenuItem("Copy Pairing Token", null, OnCopyToken);
            toggleQueueItem = new ToolStripMenuItem("Pause Queue", null, OnToggleQueue) { Enabled = false };
            restartItem = new ToolStripMenuItem("Restart Helper", null, OnRestartHelper);
            exitItem = new ToolStripMenuItem("Exit Typed PostX", null, OnExit);

            var menu = new ContextMenuStrip();
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(copyTokenItem);
            menu.Items.Add(toggleQueueItem);
            menu.Items.Add(restartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            trayIcon = new NotifyIcon
            {
                ContextMenuStrip = menu,
                Visible = true,
                Text = "Typed PostX: Starting..."
            };
            trayIcon.DoubleClick += OnCopyToken;
            UpdateIcon("offline");

            EnsureHelperRunning();

            pollTimer = new System.Windows.Forms.Timer { Interval = 2500 };
            pollTimer.Tick += delegate { TriggerPoll(); };
            pollTimer.Start();
            TriggerPoll();
        }

        private string ReadToken()
        {
            string configPath = Path.Combine(dataDir, "config.json");
            if (!File.Exists(configPath)) return null;
            try
            {
                string raw = File.ReadAllText(configPath, Encoding.UTF8);
                var obj = json.Deserialize<Dictionary<string, object>>(raw);
                object val;
                if (obj != null && obj.TryGetValue("token", out val))
                {
                    return val as string;
                }
            }
            catch
            {
            }
            return null;
        }

        private void EnsureHelperRunning()
        {
            if (IsStatusReachable()) return;

            if (helperProcess != null && !helperProcess.HasExited)
            {
                return;
            }

            string serverScript = Path.Combine(projectRoot, "helper", "server.mjs");
            if (!File.Exists(serverScript)) return;

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = "\"" + serverScript + "\"",
                    WorkingDirectory = projectRoot,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                helperProcess = Process.Start(psi);
            }
            catch
            {
            }
        }

        private void StopOwnedHelper()
        {
            if (helperProcess == null) return;
            try
            {
                if (!helperProcess.HasExited)
                {
                    helperProcess.Kill();
                    helperProcess.WaitForExit(2000);
                }
            }
            catch
            {
            }
            finally
            {
                helperProcess.Dispose();
                helperProcess = null;
            }
        }

        private Dictionary<string, object> RequestJson(string method, string path, string bodyJson)
        {
            string token = ReadToken();
            if (string.IsNullOrEmpty(token)) return null;

            var req = (HttpWebRequest)WebRequest.Create(string.Format("http://127.0.0.1:{0}{1}", HelperPort, path));
            req.Method = method;
            req.Host = string.Format("127.0.0.1:{0}", HelperPort);
            req.Headers["Authorization"] = "Bearer " + token;
            req.Proxy = null;
            req.Timeout = 2000;
            req.ReadWriteTimeout = 2000;

            if (bodyJson != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(bodyJson);
                req.ContentType = "application/json";
                req.ContentLength = bytes.Length;
                using (var stream = req.GetRequestStream())
                {
                    stream.Write(bytes, 0, bytes.Length);
                }
            }

            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                return json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
        }

        private bool IsStatusReachable()
        {
            try
            {
                return RequestJson("GET", "/status", null) != null;
            }
            catch
            {
                return false;
            }
        }

        private void TriggerPoll()
        {
            if (Interlocked.Exchange(ref pollInFlight, 1) == 1) return;

            ThreadPool.QueueUserWorkItem(delegate
            {
                string state = "offline";
                string statusText = "Typed PostX: Offline";
                bool paused = false;
                bool reachable = false;

                try
                {
                    Dictionary<string, object> data = null;
                    try { data = RequestJson("GET", "/status", null); } catch { }

                    if (data == null)
                    {
                        EnsureHelperRunning();
                        Thread.Sleep(400);
                        try { data = RequestJson("GET", "/status", null); } catch { }
                    }

                    if (data != null)
                    {
                        reachable = true;
                        bool connected = GetBool(data, "connected");
                        paused = GetBool(data, "paused");
                        string account = GetString(data, "expectedAccount");

                        if (paused)
                        {
                            state = "paused";
                            statusText = !string.IsNullOrEmpty(account)
                                ? "Typed PostX: Paused (@" + account + ")"
                                : "Typed PostX: Paused";
                        }
                        else if (connected)
                        {
                            state = "ready";
                            statusText = !string.IsNullOrEmpty(account)
                                ? "Typed PostX: Ready (@" + account + ")"
                                : "Typed PostX: Ready";
                        }
                        else
                        {
                            state = "paused";
                            statusText = "Typed PostX: Waiting for extension";
                        }
                    }
                }
                finally
                {
                    Interlocked.Exchange(ref pollInFlight, 0);
                    uiContext.Post(delegate { ApplyUiState(state, statusText, paused, reachable); }, null);
                }
            });
        }

        private void ApplyUiState(string state, string statusText, bool paused, bool reachable)
        {
            helperPaused = paused;
            helperReachable = reachable;

            statusItem.Text = statusText;
            toggleQueueItem.Enabled = reachable;
            toggleQueueItem.Text = paused ? "Resume Queue" : "Pause Queue";

            string tip = statusText.Length > 63 ? statusText.Substring(0, 63) : statusText;
            trayIcon.Text = tip;
            UpdateIcon(state);
        }

        private static bool GetBool(Dictionary<string, object> map, string key)
        {
            object val;
            return map.TryGetValue(key, out val) && val is bool && (bool)val;
        }

        private static string GetString(Dictionary<string, object> map, string key)
        {
            object val;
            return map.TryGetValue(key, out val) ? val as string : null;
        }

        private void UpdateIcon(string state)
        {
            if (currentIconState == state) return;
            currentIconState = state;

            Color dotColor = Color.FromArgb(244, 33, 46);
            if (state == "ready") dotColor = Color.FromArgb(0, 186, 124);
            else if (state == "paused") dotColor = Color.FromArgb(255, 212, 0);

            using (var bmp = new Bitmap(16, 16))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.FromArgb(24, 24, 27));

                using (var borderPen = new Pen(Color.FromArgb(63, 63, 70), 1f))
                {
                    g.DrawRectangle(borderPen, 0, 0, 15, 15);
                }

                using (var font = new Font("Segoe UI", 7.5f, FontStyle.Bold, GraphicsUnit.Point))
                using (var textBrush = new SolidBrush(Color.White))
                {
                    g.DrawString("Tx", font, textBrush, 0f, 1f);
                }

                using (var dotBrush = new SolidBrush(dotColor))
                {
                    g.FillEllipse(dotBrush, 10, 10, 5, 5);
                }

                IntPtr newHandle = bmp.GetHicon();
                Icon nextIcon = Icon.FromHandle(newHandle);
                trayIcon.Icon = nextIcon;

                if (currentIconHandle != IntPtr.Zero)
                {
                    DestroyIcon(currentIconHandle);
                }
                currentIconHandle = newHandle;
            }
        }

        private void OnCopyToken(object sender, EventArgs e)
        {
            string token = ReadToken();
            if (string.IsNullOrEmpty(token))
            {
                trayIcon.ShowBalloonTip(2500, "Typed PostX", "Pairing token not found yet. Wait a second for helper startup.", ToolTipIcon.Warning);
                return;
            }

            Clipboard.SetText(token);
            trayIcon.ShowBalloonTip(2500, "Typed PostX", "Pairing token copied to clipboard.", ToolTipIcon.Info);
        }

        private void OnToggleQueue(object sender, EventArgs e)
        {
            if (!helperReachable) return;
            string action = helperPaused ? "resume" : "pause";
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { RequestJson("POST", "/control", "{\"action\":\"" + action + "\"}"); } catch { }
                TriggerPoll();
            });
        }

        private void OnRestartHelper(object sender, EventArgs e)
        {
            StopOwnedHelper();
            EnsureHelperRunning();
            TriggerPoll();
            trayIcon.ShowBalloonTip(2000, "Typed PostX", "Helper restarted.", ToolTipIcon.Info);
        }

        private void OnExit(object sender, EventArgs e)
        {
            pollTimer.Stop();
            trayIcon.Visible = false;
            StopOwnedHelper();
            if (currentIconHandle != IntPtr.Zero)
            {
                DestroyIcon(currentIconHandle);
                currentIconHandle = IntPtr.Zero;
            }
            trayIcon.Dispose();
            ExitThread();
        }
    }
}
