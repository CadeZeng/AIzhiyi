// AI智译 · 全局低级钩子（C# 5 / .NET 4，由 win-host.ps1 Add-Type 加载）
// WH_KEYBOARD_LL + WH_MOUSE_LL：取词模式中吞掉修饰键 / 左键 / 滚轮等，不 CallNextHookEx。
// 钩子回调只入队，禁止在回调里做重活，避免卡鼠标。
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class InputGuard
{
    public const int WH_KEYBOARD_LL = 13;
    public const int WH_MOUSE_LL = 14;
    public const int WM_QUIT = 0x0012;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_KEYUP = 0x0101;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int WM_SYSKEYUP = 0x0105;
    public const int WM_MOUSEMOVE = 0x0200;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_LBUTTONUP = 0x0202;
    public const int WM_LBUTTONDBLCLK = 0x0203;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_RBUTTONUP = 0x0205;
    public const int WM_MBUTTONDOWN = 0x0207;
    public const int WM_MBUTTONUP = 0x0208;
    public const int WM_MOUSEWHEEL = 0x020A;
    public const int WM_XBUTTONDOWN = 0x020B;
    public const int WM_XBUTTONUP = 0x020C;
    public const int WM_MOUSEHWHEEL = 0x020E;
    public const int WM_NCXBUTTONDOWN = 0x00AB;

    public const int VK_SHIFT = 0x10;
    public const int VK_CONTROL = 0x11;
    public const int VK_MENU = 0x12;
    public const int VK_ESCAPE = 0x1B;
    public const int VK_LSHIFT = 0xA0;
    public const int VK_RSHIFT = 0xA1;
    public const int VK_LCONTROL = 0xA2;
    public const int VK_RCONTROL = 0xA3;
    public const int VK_LMENU = 0xA4;
    public const int VK_RMENU = 0xA5;

    public const uint LLKHF_UP = 0x80;
    public const uint LLKHF_INJECTED = 0x10;
    public const uint LLMHF_INJECTED = 0x01;

    private static LowLevelProc _kProc;
    private static LowLevelProc _mProc;
    private static IntPtr _kHook = IntPtr.Zero;
    private static IntPtr _mHook = IntPtr.Zero;
    private static Thread _pumpThread;
    private static Thread _writerThread;
    private static uint _pumpTid;
    private static volatile bool _running;
    private static volatile bool _capturing;
    private static volatile bool _debug;
    private static volatile int _extraButton; // 0 none, 1 XBUTTON1, 2 XBUTTON2
    private static string _modifier = "alt";
    private static readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent _signal = new AutoResetEvent(false);
    private static readonly object _gate = new object();
    private static readonly object _stdio = new object();

    public delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage([In] ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage([In] ref MSG lpmsg);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint Msg, UIntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public static bool IsRunning()
    {
        return _running;
    }

    public static bool IsCapturing()
    {
        return _capturing;
    }

    public static void Configure(string modifier, int extraButton, bool debug)
    {
        if (modifier == null || modifier.Length == 0) modifier = "alt";
        _modifier = modifier.ToLowerInvariant();
        _extraButton = extraButton;
        _debug = debug;
    }

    public static void Start(string modifier, int extraButton, bool debug)
    {
        Configure(modifier, extraButton, debug);
        lock (_gate)
        {
            if (_running) return;
            _running = true;
            _capturing = false;
            _kProc = KeyboardProc;
            _mProc = MouseProc;
            _writerThread = new Thread(WriterLoop);
            _writerThread.IsBackground = true;
            _writerThread.Name = "AIPickWriter";
            _writerThread.Start();
            _pumpThread = new Thread(PumpLoop);
            _pumpThread.IsBackground = true;
            _pumpThread.Name = "AIPickPump";
            _pumpThread.SetApartmentState(ApartmentState.STA);
            _pumpThread.Start();
        }
        Emit("{\"event\":\"guard-ready\"}");
    }

    public static void WriteLineSafe(string line)
    {
        lock (_stdio)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    public static void Stop()
    {
        Emit("{\"event\":\"guard-stopped\"}");
        lock (_gate)
        {
            if (!_running) return;
            _running = false;
            _capturing = false;
            try
            {
                if (_kHook != IntPtr.Zero) UnhookWindowsHookEx(_kHook);
            }
            catch { }
            try
            {
                if (_mHook != IntPtr.Zero) UnhookWindowsHookEx(_mHook);
            }
            catch { }
            _kHook = IntPtr.Zero;
            _mHook = IntPtr.Zero;
            try
            {
                if (_pumpTid != 0) PostThreadMessage(_pumpTid, (uint)WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
            }
            catch { }
        }
        _signal.Set();
        try { if (_pumpThread != null && _pumpThread.IsAlive) _pumpThread.Join(800); } catch { }
        try { if (_writerThread != null && _writerThread.IsAlive) _writerThread.Join(400); } catch { }
    }

    private static void PumpLoop()
    {
        try
        {
            _pumpTid = GetCurrentThreadId();
            _kHook = SetWindowsHookEx(WH_KEYBOARD_LL, _kProc, IntPtr.Zero, 0);
            _mHook = SetWindowsHookEx(WH_MOUSE_LL, _mProc, IntPtr.Zero, 0);
            if (_kHook == IntPtr.Zero || _mHook == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                Emit("{\"event\":\"guard-error\",\"error\":\"SetWindowsHookEx failed " + err + "\"}");
            }
            MSG msg;
            while (_running && GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        catch (Exception ex)
        {
            Emit("{\"event\":\"guard-error\",\"error\":\"" + JsonEscape(ex.Message) + "\"}");
        }
        finally
        {
            try { if (_kHook != IntPtr.Zero) UnhookWindowsHookEx(_kHook); } catch { }
            try { if (_mHook != IntPtr.Zero) UnhookWindowsHookEx(_mHook); } catch { }
            _kHook = IntPtr.Zero;
            _mHook = IntPtr.Zero;
        }
    }

    private static void WriterLoop()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
        }
        catch { }
        while (_running)
        {
            _signal.WaitOne(200);
            string line;
            while (_events.TryDequeue(out line))
            {
                try { WriteLineSafe(line); }
                catch { }
            }
        }
        string rest;
        while (_events.TryDequeue(out rest))
        {
            try { WriteLineSafe(rest); } catch { }
        }
    }

    private static void Emit(string json)
    {
        _events.Enqueue(json);
        _signal.Set();
    }

    private static string JsonEscape(string s)
    {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
    }

    private static bool KeyDown(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    private static bool IsModifierVk(int vk)
    {
        string m = _modifier;
        if (m == "ctrl") return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL;
        if (m == "shift") return vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT;
        // default alt, also alt+xbutton modes use Alt as modifier
        return vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU;
    }

    private static bool ModifierHeld()
    {
        string m = _modifier;
        if (m == "ctrl") return KeyDown(VK_CONTROL) || KeyDown(VK_LCONTROL) || KeyDown(VK_RCONTROL);
        if (m == "shift") return KeyDown(VK_SHIFT) || KeyDown(VK_LSHIFT) || KeyDown(VK_RSHIFT);
        return KeyDown(VK_MENU) || KeyDown(VK_LMENU) || KeyDown(VK_RMENU);
    }

    private static void BeginCapture(string why)
    {
        if (_capturing) return;
        _capturing = true;
        Emit("{\"event\":\"pick-start\",\"reason\":\"" + JsonEscape(why) + "\"}");
    }

    private static void EndCapture(string ev, string why)
    {
        if (!_capturing) return;
        _capturing = false;
        Emit("{\"event\":\"" + ev + "\",\"reason\":\"" + JsonEscape(why) + "\"}");
    }

    private static IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode < 0 || !_running)
        {
            return CallNextHookEx(_kHook, nCode, wParam, lParam);
        }
        try
        {
            int msg = wParam.ToInt32();
            KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if ((info.flags & LLKHF_INJECTED) != 0)
            {
                return CallNextHookEx(_kHook, nCode, wParam, lParam);
            }
            int vk = (int)info.vkCode;
            bool isUp = (msg == WM_KEYUP || msg == WM_SYSKEYUP || (info.flags & LLKHF_UP) != 0);

            if (IsModifierVk(vk))
            {
                if (_extraButton != 0)
                {
                    // Alt+侧键模式：单独修饰键放行，避免抢走 Alt+Tab / Alt+Q
                    if (isUp && _capturing)
                    {
                        EndCapture("pick-end", "modifier-up");
                        return (IntPtr)1;
                    }
                    if (_capturing)
                    {
                        return (IntPtr)1;
                    }
                    return CallNextHookEx(_kHook, nCode, wParam, lParam);
                }
                if (!isUp)
                {
                    BeginCapture("modifier-down");
                    return (IntPtr)1;
                }
                if (_capturing)
                {
                    EndCapture("pick-end", "modifier-up");
                    return (IntPtr)1;
                }
                return (IntPtr)1;
            }

            if (_capturing)
            {
                if (vk == VK_ESCAPE && !isUp)
                {
                    EndCapture("pick-cancel", "esc");
                    return (IntPtr)1;
                }
                if (!isUp)
                {
                    // 其它键：退出取词并把该键放行（尽量减轻对 Alt+Tab 的影响）
                    EndCapture("pick-cancel", "other-key");
                    return CallNextHookEx(_kHook, nCode, wParam, lParam);
                }
            }
        }
        catch { }
        return CallNextHookEx(_kHook, nCode, wParam, lParam);
    }

    private static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode < 0 || !_running)
        {
            return CallNextHookEx(_mHook, nCode, wParam, lParam);
        }
        try
        {
            int msg = wParam.ToInt32();
            MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if ((info.flags & LLMHF_INJECTED) != 0)
            {
                return CallNextHookEx(_mHook, nCode, wParam, lParam);
            }
            int xbtn = (int)((info.mouseData >> 16) & 0xFFFF);

            if (!_capturing && _extraButton != 0 && ModifierHeld())
            {
                if ((msg == WM_XBUTTONDOWN || msg == WM_NCXBUTTONDOWN) && xbtn == _extraButton)
                {
                    BeginCapture("xbutton");
                    EmitMouse("down", info.pt.x, info.pt.y, true);
                    return (IntPtr)1;
                }
            }

            if (_capturing)
            {
                // 绝不能吞掉 MOUSEMOVE：WH_MOUSE_LL 拦截移动会导致光标/画面卡死
                if (msg == WM_MOUSEMOVE)
                {
                    return CallNextHookEx(_mHook, nCode, wParam, lParam);
                }
                if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONDBLCLK)
                {
                    EmitMouse("down", info.pt.x, info.pt.y, true);
                    // 放行给置顶遮罩窗口画选框，底层被遮罩挡住收不到
                    return CallNextHookEx(_mHook, nCode, wParam, lParam);
                }
                if (msg == WM_LBUTTONUP)
                {
                    EmitMouse("up", info.pt.x, info.pt.y, false);
                    return CallNextHookEx(_mHook, nCode, wParam, lParam);
                }
                if (msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL
                    || msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP
                    || msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP
                    || msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP)
                {
                    return (IntPtr)1;
                }
            }
        }
        catch { }
        return CallNextHookEx(_mHook, nCode, wParam, lParam);
    }

    private static void EmitMouse(string type, int x, int y, bool lbutton)
    {
        StringBuilder sb = new StringBuilder(96);
        sb.Append("{\"event\":\"pick-mouse\",\"type\":\"");
        sb.Append(type);
        sb.Append("\",\"x\":");
        sb.Append(x);
        sb.Append(",\"y\":");
        sb.Append(y);
        sb.Append(",\"lbutton\":");
        sb.Append(lbutton ? "true" : "false");
        sb.Append("}");
        Emit(sb.ToString());
    }
}
