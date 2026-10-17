// activate.cs - the handler Windows runs when a dsh-tui toast is clicked.
//
// The toast is created with activationType="protocol" and the launch URI
//   dsh-tui:activate?m=<marker>
// so the shell starts:   activate.exe "<uri>" [-DataDir <dir>]
// src/ink/notify-helper/compile.ts compiles this file into
// <DATA_DIR>/notify/activate.exe on first use and caches the product.
//
// Contract with the TypeScript side:
//   * <marker> is OPAQUE here. Its one construction site is the TypeScript
//     side ("[dsh-tui:<pid>]" appended to the terminal title, which Windows
//     Terminal exposes as the tab name); this file never formats a marker, it
//     only matches the string it was handed as a substring of a tab name
//     (ordinal, case-insensitive).
//   * The query parameter is `m`; `-Marker <marker>` is accepted as well, so
//     the handler can be driven by hand while diagnosing.
//   * `-DataDir <dir>` (optional) is the TUI data directory the log goes to.
//     Without it the log falls back to %USERPROFILE%\.dsh-tui - the same
//     directory src/utils/paths.ts resolves.
//
// Restrictions (DESIGN 9.5 - do not "modernize" this file):
//   * It has to compile with the in-box csc.exe (.NET Framework 4.x) against
//     the framework's UIAutomationClient/UIAutomationTypes, so it stays at
//     C# 5: no string interpolation, no null-conditional or nameof operators,
//     no inline out declarations, no static using directives. ASCII only (no
//     BOM: no /codepage flag is passed to the compiler either).
//
// Exit codes: 0 = jumped back (window in the foreground, keyboard focus in the
// terminal), 2 = no window carried the marker, 3 = the window was found but
// the foreground/focus could not be taken, 1 = bad invocation.
//
// Step order is DESIGN D6 and every step is verified, because
// SetForegroundWindow reports success while the foreground lock keeps the
// window where it was: SW_RESTORE -> wait until the window is restored ->
// SetForegroundWindow -> wait until GetForegroundWindow reports it ->
// Select(tab) -> wait until the tab reports itself selected ->
// SetFocus(TermControl).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static class Activate
{
    private const int SW_RESTORE = 9;
    // The step delays are CEILINGS, not durations (see WaitUntil): every wait
    // polls the state it needs and leaves as soon as that state holds. The
    // numbers are the sleeps this file used to spend unconditionally, so a state
    // that never arrives still costs exactly what it cost before.
    private const int StepDelayMs = 250;
    private const int FocusDelayMs = 150;
    private const int AltTapDelayMs = 60;
    private const int PollIntervalMs = 15;
    private const int ForegroundAttempts = 3;
    private const int FocusAttempts = 2;
    private const byte VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const string TerminalProcessName = "WindowsTerminal";
    private const string TermControlClass = "TermControl";
    private const string InputSiteClass = "Windows.UI.Input.InputSite.WindowClass";

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

    private static string logPath;

    private static int Main(string[] args)
    {
        string marker = null;
        string dataDir = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "-Marker" && i + 1 < args.Length) marker = args[i + 1];
            else if (args[i] == "-DataDir" && i + 1 < args.Length) dataDir = args[i + 1];
        }
        if (marker == null) marker = MarkerFromArgs(args);
        logPath = LogPathFor(dataDir);
        if (marker == null)
        {
            Log("no marker: neither a ?m= launch URI nor -Marker was given");
            Console.Error.WriteLine("usage: activate.exe \"dsh-tui:activate?m=<marker>\" [-Marker <marker>] [-DataDir <dir>]");
            return 1;
        }
        Log("start marker=" + marker);

        // D7: the session can sit in any WindowsTerminal window, and the
        // window title is the ACTIVE tab's title - only the tab names are
        // searched.
        IntPtr window = IntPtr.Zero;
        AutomationElement tab = null;
        List<IntPtr> candidates = TerminalWindows();
        for (int i = 0; i < candidates.Count && tab == null; i++)
        {
            IntPtr candidate = candidates[i];
            try
            {
                AutomationElement root = AutomationElement.FromHandle(candidate);
                AutomationElement found = root == null ? null : FindTab(root, marker);
                Log("window hwnd=" + candidate.ToInt64() + " title=\"" + WindowTitle(candidate) + "\" matched=" + (found != null));
                if (found != null)
                {
                    window = candidate;
                    tab = found;
                }
            }
            catch (Exception error)
            {
                Log("window hwnd=" + candidate.ToInt64() + " could not be inspected: " + error.Message);
            }
        }
        if (tab == null)
        {
            Log("marker not found in any visible " + TerminalProcessName + " window: " + marker);
            return 2;
        }

        if (IsIconic(window))
        {
            ShowWindow(window, SW_RESTORE);
            Log("SW_RESTORE (the window was minimized)");
            WaitUntil(() => !IsIconic(window), StepDelayMs);
        }
        if (!BringToForeground(window))
        {
            Log("jump-back failed: the window never reached the foreground (R8)");
            return 3;
        }
        if (!SelectTab(tab))
        {
            Log("jump-back failed: the tab could not be selected");
            return 3;
        }

        bool focused = FocusTerminal(window);
        Log("RESULT window=" + window.ToInt64() + " foreground=True termFocused=" + focused);
        return focused ? 0 : 3;
    }

    // The launch URI reaches us as one argument: dsh-tui:activate?m=<marker>.
    // Anything else on the command line is ignored, and an argument that is a
    // flag is never treated as the URI.
    private static string MarkerFromArgs(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == null || args[i].StartsWith("-")) continue;
            string decoded;
            try
            {
                decoded = Uri.UnescapeDataString(args[i]);
            }
            catch (Exception)
            {
                decoded = args[i];
            }
            int start = decoded.IndexOf("?m=", StringComparison.Ordinal);
            if (start < 0) start = decoded.IndexOf("&m=", StringComparison.Ordinal);
            if (start < 0) continue;
            string value = decoded.Substring(start + 3);
            int end = value.IndexOf('&');
            if (end >= 0) value = value.Substring(0, end);
            value = value.Trim();
            if (value.Length > 0) return value;
        }
        return null;
    }

    private static List<IntPtr> TerminalWindows()
    {
        List<IntPtr> windows = new List<IntPtr>();
        EnumWindows((hwnd, param) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (ProcessName(pid) == TerminalProcessName) windows.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static AutomationElement FindTab(AutomationElement root, string marker)
    {
        // The names come back with the search: reading Current.Name per tab costs
        // a cross-process round trip each, and this walk runs before anything
        // else a click does. Two things a cache request insists on: the cached
        // scope has to cover the element searched from (a plain Descendants scope
        // throws), and what it hands back is a cache-only reference, so the tab
        // that matched is re-resolved into a full element - the caller has to
        // select it. That second lookup goes by runtime id, because the name it
        // matched on is rewritten under us whenever the session redraws its
        // title.
        CacheRequest cache = new CacheRequest();
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.RuntimeIdProperty);
        cache.TreeScope = TreeScope.Subtree;
        AutomationElementCollection tabs;
        int[] match = null;
        using (cache.Activate())
        {
            tabs = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
            for (int i = 0; i < tabs.Count && match == null; i++)
            {
                string name = tabs[i].Cached.Name;
                if (name != null && name.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    match = (int[])tabs[i].GetCachedPropertyValue(AutomationElement.RuntimeIdProperty);
                }
            }
        }
        if (match == null) return null;
        return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.RuntimeIdProperty, match));
    }

    // R8: SetForegroundWindow returning true is not evidence that the window
    // came forward. The lock yields to the process that "received the last
    // input", so a bare Alt tap - the spike's measured unlock - is used before
    // every retry.
    private static bool BringToForeground(IntPtr window)
    {
        for (int attempt = 1; attempt <= ForegroundAttempts; attempt++)
        {
            SetForegroundWindow(window);
            if (WaitUntil(() => GetForegroundWindow() == window, StepDelayMs))
            {
                Log("SetForegroundWindow verified on attempt " + attempt);
                return true;
            }
            Log("SetForegroundWindow attempt " + attempt + " did not take effect (R8); retrying with an Alt unlock");
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            // Hold Alt until the system reports it down, rather than for a fixed
            // 60 ms: the unlock needs the tap to have registered, not the wait.
            WaitUntil(() => (GetAsyncKeyState(VK_MENU) & 0x8000) != 0, AltTapDelayMs);
            SetForegroundWindow(window);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            if (WaitUntil(() => GetForegroundWindow() == window, StepDelayMs))
            {
                Log("Alt unlock verified on attempt " + attempt);
                return true;
            }
        }
        return false;
    }

    private static bool SelectTab(AutomationElement tab)
    {
        for (int attempt = 1; attempt <= 2; attempt++)
        {
            try
            {
                SelectionItemPattern pattern = (SelectionItemPattern)tab.GetCurrentPattern(SelectionItemPattern.Pattern);
                pattern.Select();
                if (WaitUntil(() => pattern.Current.IsSelected, StepDelayMs))
                {
                    Log("tab selected on attempt " + attempt);
                    return true;
                }
            }
            catch (Exception error)
            {
                Log("select attempt " + attempt + " threw: " + error.Message);
            }
        }
        return false;
    }

    // AC-4: without this the keyboard focus stays on the tab strip, so typing
    // goes nowhere and the arrow keys switch tabs instead of moving the cursor.
    private static bool FocusTerminal(IntPtr window)
    {
        AutomationElement term;
        try
        {
            AutomationElement root = AutomationElement.FromHandle(window);
            if (root == null)
            {
                term = null;
            }
            else
            {
                // Selecting a tab is not the same as the switch being over: the
                // newly selected tab's view is realized a moment later. Wait for
                // that view (ceiling = the sleep that used to sit after Select)
                // instead of sleeping the delay out before looking for it.
                WaitUntil(() => FindFirst(root, TreeScope.Descendants, AutomationElement.ClassNameProperty, TermControlClass) != null, StepDelayMs);
                term = FindTermControl(root);
            }
        }
        catch (Exception error)
        {
            Log("focus target lookup threw: " + error.Message);
            return false;
        }
        if (term == null)
        {
            Log("no " + TermControlClass + " found; keyboard focus stays where it was");
            return false;
        }
        for (int attempt = 1; attempt <= FocusAttempts; attempt++)
        {
            try
            {
                term.SetFocus();
                WaitUntil(TerminalHasFocus, FocusDelayMs);
                AutomationElement focused = AutomationElement.FocusedElement;
                string className = focused == null ? "" : focused.Current.ClassName;
                Log("SetFocus(" + TermControlClass + ") attempt " + attempt + " focusedClass=" + className);
                if (className == TermControlClass) return true;
            }
            catch (Exception error)
            {
                Log("SetFocus attempt " + attempt + " threw: " + error.Message);
            }
        }
        return false;
    }

    private static bool TerminalHasFocus()
    {
        AutomationElement focused = AutomationElement.FocusedElement;
        return focused != null && focused.Current.ClassName == TermControlClass;
    }

    // D6's documented path first: Window -> Pane(InputSite) -> Custom ->
    // Text[TermControl]. The class-only search stays as the fallback, because
    // the InputSite class name belongs to Windows Terminal and can drift.
    private static AutomationElement FindTermControl(AutomationElement root)
    {
        AutomationElement inputSite = FindFirst(root, TreeScope.Descendants, AutomationElement.ClassNameProperty, InputSiteClass);
        if (inputSite != null)
        {
            AutomationElement custom = FindFirst(inputSite, TreeScope.Children, AutomationElement.ControlTypeProperty, ControlType.Custom);
            AutomationElement text = custom == null ? null : FindFirst(custom, TreeScope.Descendants, AutomationElement.ClassNameProperty, TermControlClass);
            if (text != null)
            {
                Log("focus target: the documented InputSite path");
                return text;
            }
        }
        AutomationElementCollection terms = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, TermControlClass));
        AutomationElement first = null;
        for (int i = 0; i < terms.Count; i++)
        {
            if (first == null) first = terms[i];
            if (terms[i].Current.IsKeyboardFocusable) return terms[i];
        }
        if (first != null) Log("focus target: class-only fallback (the documented path missed)");
        return first;
    }

    private static AutomationElement FindFirst(AutomationElement scope, TreeScope treeScope, AutomationProperty property, object value)
    {
        try
        {
            return scope.FindFirst(treeScope, new PropertyCondition(property, value));
        }
        catch (Exception)
        {
            return null;
        }
    }

    // A step delay is a ceiling on a real state, never a duration: this polls
    // and leaves the moment the state holds, so a jump costs what it measures
    // instead of what was guessed. The cap is the sleep the step used to spend
    // unconditionally, which keeps the worst case (the state never arrives) as
    // slow as it has always been.
    private static bool WaitUntil(Func<bool> state, int capMs)
    {
        int waited = 0;
        while (true)
        {
            if (state()) return true;
            if (waited >= capMs) return false;
            int step = capMs - waited < PollIntervalMs ? capMs - waited : PollIntervalMs;
            Thread.Sleep(step);
            waited += step;
        }
    }

    private static string WindowTitle(IntPtr window)
    {
        StringBuilder text = new StringBuilder(512);
        GetWindowTextW(window, text, text.Capacity);
        return text.ToString();
    }

    private static string ProcessName(uint pid)
    {
        try
        {
            return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
        }
        catch (Exception)
        {
            return "";
        }
    }

    private static string LogPathFor(string dataDir)
    {
        string dir = dataDir;
        if (dir == null || dir.Length == 0)
        {
            string home = Environment.GetEnvironmentVariable("USERPROFILE");
            if (home == null || home.Length == 0) home = Environment.GetEnvironmentVariable("HOME");
            if (home == null || home.Length == 0) return null;
            dir = Path.Combine(home, ".dsh-tui");
        }
        return Path.Combine(Path.Combine(dir, "notify"), "activate.log");
    }

    // The log is the only trace a click leaves behind (the shell starts this
    // process detached), but a log we cannot write must never cost us the
    // jump-back itself.
    private static void Log(string message)
    {
        string line = DateTime.Now.ToString("HH:mm:ss.fff") + " " + message;
        Console.WriteLine(line);
        if (logPath == null) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            File.AppendAllText(logPath, line + "\r\n");
        }
        catch (Exception)
        {
        }
    }
}
