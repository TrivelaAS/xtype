using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class StandaloneTrayHelper
{
    private const int ServerPort = 17843;

    // -------------------------------------------------------------------------
    // Dual-File Diagnostic Tracer (exe dir TypedPostX-trace.log + AppData trace.log)
    // -------------------------------------------------------------------------
    private static class TraceLogger
    {
        private static readonly object LogLock = new object();
        private static readonly List<string> RingBuffer = new List<string>();
        private static string exeLogPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "TypedPostX-trace.log");
        private static string dataLogPath = null;

        public static string ExeLogPath { get { return exeLogPath; } }
        public static string DataLogPath { get { return dataLogPath; } }

        public static void Init(string dataDir)
        {
            lock (LogLock)
            {
                if (!string.IsNullOrEmpty(dataDir))
                {
                    Directory.CreateDirectory(dataDir);
                    dataLogPath = Path.Combine(dataDir, "trace.log");
                }
            }
        }

        public static void Log(string source, string message)
        {
            string line = string.Format("[{0}] [{1}] {2}", DateTime.UtcNow.ToString("o"), source ?? "APP", message ?? "");
            lock (LogLock)
            {
                RingBuffer.Add(line);
                if (RingBuffer.Count > 1000) RingBuffer.RemoveAt(0);
                AppendLineSafe(exeLogPath, line);
                if (!string.IsNullOrEmpty(dataLogPath) && !string.Equals(dataLogPath, exeLogPath, StringComparison.OrdinalIgnoreCase))
                {
                    AppendLineSafe(dataLogPath, line);
                }
            }
        }

        private static void AppendLineSafe(string filePath, string line)
        {
            try
            {
                var info = new FileInfo(filePath);
                if (info.Exists && info.Length > 2 * 1024 * 1024)
                {
                    string oldPath = filePath + ".old";
                    if (File.Exists(oldPath)) File.Delete(oldPath);
                    File.Move(filePath, oldPath);
                }
                using (var fs = new FileStream(filePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                using (var sw = new StreamWriter(fs, new UTF8Encoding(false)))
                {
                    sw.WriteLine(line);
                }
            }
            catch
            {
            }
        }

        public static List<string> GetTailLines(int maxLines)
        {
            lock (LogLock)
            {
                if (RingBuffer.Count > 0)
                {
                    int start = Math.Max(0, RingBuffer.Count - maxLines);
                    return RingBuffer.GetRange(start, RingBuffer.Count - start);
                }
            }
            string path = !string.IsNullOrEmpty(dataLogPath) && File.Exists(dataLogPath) ? dataLogPath : exeLogPath;
            var result = new List<string>();
            try
            {
                if (File.Exists(path))
                {
                    string[] all = File.ReadAllLines(path, Encoding.UTF8);
                    int start = Math.Max(0, all.Length - maxLines);
                    for (int i = start; i < all.Length; i++) result.Add(all[i]);
                }
            }
            catch
            {
            }
            return result;
        }

        public static void EnsureLogFileExists()
        {
            lock (LogLock)
            {
                try
                {
                    if (!File.Exists(exeLogPath))
                    {
                        File.WriteAllText(exeLogPath, "", new UTF8Encoding(false));
                    }
                }
                catch
                {
                }
            }
        }
    }

    [STAThread]
    private static void Main()
    {
        bool createdNew;
        using (var mutex = new Mutex(true, "TypedPostX_SingleInstance_Mutex", out createdNew))
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
            Application.Run(new TrayAppContext());
        }
    }

    // -------------------------------------------------------------------------
    // Win32 Native SendInput & Window Inspection
    // -------------------------------------------------------------------------
    private static class NativeInput
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION data;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public KEYBDINPUT keyboard;
            [FieldOffset(0)] public MOUSEINPUT mouse;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort vk, scan;
            public uint flags, time;
            public UIntPtr extra;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx, dy;
            public uint data, flags, time;
            public UIntPtr extra;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int left, top, right, bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct GUIINFO
        {
            public int size;
            public uint flags;
            public IntPtr active, focus, capture, menu, move, caret;
            public RECT rect;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, INPUT[] inputs, int size);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern IntPtr GetThreadDesktop(uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

        public static string GetCurrentDesktopName()
        {
            try
            {
                IntPtr hDesk = GetThreadDesktop(GetCurrentThreadId());
                var sb = new StringBuilder(256);
                int needed;
                if (GetUserObjectInformation(hDesk, 2, sb, sb.Capacity, out needed))
                {
                    return sb.ToString();
                }
            }
            catch
            {
            }
            return "unknown";
        }

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int max);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder text, int max);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int key);

        [DllImport("user32.dll")]
        private static extern short GetKeyState(int key);

        [DllImport("user32.dll")]
        private static extern bool GetGUIThreadInfo(uint thread, ref GUIINFO info);

        [DllImport("user32.dll")]
        private static extern IntPtr GetKeyboardLayout(uint thread);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern short VkKeyScanEx(char ch, IntPtr layout);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr hIcon);

        private static readonly object LockObj = new object();
        private static IntPtr armedWindow = IntPtr.Zero;
        private static string armedProcessName = "";
        private static string currentMarker = null;

        private static string WindowText(IntPtr window)
        {
            var sb = new StringBuilder(1024);
            GetWindowText(window, sb, sb.Capacity);
            return sb.ToString();
        }

        private static string WindowClass(IntPtr window)
        {
            var sb = new StringBuilder(256);
            GetClassName(window, sb, sb.Capacity);
            return sb.ToString();
        }

        private static bool IsSupportedBrowserProcess(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            return name.Equals("chrome", StringComparison.OrdinalIgnoreCase)
                || name.Equals("firefox", StringComparison.OrdinalIgnoreCase);
        }

        private static IntPtr FindMarkedBrowserWindow(string marker, out string procName)
        {
            IntPtr found = IntPtr.Zero;
            string foundProc = "";
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                string title = WindowText(hWnd);
                if (string.IsNullOrEmpty(title) || !title.Contains(marker)) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                try
                {
                    string pname = Process.GetProcessById((int)pid).ProcessName;
                    if (IsSupportedBrowserProcess(pname))
                    {
                        found = hWnd;
                        foundProc = pname;
                        return false;
                    }
                }
                catch
                {
                }
                return true;
            }, IntPtr.Zero);
            procName = foundProc;
            return found;
        }

        public static void Disarm()
        {
            lock (LockObj)
            {
                armedWindow = IntPtr.Zero;
                armedProcessName = "";
                currentMarker = null;
            }
        }

        private static List<string> EnumerateBrowserWindowsSummary()
        {
            var list = new List<string>();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string pname = "";
                try { pname = Process.GetProcessById((int)pid).ProcessName; } catch { }
                if (IsSupportedBrowserProcess(pname))
                {
                    list.Add(string.Format("hWnd=0x{0:X} pid={1} proc={2} class={3} title=\"{4}\"",
                        hWnd.ToInt64(), pid, pname, WindowClass(hWnd), WindowText(hWnd)));
                }
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static void Arm(string marker)
        {
            lock (LockObj)
            {
                Disarm();
                if (marker == null || !Regex.IsMatch(marker, "^TypedPostX:[a-zA-Z0-9-]{16,80}$"))
                {
                    TraceLogger.Log("WIN32", "Arm rejected invalid marker");
                    throw new Exception("Invalid window marker");
                }

                string procName;
                IntPtr fg = GetForegroundWindow();
                uint fgPid = 0;
                if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fgPid);
                string fgProc = "";
                try { if (fgPid != 0) fgProc = Process.GetProcessById((int)fgPid).ProcessName; } catch { }
                TraceLogger.Log("WIN32", string.Format(
                    "Arm(marker={0}) fg=0x{1:X} pid={2} proc={3} class={4} title=\"{5}\"",
                    marker, fg.ToInt64(), fgPid, fgProc, fg != IntPtr.Zero ? WindowClass(fg) : "", fg != IntPtr.Zero ? WindowText(fg) : ""));

                List<string> visibleBrowsers = EnumerateBrowserWindowsSummary();
                TraceLogger.Log("WIN32", visibleBrowsers.Count > 0
                    ? "Visible browser windows (" + visibleBrowsers.Count + "): " + string.Join(" | ", visibleBrowsers.ToArray())
                    : "Visible browser windows: NONE");

                IntPtr target = IntPtr.Zero;
                if (fg != IntPtr.Zero && IsSupportedBrowserProcess(fgProc) && WindowText(fg).Contains(marker))
                {
                    target = fg;
                    procName = fgProc;
                }
                else
                {
                    target = FindMarkedBrowserWindow(marker, out procName);
                    if (target != IntPtr.Zero)
                    {
                        TraceLogger.Log("WIN32", string.Format("Activating marked window hWnd=0x{0:X} proc={1}", target.ToInt64(), procName));
                        ActivateWindow(target);
                        Thread.Sleep(100);
                        IntPtr postFg = GetForegroundWindow();
                        TraceLogger.Log("WIN32", string.Format("After ActivateWindow fg=0x{0:X} title=\"{1}\"",
                            postFg.ToInt64(), postFg != IntPtr.Zero ? WindowText(postFg) : ""));
                    }
                }

                if (target == IntPtr.Zero || GetForegroundWindow() != target || !WindowText(target).Contains(marker))
                {
                    string reason = target == IntPtr.Zero
                        ? "No visible Chrome/Firefox window contains marker in title"
                        : string.Format("Target found (0x{0:X}) but fg=0x{1:X} title=\"{2}\"",
                            target.ToInt64(), GetForegroundWindow().ToInt64(), WindowText(target));
                    TraceLogger.Log("WIN32", "Arm failed: " + reason);
                    throw new Exception("Bring the marked Chrome or Firefox tab to the foreground before typing");
                }

                armedWindow = target;
                armedProcessName = procName;
                currentMarker = marker;
                CheckUnlocked();
                TraceLogger.Log("WIN32", string.Format("Arm succeeded hWnd=0x{0:X} proc={1}", armedWindow.ToInt64(), armedProcessName));
            }
        }

        private static void ActivateWindow(IntPtr target)
        {
            if (IsIconic(target)) ShowWindow(target, 9);
            IntPtr fg = GetForegroundWindow();
            uint fgPid;
            uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
            uint targetPid;
            uint targetThread = GetWindowThreadProcessId(target, out targetPid);
            uint curThread = GetCurrentThreadId();

            bool attachedFg = fgThread != 0 && fgThread != curThread && AttachThreadInput(curThread, fgThread, true);
            bool attachedTarget = targetThread != 0 && targetThread != curThread && AttachThreadInput(curThread, targetThread, true);
            try
            {
                BringWindowToTop(target);
                SetForegroundWindow(target);
            }
            finally
            {
                if (attachedTarget) AttachThreadInput(curThread, targetThread, false);
                if (attachedFg) AttachThreadInput(curThread, fgThread, false);
            }
        }

        public static void Check()
        {
            lock (LockObj)
            {
                CheckUnlocked();
            }
        }

        private static void CheckUnlocked()
        {
            if (armedWindow == IntPtr.Zero) throw new Exception("Keyboard is not armed");
            IntPtr fgNow = GetForegroundWindow();
            string curTitle = WindowText(armedWindow);
            if (fgNow != armedWindow || !curTitle.Contains(currentMarker))
            {
                TraceLogger.Log("WIN32", string.Format(
                    "CheckUnlocked failed: focus/title changed (armed=0x{0:X}, fg=0x{1:X}, marker={2}, title=\"{3}\")",
                    armedWindow.ToInt64(), fgNow.ToInt64(), currentMarker, curTitle));
                Disarm();
                throw new Exception("Window focus changed; typing stopped");
            }
            if ((GetAsyncKeyState(0x1B) & 0x8001) != 0)
            {
                TraceLogger.Log("WIN32", "CheckUnlocked failed: Escape pressed");
                Disarm();
                throw new Exception("Escape pressed; typing stopped");
            }
            int[] modifiers = new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C };
            for (int i = 0; i < modifiers.Length; i++)
            {
                if ((GetAsyncKeyState(modifiers[i]) & 0x8000) != 0)
                {
                    TraceLogger.Log("WIN32", string.Format("CheckUnlocked failed: modifier vk=0x{0:X} held down", modifiers[i]));
                    Disarm();
                    throw new Exception("Release Shift, Ctrl, Alt and Windows keys before typing");
                }
            }

            uint pid;
            uint thread = GetWindowThreadProcessId(armedWindow, out pid);
            var info = new GUIINFO();
            info.size = Marshal.SizeOf(typeof(GUIINFO));
            if (!GetGUIThreadInfo(thread, ref info))
            {
                int err = Marshal.GetLastWin32Error();
                TraceLogger.Log("WIN32", string.Format("CheckUnlocked failed: GetGUIThreadInfo returned false (thread={0}, win32Err={1})", thread, err));
                Disarm();
                throw new Exception("Browser page does not have keyboard focus; typing stopped");
            }

            string focusClass = info.focus != IntPtr.Zero ? WindowClass(info.focus) : "";
            if (armedProcessName.Equals("chrome", StringComparison.OrdinalIgnoreCase))
            {
                if (info.focus != armedWindow && !focusClass.StartsWith("Chrome_", StringComparison.OrdinalIgnoreCase))
                {
                    TraceLogger.Log("WIN32", string.Format(
                        "CheckUnlocked failed: Chrome focus class mismatch (armed=0x{0:X}, info.active=0x{1:X}, info.focus=0x{2:X}, focusClass=\"{3}\")",
                        armedWindow.ToInt64(), info.active.ToInt64(), info.focus.ToInt64(), focusClass));
                    Disarm();
                    throw new Exception("Chrome page does not have keyboard focus; typing stopped");
                }
            }
            else if (info.focus == IntPtr.Zero)
            {
                TraceLogger.Log("WIN32", string.Format(
                    "CheckUnlocked failed: Firefox info.focus=0 (info.active=0x{0:X})", info.active.ToInt64()));
                Disarm();
                throw new Exception("Firefox page does not have keyboard focus; typing stopped");
            }
        }

        private static INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var value = new INPUT();
            value.type = 1;
            value.data.keyboard.vk = vk;
            value.data.keyboard.scan = scan;
            value.data.keyboard.flags = flags;
            return value;
        }

        private static void Emit(List<INPUT> inputs)
        {
            CheckUnlocked();
            uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Count)
            {
                int win32Err = Marshal.GetLastWin32Error();
                TraceLogger.Log("WIN32", string.Format("SendInput rejected input: sent={0} expected={1} win32Err={2}", sent, inputs.Count, win32Err));
                var releases = new List<INPUT>();
                for (int i = 0; i < inputs.Count; i++)
                {
                    if ((inputs[i].data.keyboard.flags & 2) != 0) releases.Add(inputs[i]);
                }
                if (releases.Count > 0)
                {
                    SendInput((uint)releases.Count, releases.ToArray(), Marshal.SizeOf(typeof(INPUT)));
                }
                Disarm();
                throw new Exception("Windows rejected keyboard input; do not run Chrome/Firefox as administrator");
            }
        }

        public static void TypeCharacter(string text)
        {
            lock (LockObj)
            {
                bool valid = !string.IsNullOrEmpty(text) && (
                    (text.Length == 1 && !char.IsSurrogate(text[0])) ||
                    (text.Length == 2 && char.IsSurrogatePair(text, 0))
                );
                if (!valid || (text.Length == 1 && char.IsControl(text[0]) && text != "\n"))
                {
                    throw new Exception("Exactly one valid character or newline is required");
                }

                CheckUnlocked();
                var events = new List<INPUT>();
                if (text == "\n")
                {
                    events.Add(Key(13, 0, 0));
                    events.Add(Key(13, 0, 2));
                    Emit(events);
                    return;
                }

                uint pid;
                IntPtr layout = GetKeyboardLayout(GetWindowThreadProcessId(armedWindow, out pid));
                short mapping = text.Length == 1 ? VkKeyScanEx(text[0], layout) : (short)-1;
                if (mapping != -1 && ((mapping >> 8) & ~1) == 0 && (mapping & 255) >= 0x20)
                {
                    ushort vk = (ushort)(mapping & 255);
                    bool shift = (mapping & 256) != 0;
                    if (vk >= 0x41 && vk <= 0x5A && (GetKeyState(0x14) & 1) != 0) shift = !shift;
                    if (shift) events.Add(Key(0x10, 0, 0));
                    events.Add(Key(vk, 0, 0));
                    events.Add(Key(vk, 0, 2));
                    if (shift) events.Add(Key(0x10, 0, 2));
                }
                else
                {
                    for (int i = 0; i < text.Length; i++)
                    {
                        char ch = text[i];
                        events.Add(Key(0, ch, 4));
                        events.Add(Key(0, ch, 6));
                    }
                }
                Emit(events);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Embedded Job Store, HTTP/WebSocket Broker & State
    // -------------------------------------------------------------------------
    private sealed class ActiveRun
    {
        public string Id;
        public List<string> Chars;
        public int Index;
        public long LastKeyAtMs;
    }

    private sealed class WsClient
    {
        public readonly TcpClient Tcp;
        public readonly Stream Stream;
        public readonly object WriteLock = new object();
        public volatile bool Authenticated;
        public volatile bool Closed;
        public long LastSeenMs;

        public WsClient(TcpClient tcp, Stream stream)
        {
            Tcp = tcp;
            Stream = stream;
            LastSeenMs = Environment.TickCount & int.MaxValue;
        }

        public void SendJson(string jsonText)
        {
            byte[] payload = Encoding.UTF8.GetBytes(jsonText);
            SendFrame(0x1, payload);
        }

        public void SendFrame(byte opcode, byte[] payload)
        {
            if (Closed) return;
            lock (WriteLock)
            {
                if (Closed) return;
                try
                {
                    int len = payload != null ? payload.Length : 0;
                    var header = new List<byte>();
                    header.Add((byte)(0x80 | (opcode & 0x0F)));
                    if (len <= 125)
                    {
                        header.Add((byte)len);
                    }
                    else if (len <= 65535)
                    {
                        header.Add(126);
                        header.Add((byte)((len >> 8) & 0xFF));
                        header.Add((byte)(len & 0xFF));
                    }
                    else
                    {
                        header.Add(127);
                        ulong ulen = (ulong)len;
                        for (int shift = 56; shift >= 0; shift -= 8)
                        {
                            header.Add((byte)((ulen >> shift) & 0xFF));
                        }
                    }

                    byte[] hBytes = header.ToArray();
                    Stream.Write(hBytes, 0, hBytes.Length);
                    if (len > 0) Stream.Write(payload, 0, len);
                    Stream.Flush();
                }
                catch
                {
                    Close();
                }
            }
        }

        public void Close()
        {
            if (Closed) return;
            Closed = true;
            try { SendFrameRawClose(); } catch { }
            try { Tcp.Close(); } catch { }
        }

        private void SendFrameRawClose()
        {
            lock (WriteLock)
            {
                try
                {
                    byte[] closeFrame = new byte[] { 0x88, 0x00 };
                    Stream.Write(closeFrame, 0, closeFrame.Length);
                    Stream.Flush();
                }
                catch
                {
                }
            }
        }
    }

    private sealed class EmbeddedBroker
    {
        private static readonly HashSet<string> ActiveStatuses = new HashSet<string>(
            new string[] { "opening", "typing", "ready", "submitting" }
        );
        private static readonly Regex ChromeOriginRx = new Regex("^chrome-extension://([a-p]{32})$");
        private static readonly Regex FirefoxOriginRx = new Regex("^moz-extension://([0-9a-fA-F-]{36})$");

        private readonly string dataDir;
        private readonly string configPath;
        private readonly string jobsPath;
        private readonly object stateLock = new object();
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
        private readonly Random rng = new Random();

        private Dictionary<string, object> config;
        private List<Dictionary<string, object>> jobs;
        private WsClient client;
        private ActiveRun active;
        private TcpListener listener;
        private volatile bool stopped;

        public event Action StateChanged;
        public event Action<string> ErrorOccurred;

        public EmbeddedBroker(string dataDirectory)
        {
            dataDir = dataDirectory;
            Directory.CreateDirectory(dataDir);
            TraceLogger.Init(dataDir);
            configPath = Path.Combine(dataDir, "config.json");
            jobsPath = Path.Combine(dataDir, "jobs.json");
            LoadConfig();
            LoadJobs();
        }

        public string DataDir { get { return dataDir; } }

        private void EmitStateChanged()
        {
            Action handler = StateChanged;
            if (handler != null) handler();
        }

        private static string NewTokenHex()
        {
            byte[] bytes = new byte[32];
            using (var rngProvider = new RNGCryptoServiceProvider())
            {
                rngProvider.GetBytes(bytes);
            }
            var sb = new StringBuilder(64);
            for (int i = 0; i < bytes.Length; i++) sb.Append(bytes[i].ToString("x2"));
            return sb.ToString();
        }

        private static void AtomicWriteText(string filePath, string content)
        {
            string tmp = filePath + ".tmp." + Process.GetCurrentProcess().Id;
            var utf8NoBom = new UTF8Encoding(false);
            File.WriteAllText(tmp, content, utf8NoBom);
            File.Copy(tmp, filePath, true);
            try { File.Delete(tmp); } catch { }
        }

        private void LoadConfig()
        {
            if (File.Exists(configPath))
            {
                string raw = File.ReadAllText(configPath, Encoding.UTF8).TrimStart('\uFEFF');
                config = serializer.Deserialize<Dictionary<string, object>>(raw);
            }
            if (config == null)
            {
                config = new Dictionary<string, object>();
            }
            string tok = GetStr(config, "token");
            if (string.IsNullOrEmpty(tok) || !Regex.IsMatch(tok, "^[a-f0-9]{64}$"))
            {
                config["token"] = NewTokenHex();
            }
            if (!config.ContainsKey("extensionId")) config["extensionId"] = null;
            if (!config.ContainsKey("expectedAccount")) config["expectedAccount"] = "";
            if (!config.ContainsKey("delayMs")) config["delayMs"] = 100;
            if (!config.ContainsKey("paused")) config["paused"] = false;
            SaveConfig();
        }

        private void SaveConfig()
        {
            AtomicWriteText(configPath, serializer.Serialize(config));
        }

        private void LoadJobs()
        {
            if (File.Exists(jobsPath))
            {
                string raw = File.ReadAllText(jobsPath, Encoding.UTF8).TrimStart('\uFEFF');
                var parsed = serializer.Deserialize<List<Dictionary<string, object>>>(raw);
                jobs = parsed ?? new List<Dictionary<string, object>>();
            }
            else
            {
                jobs = new List<Dictionary<string, object>>();
            }

            string now = DateTime.UtcNow.ToString("o");
            bool hadNeedsAttention = false;
            for (int i = 0; i < jobs.Count; i++)
            {
                string st = GetStr(jobs[i], "status");
                if (ActiveStatuses.Contains(st))
                {
                    jobs[i]["status"] = "needs-attention";
                    jobs[i]["error"] = "Helper restarted during this job. Inspect X before submitting anything again.";
                    jobs[i]["updatedAt"] = now;
                }
                if (GetStr(jobs[i], "status") == "needs-attention") hadNeedsAttention = true;
            }
            if (hadNeedsAttention)
            {
                config["paused"] = true;
                SaveConfig();
            }
            SaveJobs();
        }

        private void SaveJobs()
        {
            AtomicWriteText(jobsPath, serializer.Serialize(jobs));
        }

        public string GetToken()
        {
            lock (stateLock) { return GetStr(config, "token"); }
        }

        public Dictionary<string, object> GetStatusSnapshot()
        {
            lock (stateLock)
            {
                return BuildStatusObject();
            }
        }

        public void TogglePause()
        {
            lock (stateLock)
            {
                bool paused = GetBool(config, "paused");
                if (paused)
                {
                    config["paused"] = false;
                    SaveConfig();
                    NotifyClient();
                    Dispatch();
                }
                else
                {
                    StopActive("Paused by user. Inspect any partial draft before sending a new command.");
                }
            }
            EmitStateChanged();
        }

        public void ClearStoppedJobs()
        {
            lock (stateLock)
            {
                jobs.RemoveAll(delegate(Dictionary<string, object> j)
                {
                    string st = GetStr(j, "status");
                    return st == "needs-attention" || st == "cancelled";
                });
                SaveJobs();
                config["paused"] = false;
                SaveConfig();
                NotifyClient();
                Dispatch();
            }
            EmitStateChanged();
        }

        public void Start()
        {
            TraceLogger.Log("STARTUP", string.Format(
                "OS={0} is64BitProc={1} sessionId={2} desktop=\"{3}\" exeDir=\"{4}\" dataDir=\"{5}\"",
                Environment.OSVersion, Environment.Is64BitProcess, Process.GetCurrentProcess().SessionId,
                NativeInput.GetCurrentDesktopName(), AppDomain.CurrentDomain.BaseDirectory, dataDir));
            listener = new TcpListener(IPAddress.Loopback, ServerPort);
            listener.Start();
            TraceLogger.Log("STARTUP", "Listening on http://127.0.0.1:" + ServerPort);

            var acceptThread = new Thread(AcceptLoop) { IsBackground = true };
            acceptThread.Start();

            var watchdogThread = new Thread(WatchdogLoop) { IsBackground = true };
            watchdogThread.Start();
        }

        public void Shutdown()
        {
            stopped = true;
            lock (stateLock)
            {
                if (active != null)
                {
                    StopActive("Helper stopped during job; inspect X before resubmitting.");
                }
                if (client != null)
                {
                    client.Close();
                    client = null;
                }
            }
            NativeInput.Disarm();
            try { if (listener != null) listener.Stop(); } catch { }
        }

        private void AcceptLoop()
        {
            while (!stopped)
            {
                try
                {
                    TcpClient tcp = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(delegate { HandleConnection(tcp); });
                }
                catch
                {
                    if (stopped) break;
                    Thread.Sleep(100);
                }
            }
        }

        private void WatchdogLoop()
        {
            while (!stopped)
            {
                Thread.Sleep(15000);
                if (stopped) break;
                WsClient cur;
                lock (stateLock) { cur = client; }
                if (cur != null && !cur.Closed)
                {
                    long now = Environment.TickCount & int.MaxValue;
                    if (unchecked(now - cur.LastSeenMs) > 45000)
                    {
                        cur.Close();
                    }
                }
            }
        }

        private Dictionary<string, object> PublicConfig()
        {
            var d = new Dictionary<string, object>();
            d["expectedAccount"] = GetStr(config, "expectedAccount") ?? "";
            d["delayMs"] = GetInt(config, "delayMs", 100);
            d["paused"] = GetBool(config, "paused");
            return d;
        }

        private Dictionary<string, object> BuildStatusObject()
        {
            var recent = new List<Dictionary<string, object>>();
            int start = Math.Max(0, jobs.Count - 100);
            for (int i = jobs.Count - 1; i >= start; i--)
            {
                recent.Add(jobs[i]);
            }

            var res = PublicConfig();
            res["name"] = "Typed PostX";
            res["version"] = "1.0.0";
            res["connected"] = client != null && !client.Closed && client.Authenticated;
            res["paired"] = !string.IsNullOrEmpty(GetStr(config, "extensionId"));
            res["activeJob"] = active != null ? active.Id : null;
            res["jobs"] = recent;
            return res;
        }

        private void NotifyClient()
        {
            if (client == null || client.Closed || !client.Authenticated) return;
            var payload = PublicConfig();
            payload["type"] = "status";
            client.SendJson(serializer.Serialize(payload));
        }

        private void Dispatch()
        {
            if (stopped || client == null || client.Closed || !client.Authenticated) return;
            if (active != null || GetBool(config, "paused")) return;
            if (string.IsNullOrEmpty(GetStr(config, "expectedAccount"))) return;

            for (int i = 0; i < jobs.Count; i++)
            {
                if (GetStr(jobs[i], "status") == "queued")
                {
                    Dictionary<string, object> job = jobs[i];
                    job["status"] = "opening";
                    job["updatedAt"] = DateTime.UtcNow.ToString("o");
                    SaveJobs();

                    active = new ActiveRun
                    {
                        Id = GetStr(job, "id"),
                        Chars = SplitCodePoints(GetStr(job, "text") ?? ""),
                        Index = 0,
                        LastKeyAtMs = 0
                    };

                    var msg = new Dictionary<string, object>();
                    msg["type"] = "job";
                    msg["job"] = job;
                    msg["settings"] = PublicConfig();
                    TraceLogger.Log("BROKER", string.Format("Dispatching job id={0} action={1} mode={2} len={3}",
                        active.Id, GetStr(job, "action"), GetStr(job, "mode"), active.Chars.Count));
                    client.SendJson(serializer.Serialize(msg));
                    EmitStateChanged();
                    return;
                }
            }
        }

        private void StopActive(string reason)
        {
            bool wasActive = active != null;
            TraceLogger.Log("BROKER", string.Format("StopActive wasActive={0} reason=\"{1}\"", wasActive, reason));
            config["paused"] = true;
            SaveConfig();
            if (active != null)
            {
                Dictionary<string, object> j = FindJob(active.Id);
                if (j != null)
                {
                    j["status"] = "needs-attention";
                    j["error"] = reason;
                    j["updatedAt"] = DateTime.UtcNow.ToString("o");
                    SaveJobs();
                }
                active = null;
            }
            if (client != null && !client.Closed && client.Authenticated)
            {
                var stopMsg = new Dictionary<string, object>();
                stopMsg["type"] = "stop";
                stopMsg["reason"] = reason;
                client.SendJson(serializer.Serialize(stopMsg));
            }
            NativeInput.Disarm();
            NotifyClient();
            EmitStateChanged();
            if (wasActive && !string.IsNullOrEmpty(reason))
            {
                Action<string> errHandler = ErrorOccurred;
                if (errHandler != null) errHandler(reason);
            }
        }

        private Dictionary<string, object> FindJob(string id)
        {
            for (int i = 0; i < jobs.Count; i++)
            {
                if (GetStr(jobs[i], "id") == id) return jobs[i];
            }
            return null;
        }

        private static List<string> SplitCodePoints(string text)
        {
            var list = new List<string>();
            for (int i = 0; i < text.Length; i++)
            {
                if (char.IsSurrogatePair(text, i))
                {
                    list.Add(text.Substring(i, 2));
                    i++;
                }
                else
                {
                    list.Add(text.Substring(i, 1));
                }
            }
            return list;
        }

        private static string ExtractOriginExtensionId(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return null;
            Match m = ChromeOriginRx.Match(origin);
            if (m.Success) return m.Groups[1].Value;
            m = FirefoxOriginRx.Match(origin);
            return m.Success ? m.Groups[1].Value : null;
        }

        private bool IsOriginAllowed(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return true;
            string extId = ExtractOriginExtensionId(origin);
            if (extId == null) return false;
            string pairedId = GetStr(config, "extensionId");
            return string.IsNullOrEmpty(pairedId) || pairedId == extId;
        }

        private static bool SecureEquals(string a, string b)
        {
            if (a == null || b == null) return false;
            byte[] ba = Encoding.UTF8.GetBytes(a);
            byte[] bb = Encoding.UTF8.GetBytes(b);
            if (ba.Length != bb.Length) return false;
            int diff = 0;
            for (int i = 0; i < ba.Length; i++) diff |= ba[i] ^ bb[i];
            return diff == 0;
        }

        private static bool ReadExact(Stream stream, byte[] buffer, int offset, int count)
        {
            int read = 0;
            while (read < count)
            {
                int n = stream.Read(buffer, offset + read, count - read);
                if (n <= 0) return false;
                read += n;
            }
            return true;
        }

        private static string ReadHttpHeaders(Stream stream, out byte[] leftover)
        {
            var buf = new byte[32768];
            int total = 0;
            while (total < buf.Length)
            {
                int n = stream.Read(buf, total, buf.Length - total);
                if (n <= 0) break;
                total += n;
                for (int i = 0; i <= total - 4; i++)
                {
                    if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n')
                    {
                        int bodyOffset = i + 4;
                        int rem = total - bodyOffset;
                        leftover = new byte[rem];
                        if (rem > 0) Buffer.BlockCopy(buf, bodyOffset, leftover, 0, rem);
                        return Encoding.ASCII.GetString(buf, 0, i);
                    }
                }
            }
            leftover = new byte[0];
            return null;
        }

        private void HandleConnection(TcpClient tcp)
        {
            tcp.NoDelay = true;
            tcp.ReceiveTimeout = 10000;
            tcp.SendTimeout = 10000;
            NetworkStream stream = null;

            try
            {
                stream = tcp.GetStream();
                byte[] leftover;
                string rawHeaders = ReadHttpHeaders(stream, out leftover);
                if (string.IsNullOrEmpty(rawHeaders))
                {
                    tcp.Close();
                    return;
                }

                string[] lines = rawHeaders.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                if (lines.Length == 0)
                {
                    tcp.Close();
                    return;
                }

                string[] reqParts = lines[0].Split(' ');
                if (reqParts.Length < 2)
                {
                    tcp.Close();
                    return;
                }

                string method = reqParts[0].ToUpperInvariant();
                string rawUrl = reqParts[1];
                string pathname = rawUrl.Split('?')[0];

                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < lines.Length; i++)
                {
                    int colon = lines[i].IndexOf(':');
                    if (colon > 0)
                    {
                        string k = lines[i].Substring(0, colon).Trim();
                        string v = lines[i].Substring(colon + 1).Trim();
                        headers[k] = v;
                    }
                }

                string hostHeader;
                headers.TryGetValue("Host", out hostHeader);
                string originHeader;
                headers.TryGetValue("Origin", out originHeader);
                string upgradeHeader;
                headers.TryGetValue("Upgrade", out upgradeHeader);

                string expectedHost = "127.0.0.1:" + ServerPort;
                if (!string.IsNullOrEmpty(hostHeader) && !string.Equals(hostHeader, expectedHost, StringComparison.Ordinal))
                {
                    TraceLogger.Log("HTTP", string.Format("403 {0} {1} bad Host=\"{2}\"", method, pathname, hostHeader));
                    WriteHttpJson(stream, 403, "{\"error\":\"Origin or host is not allowed\"}");
                    tcp.Close();
                    return;
                }
                if (string.IsNullOrEmpty(hostHeader))
                {
                    TraceLogger.Log("HTTP", string.Format("403 {0} {1} missing Host", method, pathname));
                    WriteHttpJson(stream, 403, "{\"error\":\"Origin or host is not allowed\"}");
                    tcp.Close();
                    return;
                }

                if (!string.IsNullOrEmpty(upgradeHeader) && upgradeHeader.Equals("websocket", StringComparison.OrdinalIgnoreCase))
                {
                    HandleWebSocketUpgrade(tcp, stream, pathname, headers, originHeader, leftover);
                    return;
                }

                bool originOk;
                lock (stateLock) { originOk = IsOriginAllowed(originHeader); }
                if (!originOk)
                {
                    TraceLogger.Log("HTTP", string.Format("403 {0} {1} disallowed Origin=\"{2}\"", method, pathname, originHeader ?? ""));
                    WriteHttpJson(stream, 403, "{\"error\":\"Origin or host is not allowed\"}");
                    tcp.Close();
                    return;
                }

                string authHeader;
                headers.TryGetValue("Authorization", out authHeader);
                if (!SecureEquals(authHeader, "Bearer " + GetToken()))
                {
                    TraceLogger.Log("HTTP", string.Format("401 {0} {1} invalid/missing bearer token", method, pathname));
                    WriteHttpJson(stream, 401, "{\"error\":\"A valid bearer token is required\"}");
                    tcp.Close();
                    return;
                }

                string bodyStr = "";
                string contentLenStr;
                int contentLen;
                if (headers.TryGetValue("Content-Length", out contentLenStr) && int.TryParse(contentLenStr, out contentLen) && contentLen > 0)
                {
                    if (contentLen > 131072)
                    {
                        WriteHttpJson(stream, 400, "{\"error\":\"Request too large\"}");
                        tcp.Close();
                        return;
                    }
                    byte[] bodyBytes = new byte[contentLen];
                    int copyNow = Math.Min(leftover.Length, contentLen);
                    if (copyNow > 0) Buffer.BlockCopy(leftover, 0, bodyBytes, 0, copyNow);
                    if (copyNow < contentLen && !ReadExact(stream, bodyBytes, copyNow, contentLen - copyNow))
                    {
                        tcp.Close();
                        return;
                    }
                    bodyStr = Encoding.UTF8.GetString(bodyBytes);
                }

                HandleHttpRequest(stream, method, pathname, bodyStr);
                tcp.Close();
            }
            catch
            {
                try { tcp.Close(); } catch { }
            }
        }

        private static void WriteHttpJson(Stream stream, int code, string jsonBody)
        {
            string reason = code == 200 ? "OK" : code == 201 ? "Created" : code == 400 ? "Bad Request" : code == 401 ? "Unauthorized" : code == 403 ? "Forbidden" : "Not Found";
            byte[] body = Encoding.UTF8.GetBytes(jsonBody);
            string head = string.Format(
                "HTTP/1.1 {0} {1}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {2}\r\nConnection: close\r\n\r\n",
                code, reason, body.Length
            );
            byte[] hBytes = Encoding.ASCII.GetBytes(head);
            stream.Write(hBytes, 0, hBytes.Length);
            stream.Write(body, 0, body.Length);
            stream.Flush();
        }

        private void HandleHttpRequest(Stream stream, string method, string pathname, string bodyStr)
        {
            try
            {
                if (method == "GET" && pathname == "/status")
                {
                    lock (stateLock)
                    {
                        WriteHttpJson(stream, 200, serializer.Serialize(BuildStatusObject()));
                    }
                    return;
                }

                if (method == "GET" && pathname == "/jobs")
                {
                    lock (stateLock)
                    {
                        WriteHttpJson(stream, 200, serializer.Serialize(jobs));
                    }
                    return;
                }

                if (method == "GET" && pathname == "/trace")
                {
                    var traceResp = new Dictionary<string, object>
                    {
                        { "logPath", TraceLogger.DataLogPath },
                        { "exeLogPath", TraceLogger.ExeLogPath },
                        { "lines", TraceLogger.GetTailLines(250) }
                    };
                    WriteHttpJson(stream, 200, serializer.Serialize(traceResp));
                    return;
                }

                if (method == "GET" && pathname.StartsWith("/jobs/"))
                {
                    string id = Uri.UnescapeDataString(pathname.Substring(6));
                    lock (stateLock)
                    {
                        Dictionary<string, object> job = FindJob(id);
                        if (job == null) WriteHttpJson(stream, 404, "{\"error\":\"Job not found\"}");
                        else WriteHttpJson(stream, 200, serializer.Serialize(job));
                    }
                    return;
                }

                Dictionary<string, object> bodyObj = null;
                if (method == "POST")
                {
                    try
                    {
                        bodyObj = serializer.Deserialize<Dictionary<string, object>>(bodyStr);
                    }
                    catch
                    {
                        throw new Exception("Invalid JSON body");
                    }
                    if (bodyObj == null) throw new Exception("Expected a JSON object");
                }

                if (method == "POST" && pathname == "/trace")
                {
                    string src = GetStr(bodyObj, "source") ?? "EXT";
                    string step = GetStr(bodyObj, "step") ?? "";
                    string msgText = GetStr(bodyObj, "message") ?? "";
                    object dataVal = bodyObj.ContainsKey("data") ? bodyObj["data"] : (bodyObj.ContainsKey("details") ? bodyObj["details"] : null);
                    string dataJson = dataVal != null ? " " + serializer.Serialize(dataVal) : "";
                    TraceLogger.Log(src, (step + " " + msgText).Trim() + dataJson);
                    WriteHttpJson(stream, 200, "{\"ok\":true}");
                    return;
                }

                if (method == "POST" && pathname == "/jobs")
                {
                    int code;
                    string jsonResp;
                    lock (stateLock)
                    {
                        bool created;
                        Dictionary<string, object> job = AddJob(bodyObj, out created);
                        code = created ? 201 : 200;
                        jsonResp = serializer.Serialize(job);
                        Dispatch();
                    }
                    EmitStateChanged();
                    WriteHttpJson(stream, code, jsonResp);
                    return;
                }

                if (method == "POST" && pathname == "/settings")
                {
                    string jsonResp;
                    lock (stateLock)
                    {
                        if (active != null) throw new Exception("Pause the queue before changing settings");
                        string rawAcc = bodyObj.ContainsKey("expectedAccount") ? Convert.ToString(bodyObj["expectedAccount"]) : GetStr(config, "expectedAccount");
                        string account = (rawAcc ?? "").TrimStart('@');
                        if (!Regex.IsMatch(account, "^[A-Za-z0-9_]{1,15}$")) throw new Exception("Enter the expected X account handle");
                        double ms = bodyObj.ContainsKey("delayMs") ? Convert.ToDouble(bodyObj["delayMs"]) : GetInt(config, "delayMs", 100);
                        if (double.IsNaN(ms) || double.IsInfinity(ms) || ms < 40 || ms > 2000) throw new Exception("Key interval must be 40-2000 milliseconds");
                        config["expectedAccount"] = account;
                        config["delayMs"] = (int)Math.Round(ms);
                        SaveConfig();
                        NotifyClient();
                        jsonResp = serializer.Serialize(PublicConfig());
                        Dispatch();
                    }
                    EmitStateChanged();
                    WriteHttpJson(stream, 200, jsonResp);
                    return;
                }

                if (method == "POST" && pathname == "/control")
                {
                    string jsonResp;
                    lock (stateLock)
                    {
                        string action = GetStr(bodyObj, "action");
                        if (action == "pause")
                        {
                            StopActive("Paused by user. Inspect any partial draft before sending a new command.");
                        }
                        else if (action == "resume")
                        {
                            config["paused"] = false;
                            SaveConfig();
                            NotifyClient();
                        }
                        else if (action == "retry")
                        {
                            string id = GetStr(bodyObj, "id");
                            Dictionary<string, object> job = FindJob(id);
                            string st = job != null ? GetStr(job, "status") : null;
                            if (job == null || (st != "needs-attention" && st != "cancelled"))
                            {
                                throw new Exception("Only stopped or cancelled jobs can be retried");
                            }
                            job["status"] = "queued";
                            job["error"] = null;
                            job["updatedAt"] = DateTime.UtcNow.ToString("o");
                            SaveJobs();
                            config["paused"] = false;
                            SaveConfig();
                            NotifyClient();
                        }
                        else if (action == "cancel")
                        {
                            string id = GetStr(bodyObj, "id");
                            Dictionary<string, object> job = FindJob(id);
                            if (job == null || GetStr(job, "status") != "queued")
                            {
                                throw new Exception("Only queued jobs can be cancelled; pause an active job instead");
                            }
                            job["status"] = "cancelled";
                            job["updatedAt"] = DateTime.UtcNow.ToString("o");
                            SaveJobs();
                        }
                        else
                        {
                            throw new Exception("Unknown control action");
                        }

                        jsonResp = serializer.Serialize(BuildStatusObject());
                        Dispatch();
                    }
                    EmitStateChanged();
                    WriteHttpJson(stream, 200, jsonResp);
                    return;
                }

                WriteHttpJson(stream, 404, "{\"error\":\"Route not found\"}");
            }
            catch (Exception ex)
            {
                TraceLogger.Log("HTTP", string.Format("400 {0} {1} error=\"{2}\"", method, pathname, ex.Message));
                WriteHttpJson(stream, 400, serializer.Serialize(new Dictionary<string, object> { { "error", ex.Message } }));
            }
        }

        private Dictionary<string, object> NormalizeJob(Dictionary<string, object> input)
        {
            string id = GetStr(input, "id");
            if (string.IsNullOrEmpty(id) || !Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,100}$"))
                throw new Exception("id must contain 1-100 letters, numbers, hyphens or underscores");

            string action = GetStr(input, "action");
            if (action != "NEW-POST" && action != "REPLY-TO" && action != "QUOTE")
                throw new Exception("Unknown action");

            if (!input.ContainsKey("text") || !(input["text"] is string))
                throw new Exception("Text must be valid Unicode, nonempty, and at most 25,000 UTF-16 units");
            string rawText = (string)input["text"];
            if (string.IsNullOrEmpty(rawText.Trim()) || rawText.Length > 25000)
                throw new Exception("Text must be valid Unicode, nonempty, and at most 25,000 UTF-16 units");

            string text = Regex.Replace(rawText, "\r\n?", "\n");
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c != '\n' && ((c >= 0 && c <= 0x1F) || c == 0x7F))
                    throw new Exception("Control characters other than newlines are not supported");
                if (char.IsHighSurrogate(c))
                {
                    if (i + 1 >= text.Length || !char.IsLowSurrogate(text[i + 1]))
                        throw new Exception("Text must be valid Unicode");
                    i++;
                }
                else if (char.IsLowSurrogate(c))
                {
                    throw new Exception("Text must be valid Unicode");
                }
            }

            string mode = input.ContainsKey("mode") && input["mode"] != null ? Convert.ToString(input["mode"]) : "publish";
            if (mode != "publish" && mode != "draft")
                throw new Exception("mode must be publish or draft");

            string url = null;
            string rawUrl = GetStr(input, "url");
            if (action != "NEW-POST")
            {
                Uri parsed;
                if (string.IsNullOrEmpty(rawUrl) || !Uri.TryCreate(rawUrl, UriKind.Absolute, out parsed))
                    throw new Exception("A valid X post URL is required");
                string host = parsed.Host.ToLowerInvariant();
                bool hostOk = host == "x.com" || host == "www.x.com" || host == "twitter.com" || host == "www.twitter.com";
                if (parsed.Scheme != "https" || !hostOk || !string.IsNullOrEmpty(parsed.UserInfo) || !parsed.IsDefaultPort || !Regex.IsMatch(parsed.AbsolutePath, "^/[A-Za-z0-9_]{1,15}/status/\\d+/?$"))
                    throw new Exception("Use an https://x.com/user/status/123 post URL");
                url = "https://x.com" + parsed.AbsolutePath.TrimEnd('/');
            }
            else if (!string.IsNullOrEmpty(rawUrl))
            {
                throw new Exception("NEW-POST does not take a target URL");
            }

            return new Dictionary<string, object>
            {
                { "id", id },
                { "action", action },
                { "url", url },
                { "text", text },
                { "mode", mode }
            };
        }

        private Dictionary<string, object> AddJob(Dictionary<string, object> input, out bool created)
        {
            var normalized = NormalizeJob(input);
            string id = GetStr(normalized, "id");
            Dictionary<string, object> existing = FindJob(id);
            if (existing != null)
            {
                if (serializer.Serialize(NormalizeJob(existing)) != serializer.Serialize(normalized))
                    throw new Exception("Job ID already exists with a different payload");
                created = false;
                return existing;
            }

            if (jobs.Count >= 10000)
                throw new Exception("Job history is full (10,000 jobs)");

            string now = DateTime.UtcNow.ToString("o");
            normalized["status"] = "queued";
            normalized["createdAt"] = now;
            normalized["updatedAt"] = now;
            jobs.Add(normalized);
            SaveJobs();
            created = true;
            return normalized;
        }

        private void HandleWebSocketUpgrade(TcpClient tcp, Stream stream, string pathname, Dictionary<string, string> headers, string originHeader, byte[] leftover)
        {
            string wsKey;
            string originExtId = ExtractOriginExtensionId(originHeader);
            bool originAllowed;
            lock (stateLock) { originAllowed = IsOriginAllowed(originHeader); }

            if (pathname != "/extension" || originExtId == null || !originAllowed || !headers.TryGetValue("Sec-WebSocket-Key", out wsKey))
            {
                byte[] forbidden = Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                stream.Write(forbidden, 0, forbidden.Length);
                tcp.Close();
                return;
            }

            string acceptHash;
            using (var sha1 = SHA1.Create())
            {
                byte[] hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(wsKey.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
                acceptHash = Convert.ToBase64String(hash);
            }

            string upgradeResp = string.Format(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {0}\r\n\r\n",
                acceptHash
            );
            byte[] respBytes = Encoding.ASCII.GetBytes(upgradeResp);
            stream.Write(respBytes, 0, respBytes.Length);
            stream.Flush();

            tcp.ReceiveTimeout = 60000;
            tcp.SendTimeout = 10000;
            var ws = new WsClient(tcp, stream);

            var authTimer = new System.Threading.Timer(delegate
            {
                if (!ws.Authenticated && !ws.Closed) ws.Close();
            }, null, 5000, Timeout.Infinite);

            try
            {
                var readerStream = new BufferedStreamPrefix(stream, leftover);
                var fragBuffer = new MemoryStream();
                while (!stopped && !ws.Closed)
                {
                    byte b0, b1;
                    int first = readerStream.ReadByte();
                    if (first < 0) break;
                    b0 = (byte)first;
                    int second = readerStream.ReadByte();
                    if (second < 0) break;
                    b1 = (byte)second;

                    bool fin = (b0 & 0x80) != 0;
                    int opcode = b0 & 0x0F;
                    bool masked = (b1 & 0x80) != 0;
                    ulong payloadLen = (ulong)(b1 & 0x7F);

                    if (payloadLen == 126)
                    {
                        byte[] ext = new byte[2];
                        if (!ReadExact(readerStream, ext, 0, 2)) break;
                        payloadLen = (ulong)((ext[0] << 8) | ext[1]);
                    }
                    else if (payloadLen == 127)
                    {
                        byte[] ext = new byte[8];
                        if (!ReadExact(readerStream, ext, 0, 8)) break;
                        payloadLen = 0;
                        for (int i = 0; i < 8; i++) payloadLen = (payloadLen << 8) | ext[i];
                    }

                    if (payloadLen > 131072) break;

                    byte[] maskKey = new byte[4];
                    if (masked && !ReadExact(readerStream, maskKey, 0, 4)) break;

                    byte[] payload = new byte[(int)payloadLen];
                    if (payloadLen > 0 && !ReadExact(readerStream, payload, 0, (int)payloadLen)) break;

                    if (masked)
                    {
                        for (int i = 0; i < payload.Length; i++) payload[i] ^= maskKey[i & 3];
                    }

                    ws.LastSeenMs = Environment.TickCount & int.MaxValue;

                    if (opcode == 0x8) break; // Close
                    if (opcode == 0x9) { ws.SendFrame(0xA, payload); continue; } // Ping -> Pong
                    if (opcode == 0xA) continue; // Pong

                    if (opcode == 0x1 || opcode == 0x0)
                    {
                        if (fragBuffer.Length + payload.Length > 131072) break;
                        if (payload.Length > 0) fragBuffer.Write(payload, 0, payload.Length);
                        if (!fin) continue;

                        string textMsg = Encoding.UTF8.GetString(fragBuffer.ToArray());
                        fragBuffer.SetLength(0);
                        ProcessWsMessage(ws, originExtId, textMsg, authTimer);
                    }
                }
            }
            catch
            {
            }
            finally
            {
                authTimer.Dispose();
                ws.Close();
                lock (stateLock)
                {
                    if (client == ws)
                    {
                        client = null;
                        if (active != null)
                        {
                            StopActive("Extension disconnected. Inspect X before resubmitting.");
                        }
                    }
                }
                EmitStateChanged();
            }
        }

        private void ProcessWsMessage(WsClient ws, string originId, string rawText, System.Threading.Timer authTimer)
        {
            Dictionary<string, object> msg;
            try
            {
                msg = serializer.Deserialize<Dictionary<string, object>>(rawText);
            }
            catch
            {
                ws.Close();
                return;
            }
            if (msg == null) { ws.Close(); return; }

            if (!ws.Authenticated)
            {
                string type = GetStr(msg, "type");
                string token = GetStr(msg, "token");
                string msgExtId = GetStr(msg, "extensionId");
                lock (stateLock)
                {
                    string pairedId = GetStr(config, "extensionId");
                    if (type != "auth" || !SecureEquals(token, GetToken()) || msgExtId != originId || (!string.IsNullOrEmpty(pairedId) && pairedId != originId))
                    {
                        TraceLogger.Log("WS", string.Format("Auth rejected origin={0} msgExtId={1} paired={2}", originId, msgExtId, pairedId ?? ""));
                        ws.Close();
                        return;
                    }
                    if (client != null && client != ws)
                    {
                        TraceLogger.Log("WS", "Replacing existing extension socket for " + originId);
                        WsClient prev = client;
                        client = null;
                        prev.Close();
                    }
                    config["extensionId"] = originId;
                    SaveConfig();
                    ws.Authenticated = true;
                    authTimer.Change(Timeout.Infinite, Timeout.Infinite);
                    client = ws;
                    TraceLogger.Log("WS", "Authenticated extension " + originId);

                    var readyMsg = PublicConfig();
                    readyMsg["type"] = "ready";
                    ws.SendJson(serializer.Serialize(readyMsg));
                    Dispatch();
                }
                EmitStateChanged();
                return;
            }

            string mType = GetStr(msg, "type");
            if (mType == "ping")
            {
                ws.SendJson("{\"type\":\"pong\"}");
                return;
            }
            if (mType == "trace")
            {
                string src = GetStr(msg, "source") ?? "EXT";
                string step = GetStr(msg, "step") ?? "";
                string msgText = GetStr(msg, "message") ?? "";
                object dataVal = msg.ContainsKey("data") ? msg["data"] : (msg.ContainsKey("details") ? msg["details"] : null);
                string dataJson = dataVal != null ? " " + serializer.Serialize(dataVal) : "";
                TraceLogger.Log(src, (step + " " + msgText).Trim() + dataJson);
                return;
            }

            string rpcId = GetStr(msg, "id");
            if (mType != "rpc" || string.IsNullOrEmpty(rpcId))
            {
                TraceLogger.Log("WS", "Closing WS due to invalid message type: " + (mType ?? ""));
                ws.Close();
                return;
            }

            var response = new Dictionary<string, object>();
            response["type"] = "result";
            response["id"] = rpcId;
            try
            {
                object rpcResult = ExecuteRpc(msg);
                response["ok"] = true;
                response["result"] = rpcResult;
            }
            catch (Exception ex)
            {
                TraceLogger.Log("RPC", string.Format("RPC failed method={0} jobId={1} error=\"{2}\"",
                    GetStr(msg, "method"), GetStr(msg, "jobId"), ex.Message));
                response["ok"] = false;
                response["error"] = ex.Message;
            }
            ws.SendJson(serializer.Serialize(response));
        }

        private object ExecuteRpc(Dictionary<string, object> message)
        {
            string method = GetStr(message, "method");
            string jobId = GetStr(message, "jobId");
            Dictionary<string, object> args = message.ContainsKey("args") ? message["args"] as Dictionary<string, object> : null;
            if (args == null) args = new Dictionary<string, object>();

            if (method == "key")
            {
                // Run pacing outside stateLock to allow concurrent HTTP reads, then verify active state
                string textChar = GetStr(args, "text");
                ActiveRun runSnapshot;
                int baseDelay;
                lock (stateLock)
                {
                    if (active == null || active.Id != jobId || GetBool(config, "paused"))
                        throw new Exception("Job is not active");
                    Dictionary<string, object> j = FindJob(active.Id);
                    if (j == null || GetStr(j, "status") != "typing")
                        throw new Exception("Operation invalid while " + (j != null ? GetStr(j, "status") : "unknown"));
                    if (active.Index >= active.Chars.Count || textChar != active.Chars[active.Index])
                        throw new Exception("Key does not match next supplied character");
                    runSnapshot = active;
                    baseDelay = GetInt(config, "delayMs", 100);
                }

                // Humanized inter-keystroke pacing + natural punctuation pause
                int targetDelay = (int)Math.Round(baseDelay * (0.7 + rng.NextDouble() * 0.6));
                if (textChar == " ") targetDelay += rng.Next(40, 110);
                else if (textChar == "," || textChar == ";" || textChar == ":") targetDelay += rng.Next(120, 260);
                else if (textChar == "." || textChar == "!" || textChar == "?" || textChar == "\n") targetDelay += rng.Next(220, 480);

                long elapsed = (Environment.TickCount & int.MaxValue) - runSnapshot.LastKeyAtMs;
                if (runSnapshot.LastKeyAtMs != 0 && targetDelay > elapsed)
                {
                    Thread.Sleep((int)(targetDelay - elapsed));
                }

                lock (stateLock)
                {
                    if (active != runSnapshot || GetBool(config, "paused"))
                        throw new Exception("Job stopped");
                    try
                    {
                        NativeInput.TypeCharacter(textChar);
                    }
                    catch (Exception ex)
                    {
                        StopActive(ex.Message);
                        throw;
                    }
                    runSnapshot.Index++;
                    runSnapshot.LastKeyAtMs = Environment.TickCount & int.MaxValue;
                    if (runSnapshot.Index == 1 || runSnapshot.Index % 20 == 0 || runSnapshot.Index == runSnapshot.Chars.Count)
                    {
                        TraceLogger.Log("RPC", string.Format("rpc.key typed {0}/{1} (jobId={2})",
                            runSnapshot.Index, runSnapshot.Chars.Count, jobId));
                    }
                    return new Dictionary<string, object> { { "typed", runSnapshot.Index } };
                }
            }

            if (method == "arm")
            {
                string marker = GetStr(args, "marker");
                TraceLogger.Log("RPC", string.Format("rpc.arm start jobId={0} marker={1}", jobId, marker));
                if (string.IsNullOrEmpty(marker) || !Regex.IsMatch(marker, "^TypedPostX:[a-zA-Z0-9-]{16,80}$"))
                    throw new Exception("Invalid window marker");

                ActiveRun runSnapshot;
                lock (stateLock)
                {
                    if (active == null || active.Id != jobId || GetBool(config, "paused"))
                        throw new Exception("Job is not active");
                    Dictionary<string, object> j = FindJob(active.Id);
                    if (j == null || GetStr(j, "status") != "opening")
                        throw new Exception("Operation invalid while " + (j != null ? GetStr(j, "status") : "unknown"));
                    runSnapshot = active;
                }

                for (int attempt = 1; ; attempt++)
                {
                    try
                    {
                        NativeInput.Arm(marker);
                        break;
                    }
                    catch (Exception ex)
                    {
                        TraceLogger.Log("RPC", string.Format("rpc.arm attempt {0}/15 failed: {1}", attempt, ex.Message));
                        lock (stateLock)
                        {
                            if (attempt >= 15 || active != runSnapshot || GetBool(config, "paused")) throw;
                        }
                        Thread.Sleep(150);
                    }
                }

                lock (stateLock)
                {
                    if (active != runSnapshot || GetBool(config, "paused")) throw new Exception("Job stopped");
                    Dictionary<string, object> j = FindJob(runSnapshot.Id);
                    j["status"] = "typing";
                    j["updatedAt"] = DateTime.UtcNow.ToString("o");
                    SaveJobs();
                    TraceLogger.Log("RPC", "rpc.arm succeeded -> status=typing");
                    return new Dictionary<string, object>();
                }
            }

            lock (stateLock)
            {
                if (active == null || active.Id != jobId || GetBool(config, "paused"))
                    throw new Exception("Job is not active");

                Dictionary<string, object> job = FindJob(active.Id);
                string status = GetStr(job, "status");

                if (method == "ready")
                {
                    if (status != "typing") throw new Exception("Operation invalid while " + status);
                    if (active.Index != active.Chars.Count || GetStr(args, "text") != GetStr(job, "text"))
                        throw new Exception("Typed content does not match supplied text");
                    NativeInput.Check();
                    job["status"] = "ready";
                    job["updatedAt"] = DateTime.UtcNow.ToString("o");
                    SaveJobs();
                    TraceLogger.Log("RPC", "rpc.ready succeeded -> status=ready");
                    return new Dictionary<string, object>();
                }

                if (method == "submit")
                {
                    if (status != "ready") throw new Exception("Operation invalid while " + status);
                    if (GetStr(job, "mode") != "publish") throw new Exception("Draft mode cannot publish");
                    NativeInput.Check();
                    job["status"] = "submitting";
                    job["updatedAt"] = DateTime.UtcNow.ToString("o");
                    SaveJobs();
                    TraceLogger.Log("RPC", "rpc.submit succeeded -> status=submitting");
                    return new Dictionary<string, object>();
                }

                if (method == "complete")
                {
                    if (GetStr(job, "mode") == "draft")
                    {
                        if (status != "ready") throw new Exception("Operation invalid while " + status);
                        job["status"] = "draft-ready";
                        job["updatedAt"] = DateTime.UtcNow.ToString("o");
                        SaveJobs();
                        config["paused"] = true;
                        SaveConfig();
                        TraceLogger.Log("RPC", "rpc.complete (draft) -> status=draft-ready");
                    }
                    else
                    {
                        if (status != "submitting") throw new Exception("Operation invalid while " + status);
                        string resultUrl = GetStr(args, "url") ?? "";
                        Match m = Regex.Match(resultUrl, "^https://x\\.com/([A-Za-z0-9_]{1,15})/status/([0-9]+)$");
                        string expected = GetStr(config, "expectedAccount") ?? "";
                        if (!m.Success || !m.Groups[1].Value.Equals(expected, StringComparison.OrdinalIgnoreCase))
                            throw new Exception("A verified post URL for the expected account is required");
                        string origUrl = GetStr(job, "url");
                        if (!string.IsNullOrEmpty(origUrl) && origUrl.EndsWith("/status/" + m.Groups[2].Value))
                            throw new Exception("Result URL points to the original post");
                        job["status"] = "published";
                        job["resultUrl"] = resultUrl;
                        job["updatedAt"] = DateTime.UtcNow.ToString("o");
                        SaveJobs();
                        TraceLogger.Log("RPC", "rpc.complete (publish) -> status=published url=" + resultUrl);
                    }

                    active = null;
                    NativeInput.Disarm();
                    NotifyClient();
                    EmitStateChanged();
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        Thread.Sleep(500);
                        lock (stateLock) { Dispatch(); }
                    });
                    return new Dictionary<string, object>();
                }

                if (method == "fail")
                {
                    string err = GetStr(args, "error") ?? "Extension stopped the job";
                    if (err.Length > 1000) err = err.Substring(0, 1000);
                    StopActive(err);
                    return new Dictionary<string, object>();
                }

                throw new Exception("Unknown operation");
            }
        }

        private static string GetStr(Dictionary<string, object> map, string key)
        {
            object val;
            return map != null && map.TryGetValue(key, out val) ? val as string : null;
        }

        private static bool GetBool(Dictionary<string, object> map, string key)
        {
            object val;
            return map != null && map.TryGetValue(key, out val) && val is bool && (bool)val;
        }

        private static int GetInt(Dictionary<string, object> map, string key, int fallback)
        {
            object val;
            if (map != null && map.TryGetValue(key, out val) && val != null)
            {
                try { return Convert.ToInt32(val); } catch { }
            }
            return fallback;
        }
    }

    private sealed class BufferedStreamPrefix : Stream
    {
        private readonly Stream inner;
        private readonly byte[] prefix;
        private int prefixPos;

        public BufferedStreamPrefix(Stream innerStream, byte[] prefixBytes)
        {
            inner = innerStream;
            prefix = prefixBytes ?? new byte[0];
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (prefixPos < prefix.Length)
            {
                int avail = Math.Min(count, prefix.Length - prefixPos);
                Buffer.BlockCopy(prefix, prefixPos, buffer, offset, avail);
                prefixPos += avail;
                return avail;
            }
            return inner.Read(buffer, offset, count);
        }
    }

    // -------------------------------------------------------------------------
    // System Tray UI Context
    // -------------------------------------------------------------------------
    private sealed class TrayAppContext : ApplicationContext
    {
        private readonly SynchronizationContext uiContext;
        private readonly EmbeddedBroker broker;
        private readonly NotifyIcon trayIcon;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem copyTokenItem;
        private readonly ToolStripMenuItem toggleQueueItem;
        private readonly ToolStripMenuItem clearStoppedItem;
        private readonly ToolStripMenuItem openTraceItem;
        private readonly ToolStripMenuItem copyTraceItem;
        private readonly ToolStripMenuItem openDataItem;
        private readonly ToolStripMenuItem exitItem;
        private readonly System.Windows.Forms.Timer refreshTimer;

        private IntPtr currentIconHandle = IntPtr.Zero;
        private string currentIconState = "";

        public TrayAppContext()
        {
            uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            string envDir = Environment.GetEnvironmentVariable("TYPED_POSTX_DATA");
            string dataDir = !string.IsNullOrEmpty(envDir)
                ? envDir
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TypedPostX");

            broker = new EmbeddedBroker(dataDir);

            statusItem = new ToolStripMenuItem("Typed PostX: Starting...") { Enabled = false };
            copyTokenItem = new ToolStripMenuItem("Copy Pairing Token", null, OnCopyToken);
            toggleQueueItem = new ToolStripMenuItem("Pause Queue", null, OnToggleQueue);
            clearStoppedItem = new ToolStripMenuItem("Clear Stopped Jobs", null, OnClearStopped);
            openTraceItem = new ToolStripMenuItem("Open Trace Log (TypedPostX-trace.log)", null, OnOpenTrace);
            copyTraceItem = new ToolStripMenuItem("Copy Trace Log to Clipboard", null, OnCopyTrace);
            openDataItem = new ToolStripMenuItem("Open Data Folder", null, OnOpenData);
            exitItem = new ToolStripMenuItem("Exit Typed PostX", null, OnExit);

            var menu = new ContextMenuStrip();
            menu.Items.Add(statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(copyTokenItem);
            menu.Items.Add(toggleQueueItem);
            menu.Items.Add(clearStoppedItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(openTraceItem);
            menu.Items.Add(copyTraceItem);
            menu.Items.Add(openDataItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            trayIcon = new NotifyIcon
            {
                ContextMenuStrip = menu,
                Visible = true,
                Text = "Typed PostX"
            };
            trayIcon.DoubleClick += OnCopyToken;
            UpdateIcon("paused");

            broker.StateChanged += delegate
            {
                uiContext.Post(delegate { RefreshUi(); }, null);
            };
            broker.ErrorOccurred += delegate(string msg)
            {
                uiContext.Post(delegate { trayIcon.ShowBalloonTip(3500, "Typed PostX Stopped", msg, ToolTipIcon.Warning); }, null);
            };

            try
            {
                broker.Start();
            }
            catch (Exception ex)
            {
                UpdateIcon("error");
                MessageBox.Show(
                    "Typed PostX could not listen on 127.0.0.1:17843.\n\n" + ex.Message,
                    "Typed PostX",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                ExitThread();
                return;
            }

            refreshTimer = new System.Windows.Forms.Timer { Interval = 2500 };
            refreshTimer.Tick += delegate { RefreshUi(); };
            refreshTimer.Start();
            RefreshUi();

            trayIcon.ShowBalloonTip(
                2500,
                "Typed PostX Running",
                "Listening on 127.0.0.1:17843. Double-click this icon to copy your pairing token.",
                ToolTipIcon.Info
            );
        }

        private void RefreshUi()
        {
            Dictionary<string, object> s = broker.GetStatusSnapshot();
            bool connected = s.ContainsKey("connected") && s["connected"] is bool && (bool)s["connected"];
            bool paused = s.ContainsKey("paused") && s["paused"] is bool && (bool)s["paused"];
            string account = s.ContainsKey("expectedAccount") ? s["expectedAccount"] as string : "";

            string state;
            string label;
            if (paused)
            {
                state = "paused";
                label = !string.IsNullOrEmpty(account) ? "Typed PostX: Paused (@" + account + ")" : "Typed PostX: Paused";
            }
            else if (connected)
            {
                state = "ready";
                label = !string.IsNullOrEmpty(account) ? "Typed PostX: Ready (@" + account + ")" : "Typed PostX: Ready";
            }
            else
            {
                state = "paused";
                label = "Typed PostX: Waiting for extension";
            }

            statusItem.Text = label;
            toggleQueueItem.Text = paused ? "Resume Queue" : "Pause Queue";
            trayIcon.Text = label.Length > 63 ? label.Substring(0, 63) : label;
            UpdateIcon(state);
        }

        private void UpdateIcon(string state)
        {
            if (currentIconState == state) return;
            currentIconState = state;

            Color dotColor = Color.FromArgb(255, 212, 0);
            if (state == "ready") dotColor = Color.FromArgb(0, 186, 124);
            else if (state == "error") dotColor = Color.FromArgb(244, 33, 46);

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
                trayIcon.Icon = Icon.FromHandle(newHandle);
                if (currentIconHandle != IntPtr.Zero) NativeInput.DestroyIcon(currentIconHandle);
                currentIconHandle = newHandle;
            }
        }

        private void OnCopyToken(object sender, EventArgs e)
        {
            string token = broker.GetToken();
            Clipboard.SetText(token);
            trayIcon.ShowBalloonTip(2500, "Typed PostX", "Pairing token copied to clipboard.", ToolTipIcon.Info);
        }

        private void OnToggleQueue(object sender, EventArgs e)
        {
            broker.TogglePause();
        }

        private void OnClearStopped(object sender, EventArgs e)
        {
            broker.ClearStoppedJobs();
            trayIcon.ShowBalloonTip(2000, "Typed PostX", "Cleared stopped jobs and resumed queue.", ToolTipIcon.Info);
        }

        private void OnOpenTrace(object sender, EventArgs e)
        {
            TraceLogger.EnsureLogFileExists();
            try { Process.Start("notepad.exe", "\"" + TraceLogger.ExeLogPath + "\""); } catch { }
        }

        private void OnCopyTrace(object sender, EventArgs e)
        {
            List<string> lines = TraceLogger.GetTailLines(200);
            if (lines.Count == 0)
            {
                trayIcon.ShowBalloonTip(2000, "Typed PostX", "Trace log is empty.", ToolTipIcon.Info);
                return;
            }
            Clipboard.SetText(string.Join("\r\n", lines.ToArray()));
            trayIcon.ShowBalloonTip(2500, "Typed PostX", string.Format("Copied {0} trace lines to clipboard.", lines.Count), ToolTipIcon.Info);
        }

        private void OnOpenData(object sender, EventArgs e)
        {
            try { Process.Start("explorer.exe", broker.DataDir); } catch { }
        }

        private void OnExit(object sender, EventArgs e)
        {
            if (refreshTimer != null) refreshTimer.Stop();
            trayIcon.Visible = false;
            broker.Shutdown();
            if (currentIconHandle != IntPtr.Zero)
            {
                NativeInput.DestroyIcon(currentIconHandle);
                currentIconHandle = IntPtr.Zero;
            }
            trayIcon.Dispose();
            ExitThread();
        }
    }
}
