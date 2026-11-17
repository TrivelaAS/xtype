using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// No clipboard, paste, browser automation APIs, or text-value mutation.
// Each request can emit at most one Unicode scalar or one Enter key.
internal static class KeyboardHost
{
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GUIINFO { public int size; public uint flags; public IntPtr active, focus, capture, menu, move, caret; public RECT rect; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern short GetKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUIINFO info);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanEx(char ch, IntPtr layout);
    static IntPtr armedWindow = IntPtr.Zero;
    static string marker;
    static bool selfTest;
    static IntPtr testEditor;

    static string WindowText(IntPtr window) { var value = new StringBuilder(1024); GetWindowText(window, value, value.Capacity); return value.ToString(); }
    static string WindowClass(IntPtr window) { var value = new StringBuilder(256); GetClassName(window, value, value.Capacity); return value.ToString(); }
    static void Disarm() { armedWindow = IntPtr.Zero; marker = null; }
    static void Arm(string value)
    {
        Disarm();
        if (value == null || !Regex.IsMatch(value, "^TypedPostX:[a-zA-Z0-9-]{16,80}$")) throw new Exception("Invalid window marker");
        IntPtr window = GetForegroundWindow();
        uint pid; GetWindowThreadProcessId(window, out pid);
        bool expectedProcess = selfTest ? pid == Process.GetCurrentProcess().Id : Process.GetProcessById((int)pid).ProcessName.Equals("chrome", StringComparison.OrdinalIgnoreCase);
        if (!expectedProcess || !WindowText(window).Contains(value)) throw new Exception("Bring the marked Chrome tab to the foreground before typing");
        armedWindow = window; marker = value; Check();
    }
    static void Check()
    {
        if (armedWindow == IntPtr.Zero) throw new Exception("Keyboard is not armed");
        if (GetForegroundWindow() != armedWindow || !WindowText(armedWindow).Contains(marker)) { Disarm(); throw new Exception("Window focus changed; typing stopped"); }
        if ((GetAsyncKeyState(0x1B) & 0x8001) != 0) { Disarm(); throw new Exception("Escape pressed; typing stopped"); }
        foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) { Disarm(); throw new Exception("Release Shift, Ctrl, Alt and Windows keys before typing"); }
        uint pid; uint thread = GetWindowThreadProcessId(armedWindow, out pid);
        var info = new GUIINFO(); info.size = Marshal.SizeOf(typeof(GUIINFO));
        if (!GetGUIThreadInfo(thread, ref info) || (selfTest ? info.focus != testEditor : (info.focus != armedWindow && !WindowClass(info.focus).StartsWith("Chrome_", StringComparison.OrdinalIgnoreCase))))
        { Disarm(); throw new Exception("Chrome page does not have keyboard focus; typing stopped"); }
    }
    static INPUT Key(ushort vk, ushort scan, uint flags)
    {
        var value = new INPUT(); value.type = 1; value.data.keyboard.vk = vk; value.data.keyboard.scan = scan; value.data.keyboard.flags = flags; return value;
    }
    static void Emit(List<INPUT> inputs)
    {
        Check();
        if (SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))) != inputs.Count)
        {
            // Release any keys in this operation if Windows accepted only part of it.
            var releases = new List<INPUT>(); foreach (var input in inputs) if ((input.data.keyboard.flags & 2) != 0) releases.Add(input);
            if (releases.Count > 0) SendInput((uint)releases.Count, releases.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            Disarm(); throw new Exception("Windows rejected keyboard input; do not run Chrome as administrator");
        }
    }
    static void TypeCharacter(string text)
    {
        if (String.IsNullOrEmpty(text) || !(text.Length == 1 && !Char.IsSurrogate(text[0]) || text.Length == 2 && Char.IsSurrogatePair(text, 0)) || (text.Length == 1 && Char.IsControl(text[0]) && text != "\n")) throw new Exception("Exactly one valid character or newline is required");
        Check();
        var events = new List<INPUT>();
        if (text == "\n") { events.Add(Key(13, 0, 0)); events.Add(Key(13, 0, 2)); Emit(events); return; }
        uint pid; var layout = GetKeyboardLayout(GetWindowThreadProcessId(armedWindow, out pid));
        short mapping = text.Length == 1 ? VkKeyScanEx(text[0], layout) : (short)-1;
        // Ctrl/Alt combinations and dead-key sequences use one Unicode key pair,
        // avoiding accidental browser commands and layout-dependent shortcuts.
        if (mapping != -1 && ((mapping >> 8) & ~1) == 0 && (mapping & 255) >= 0x20)
        {
            ushort vk = (ushort)(mapping & 255); bool shift = (mapping & 256) != 0;
            if (vk >= 0x41 && vk <= 0x5A && (GetKeyState(0x14) & 1) != 0) shift = !shift;
            if (shift) events.Add(Key(0x10, 0, 0));
            events.Add(Key(vk, 0, 0)); events.Add(Key(vk, 0, 2));
            if (shift) events.Add(Key(0x10, 0, 2));
        }
        else foreach (char ch in text) { events.Add(Key(0, ch, 4)); events.Add(Key(0, ch, 6)); }
        Emit(events);
    }
    static object Operation(Dictionary<string, object> input)
    {
        string op = input.ContainsKey("op") ? input["op"] as string : null;
        switch (op) {
            case "arm": Arm(input.ContainsKey("marker") ? input["marker"] as string : null); return new { armed = true };
            case "key": TypeCharacter(input.ContainsKey("text") ? input["text"] as string : null); return new { typed = true };
            case "check": Check(); return new { focused = true };
            case "disarm": Disarm(); return new { armed = false };
            default: throw new Exception("Unknown keyboard operation");
        }
    }
    static int SelfTest()
    {
        selfTest = true;
        string sample = "Typed PostX: Hello, æøå ÆØÅ! 👋\nSecond line.";
        string testMarker = "TypedPostX:local-self-test-123456";
        var form = new Form { Text = testMarker, Width = 650, Height = 220, StartPosition = FormStartPosition.CenterScreen };
        var box = new TextBox { Multiline = true, Dock = DockStyle.Fill, AcceptsReturn = true, Font = new System.Drawing.Font("Segoe UI", 14) };
        form.Controls.Add(box);
        int exitCode = 1;
        form.Shown += delegate {
            form.TopMost = true; form.Activate(); SetForegroundWindow(form.Handle); box.Focus(); testEditor = box.Handle;
            var timer = new System.Windows.Forms.Timer { Interval = 700 };
            timer.Tick += delegate {
                timer.Stop();
                try {
                    Arm(testMarker);
                    for (int i = 0; i < sample.Length; i++) {
                        string scalar = Char.IsHighSurrogate(sample[i]) ? sample.Substring(i++, 2) : sample[i].ToString();
                        TypeCharacter(scalar); Application.DoEvents(); Thread.Sleep(25);
                    }
                    Application.DoEvents();
                    if (box.Text.Replace("\r\n", "\n") != sample) throw new Exception("Typed text differs from expected Unicode sample: " + box.Text);
                    form.Text = "Changed focus marker";
                    bool refused = false; try { TypeCharacter("X"); } catch { refused = true; }
                    if (!refused) throw new Exception("Input was not refused after title changed");
                    Console.WriteLine("PASS: real Windows key events, Unicode, emoji, newlines and focus guard"); exitCode = 0;
                } catch (Exception ex) { Console.WriteLine("FAIL: " + ex.Message + " (self-test foreground=" + (GetForegroundWindow() == form.Handle) + ", desktop session=" + Process.GetCurrentProcess().SessionId + ")"); }
                finally { Disarm(); form.Close(); }
            };
            timer.Start();
        };
        Application.Run(form); return exitCode;
    }
    [STAThread] static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
        var serializer = new JavaScriptSerializer { MaxJsonLength = 4096 };
        string line;
        while ((line = Console.ReadLine()) != null) {
            string id = null;
            try {
                if (line.Length > 4096) throw new Exception("Request too large");
                var input = serializer.Deserialize<Dictionary<string, object>>(line);
                id = input.ContainsKey("id") ? input["id"] as string : null;
                var result = Operation(input); Console.WriteLine(serializer.Serialize(new { id = id, ok = true, result = result }));
            } catch (Exception ex) { Console.WriteLine(serializer.Serialize(new { id = id, ok = false, error = ex.Message })); }
        }
        Disarm(); return 0;
    }
}
