// activate.cs - the helper Windows starts when a dsh-tui task-completion toast is clicked.
//
// Two modes; the TypeScript side calls only the first:
//   activate.exe --probe    <marker> [-DataDir <dir>]
//   activate.exe --activate <marker> [-DataDir <dir>]
//
// `--probe` answers one question without touching the desktop: is the marker carried by
// exactly one pane (or, when that pane is not realized, exactly one tab title)? It runs
// before a toast carries an activation URI, so a toast never promises an unverifiable jump.
//
// `--activate` is the click path: resolve the marker to one pane, restore and foreground
// its window, select the tab when the pane is not realized yet, and call SetFocus on the
// SAME element that was resolved. It then re-reads the desktop and exits 0 only when all
// five checks hold: that pane is the focused element (runtime id), it has keyboard focus,
// its HelpText still carries the marker, its window is foreground and not minimized.
//
// The marker is opaque here: this file never formats one, it only matches the string it
// was handed as a substring of a title. Windows Terminal exposes each pane's title as
// TermControl.HelpText and each tab's as TabItem.Name (the focused pane's). Looking at
// per-pane HelpText first is what makes the target the pane that produced the notification
// instead of "some TermControl in the window".
//
// Argument forms: the registered protocol command passes the whole launch URI
// (`dsh-tui:activate?m=<marker>`), parsed down to the marker; a bare marker is accepted
// too, so the helper can be driven by hand while diagnosing.
//
// Exit codes: 0 = the jump was performed and verified, 2 = invalid invocation (including a
// marker outside [A-Za-z0-9._-]{1,64}), 3 = the target was unreachable or a step/check
// failed. Nothing else is ever returned.
//
// Log: <DataDir>/notify/jumpback.log (default %USERPROFILE%\.dsh-tui). Every run leaves its
// stages and, on failure, the reason there. The shell starts this process detached, so the
// log is the only trace a click leaves; the data directory travels as an explicit argument
// rather than an inherited environment variable, because the shell starts us with none.
//
// Restrictions (do not "modernize" this file): it has to compile with the in-box csc.exe
// (.NET Framework 4.x) against the framework's UIAutomationClient/UIAutomationTypes, so it
// stays at C# 5 - no string interpolation, no null-conditional or nameof operators, no
// inline out declarations, no static using directives - and it takes no NuGet package and
// no runtime besides the framework. It never executes anything taken from a notification:
// the marker is only ever compared, never run.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static class JumpBack
{
    private const string TerminalWindowClass = "CASCADIA_HOSTING_WINDOW_CLASS";
    private const string TermControlClass = "TermControl";
    private const int SW_RESTORE = 9;

    // Every wait below is a ceiling on a state, not a duration: the helper polls and moves
    // on the moment the state holds, so a successful jump costs what it measures.
    private const int PollIntervalMs = 25;
    private const int RestoreCapMs = 1000;
    private const int ForegroundAttempts = 3;
    private const int ForegroundCapMs = 250;
    private const int SelectAttempts = 2;
    private const int SelectCapMs = 1000;
    private const int RealizeCapMs = 1000;
    private const int FocusAttempts = 3;
    private const int FocusCapMs = 400;

    // The log lives in the user's profile and every probe appends to it; keep it bounded.
    private const long MaxLogBytes = 256 * 1024;

    private const int ExitOk = 0;
    private const int ExitUsage = 2;
    private const int ExitUnreachable = 3;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    private static string logPath;

    private sealed class PaneHit
    {
        public IntPtr Hwnd;
        public AutomationElement Window;
        public AutomationElement Tab;
        public AutomationElement Pane;
    }

    private sealed class TabHit
    {
        public AutomationElement Window;
        public IntPtr Hwnd;
        public AutomationElement Tab;
    }

    private sealed class Checks
    {
        public bool SameElement;
        public bool KeyboardFocus;
        public bool HelpText;
        public bool Foreground;
        public bool NotMinimized;
    }

    private sealed class Options
    {
        public string Mode;
        public string Marker;
        public string DataDir;
    }

    private static int Main(string[] args)
    {
        // A pure decision table for the candidate association: no UIA, no desktop,
        // so the Windows regression can prove the ambiguity rule without a window.
        if (args.Length == 1 && args[0] == "--selftest-candidates") return RunCandidateSelfTest();

        Options options;
        string argumentError;
        if (!TryParseArgs(args, out options, out argumentError))
        {
            logPath = ResolveLogPath(options.DataDir);
            Log("stage=args ok=false reason=\"" + Escape(argumentError) + "\"");
            Usage();
            return ExitUsage;
        }

        logPath = ResolveLogPath(options.DataDir);
        Log("stage=start mode=" + options.Mode + " marker=" + options.Marker
            + " log=" + (logPath == null ? "<none>" : logPath));

        try
        {
            if (options.Mode == "--probe") return Probe(options.Marker);
            return Activate(options.Marker);
        }
        catch (Exception failure)
        {
            Log("stage=exception ok=false reason=\"" + Escape(failure.Message) + "\"");
            return ExitUnreachable;
        }
    }

    // The command line is fixed by the registered protocol command: anything extra is
    // rejected, not guessed at. Marker validation happens here, before any UIA call.
    private static bool TryParseArgs(string[] args, out Options options, out string error)
    {
        options = new Options();
        error = null;
        for (int i = 0; i < args.Length; i++)
        {
            string argument = args[i];
            if (argument == "-DataDir")
            {
                if (i + 1 >= args.Length) { error = "missing value after -DataDir"; return false; }
                if (options.DataDir != null) { error = "duplicate -DataDir"; return false; }
                options.DataDir = args[++i];
                if (options.DataDir.Length == 0) { error = "empty -DataDir"; return false; }
            }
            else if (argument == "--probe" || argument == "--activate")
            {
                if (options.Mode != null) { error = "duplicate mode"; return false; }
                options.Mode = argument;
            }
            else if (argument.Length > 0 && argument[0] == '-')
            {
                error = "unknown option " + Quote(argument);
                return false;
            }
            else if (options.Marker == null)
            {
                options.Marker = NormalizeMarker(argument);
            }
            else
            {
                error = "unexpected extra argument " + Quote(argument);
                return false;
            }
        }
        if (options.Mode == null) { error = "missing mode (--probe or --activate)"; return false; }
        if (options.Marker == null) { error = "missing marker"; return false; }
        if (!ValidMarker(options.Marker)) { error = "invalid marker (expected [A-Za-z0-9._-]{1,64})"; return false; }
        return true;
    }

    // The shell starts us as:  activate.exe --activate "dsh-tui:activate?m=<marker>" -DataDir <dir>
    // The marker is URL-safe by contract (see ValidMarker), so no percent-decoding is done:
    // a value that would need it was not produced by this process.
    private static string NormalizeMarker(string raw)
    {
        const string prefix = "dsh-tui:activate?m=";
        if (raw.Length >= prefix.Length &&
            string.Compare(raw, 0, prefix, 0, prefix.Length, StringComparison.OrdinalIgnoreCase) == 0)
        {
            return raw.Substring(prefix.Length);
        }
        return raw;
    }

    // The marker arrives as an argument, so only a conservative ASCII token alphabet is
    // accepted; explicit ranges (not char.IsLetter) keep non-ASCII out of a window title.
    private static bool ValidMarker(string marker)
    {
        if (marker == null || marker.Length == 0 || marker.Length > 64) return false;
        for (int i = 0; i < marker.Length; i++)
        {
            char c = marker[i];
            bool accepted = (c >= 'A' && c <= 'Z')
                || (c >= 'a' && c <= 'z')
                || (c >= '0' && c <= '9')
                || c == '-' || c == '_' || c == '.';
            if (!accepted) return false;
        }
        return true;
    }

    private static void Usage()
    {
        try
        {
            Console.Error.WriteLine("usage: activate.exe --probe <marker> [-DataDir <dir>]");
            Console.Error.WriteLine("       activate.exe --activate <marker> [-DataDir <dir>]");
            Console.Error.WriteLine("       <marker> is [A-Za-z0-9._-]{1,64}, or dsh-tui:activate?m=<marker>");
        }
        catch (Exception)
        {
            // An unusable console must not replace the exit code this mode owes the caller.
        }
    }

    // Non-invasive: count matching panes/tabs; no tab is selected and no focus is moved.
    private static int Probe(string marker)
    {
        Stopwatch clock = Stopwatch.StartNew();
        List<PaneHit> panes;
        List<TabHit> tabs;
        FindHits(marker, out panes, out tabs);
        bool capable = IsCapable(panes, tabs);
        bool associated = panes.Count == 0 || panes[0].Tab != null;
        bool tabsAgree = true;
        if (panes.Count == 1)
        {
            for (int i = 0; i < tabs.Count; i++)
            {
                if (!SameElement(tabs[i].Tab, panes[0].Tab)) tabsAgree = false;
            }
        }
        Log("stage=probe ok=" + Bool(capable) + " capable=" + Bool(capable)
            + " paneHits=" + panes.Count + " tabHits=" + tabs.Count
            + " associated=" + Bool(associated) + " tabsAgree=" + Bool(tabsAgree)
            + " lookupMs=" + clock.ElapsedMilliseconds);
        return capable ? ExitOk : ExitUnreachable;
    }

    // One realized pane (at most one tab title as an entry point), or no realized pane
    // but exactly one tab title. Anything else is ambiguous, and ambiguity is never resolved
    // by picking one candidate - a jump to the wrong session is worse than no jump. A pane
    // hit and a tab hit only form one candidate when the tab is the pane's own tab; two
    // hits from different windows/tabs are two sessions even when each count is one.
    private static bool IsCapable(List<PaneHit> panes, List<TabHit> tabs)
    {
        bool associated = panes.Count == 0 || panes[0].Tab != null;
        bool tabsAgree = true;
        if (panes.Count == 1)
        {
            for (int i = 0; i < tabs.Count; i++)
            {
                if (!SameElement(tabs[i].Tab, panes[0].Tab)) tabsAgree = false;
            }
        }
        return CandidateVerdict(panes.Count, tabs.Count, associated, tabsAgree);
    }

    // The decision without any UIA object, so `--selftest-candidates` can table-test it.
    private static bool CandidateVerdict(int paneCount, int tabCount, bool paneAssociated, bool tabsAgree)
    {
        if (paneCount > 1) return false;
        if (paneCount == 0) return tabCount == 1;
        if (!paneAssociated) return false;
        return tabsAgree;
    }

    // Cases: one complete candidate is accepted; unrelated pane/tab hits are rejected before
    // any window is touched. Exit 0 only when every row agrees.
    private static int RunCandidateSelfTest()
    {
        object[][] cases = new object[][]
        {
            new object[] { "one associated pane", 1, 0, true, true, true },
            new object[] { "pane plus its own tab", 1, 1, true, true, true },
            new object[] { "pane plus another tab", 1, 1, true, false, false },
            new object[] { "pane without a tab", 1, 1, false, true, false },
            new object[] { "two panes", 2, 0, true, true, false },
            new object[] { "one tab only", 0, 1, true, true, true },
            new object[] { "two tabs", 0, 2, true, true, false },
            new object[] { "no hits", 0, 0, true, true, false },
        };
        bool ok = true;
        for (int i = 0; i < cases.Length; i++)
        {
            object[] row = cases[i];
            bool actual = CandidateVerdict((int)row[1], (int)row[2], (bool)row[3], (bool)row[4]);
            bool expected = (bool)row[5];
            if (actual != expected)
            {
                Console.Error.WriteLine("selftest failed: " + row[0] + " expected " + Bool(expected) + " got " + Bool(actual));
                ok = false;
            }
        }
        Console.Out.WriteLine(ok ? "candidate selftest passed (" + cases.Length + " cases)" : "candidate selftest failed");
        return ok ? ExitOk : ExitUnreachable;
    }

    // The click path (D6). Every step is verified, and when a step fails the helper
    // stops there: it never reports success for a jump it could not prove.
    private static int Activate(string marker)
    {
        Stopwatch clock = Stopwatch.StartNew();
        List<PaneHit> panes;
        List<TabHit> tabs;
        FindHits(marker, out panes, out tabs);

        // The same predicate the probe used decides here as well: a jump is only attempted for
        // the identity the probe called capable, and ambiguity is rejected before any
        // window is touched so a marker carried by two panes cannot pull one of them forward.
        if (!IsCapable(panes, tabs))
        {
            string reason = panes.Count == 0 && tabs.Count == 0 ? "not-found" : "ambiguous";
            Log("stage=discover ok=false reason=" + reason
                + " paneHits=" + panes.Count + " tabHits=" + tabs.Count);
            return ExitUnreachable;
        }

        bool viaTab = panes.Count == 0;
        IntPtr hwnd = viaTab ? tabs[0].Hwnd : panes[0].Hwnd;
        Log("stage=discover ok=true discovery=" + (viaTab ? "tab" : "pane")
            + " hwnd=" + hwnd.ToInt64() + " paneHits=" + panes.Count + " tabHits=" + tabs.Count);

        if (IsIconic(hwnd))
        {
            ShowWindow(hwnd, SW_RESTORE);
            if (!WaitUntil(() => !IsIconic(hwnd), RestoreCapMs))
            {
                Log("stage=restore ok=false reason=\"the window is still minimized after SW_RESTORE\" hwnd=" + hwnd.ToInt64());
                return ExitUnreachable;
            }
            Log("stage=restore ok=true hwnd=" + hwnd.ToInt64());
        }

        if (!BringToForeground(hwnd))
        {
            Log("stage=foreground ok=false reason=\"the window never became the foreground window\" hwnd=" + hwnd.ToInt64());
            return ExitUnreachable;
        }
        Log("stage=foreground ok=true hwnd=" + hwnd.ToInt64());

        AutomationElement pane;
        if (viaTab)
        {
            // The tab is only an entry point: select, verify, then resolve the pane again by
            // HelpText; the unselected element does not exist yet and no runtime id survives.
            if (!SelectTab(tabs[0].Tab))
            {
                Log("stage=select ok=false reason=\"the tab did not report itself selected\"");
                return ExitUnreachable;
            }
            Log("stage=select ok=true");
            pane = WaitForPane(tabs[0].Window, marker, RealizeCapMs);
            if (pane == null)
            {
                Log("stage=realize ok=false reason=\"the selected tab never exposed exactly one pane with the marker\"");
                return ExitUnreachable;
            }
            Log("stage=realize ok=true");
        }
        else
        {
            pane = panes[0].Pane;
        }

        string paneRtid = RuntimeIdOf(pane);
        if (paneRtid == null)
        {
            Log("stage=focus ok=false reason=\"the target pane has no runtime id\"");
            return ExitUnreachable;
        }
        if (!FocusPane(pane, paneRtid, marker))
        {
            Log("stage=focus ok=false reason=\"the keyboard focus did not land on the target pane\" rtid=" + paneRtid);
            return ExitUnreachable;
        }
        Log("stage=focus ok=true rtid=" + paneRtid);

        Checks checks = Verify(paneRtid, marker, hwnd);
        bool ok = checks.SameElement && checks.KeyboardFocus && checks.HelpText
            && checks.Foreground && checks.NotMinimized;
        Log("stage=verify ok=" + Bool(ok)
            + " sameElement=" + Bool(checks.SameElement)
            + " hasKeyboardFocus=" + Bool(checks.KeyboardFocus)
            + " helpText=" + Bool(checks.HelpText)
            + " foreground=" + Bool(checks.Foreground)
            + " notMinimized=" + Bool(checks.NotMinimized)
            + " hwnd=" + hwnd.ToInt64() + " rtid=" + paneRtid
            + " totalMs=" + clock.ElapsedMilliseconds);
        if (!ok)
        {
            Log("stage=activate ok=false reason=\"one or more of the five checks failed\"");
            return ExitUnreachable;
        }
        Log("stage=activate ok=true totalMs=" + clock.ElapsedMilliseconds);
        return ExitOk;
    }

    // Top-level Windows Terminal windows, found by desktop class rather than process name.
    // Minimized windows stay (still visible, which AC-6 needs); windows without a native
    // handle cannot be restored or foregrounded and are skipped.
    private static List<AutomationElement> TerminalWindows()
    {
        List<AutomationElement> windows = new List<AutomationElement>();
        AutomationElementCollection found = AutomationElement.RootElement.FindAll(
            TreeScope.Children,
            new PropertyCondition(AutomationElement.ClassNameProperty, TerminalWindowClass));
        for (int i = 0; i < found.Count; i++)
        {
            AutomationElement window = found[i];
            IntPtr hwnd = HwndOf(window);
            if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) continue;
            windows.Add(window);
        }
        return windows;
    }

    private static AutomationElementCollection PanesOf(AutomationElement window)
    {
        AndCondition condition = new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
            new PropertyCondition(AutomationElement.ClassNameProperty, TermControlClass));
        return window.FindAll(TreeScope.Descendants, condition);
    }

    // A window that disappears or denies UIA access is logged and skipped: under-detecting a
    // target degrades to "no jump", which is the contract, while guessing is not.
    private static void FindHits(string marker, out List<PaneHit> panes, out List<TabHit> tabs)
    {
        panes = new List<PaneHit>();
        tabs = new List<TabHit>();
        List<AutomationElement> windows = TerminalWindows();
        for (int i = 0; i < windows.Count; i++)
        {
            AutomationElement window = windows[i];
            IntPtr hwnd = HwndOf(window);
            try
            {
                AutomationElement selectedTab = SelectedTabOf(window);
                List<AutomationElement> windowPanes = PanesCarryingMarker(window, marker);
                for (int j = 0; j < windowPanes.Count; j++)
                {
                    PaneHit hit = new PaneHit();
                    hit.Hwnd = hwnd;
                    hit.Window = window;
                    hit.Pane = windowPanes[j];
                    hit.Tab = selectedTab;
                    panes.Add(hit);
                }

                AutomationElementCollection windowTabs = window.FindAll(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
                for (int j = 0; j < windowTabs.Count; j++)
                {
                    AutomationElement tab = windowTabs[j];
                    if (TabNameOf(tab).IndexOf(marker, StringComparison.Ordinal) < 0) continue;
                    TabHit hit = new TabHit();
                    hit.Window = window;
                    hit.Hwnd = hwnd;
                    hit.Tab = tab;
                    tabs.Add(hit);
                }
            }
            catch (Exception failure)
            {
                Log("stage=discover window=" + hwnd.ToInt64() + " ok=false reason=\""
                    + Escape(failure.Message) + "\"");
            }
        }
    }

    // One identity rule for the whole file: a pane is a TermControl whose own HelpText
    // carries the marker, shared by discovery and the post-switch lookup so it cannot drift.
    private static List<AutomationElement> PanesCarryingMarker(AutomationElement window, string marker)
    {
        List<AutomationElement> hits = new List<AutomationElement>();
        AutomationElementCollection panes = PanesOf(window);
        for (int i = 0; i < panes.Count; i++)
        {
            AutomationElement pane = panes[i];
            if (HelpTextOf(pane).IndexOf(marker, StringComparison.Ordinal) >= 0) hits.Add(pane);
        }
        return hits;
    }

    // The TabItem a pane belongs to. Only the selected tab's panes are realized in
    // the UIA tree, so the window's selected tab is the pane's tab; a window without
    // a selected tab cannot prove the association and stays ambiguous.
    private static AutomationElement SelectedTabOf(AutomationElement window)
    {
        AutomationElementCollection tabs = window.FindAll(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
        for (int i = 0; i < tabs.Count; i++)
        {
            AutomationElement tab = tabs[i];
            object pattern;
            if (!tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) continue;
            if (((SelectionItemPattern)pattern).Current.IsSelected) return tab;
        }
        // A single-tab window has no ambiguity to resolve; when the pattern is
        // unavailable in some WT build this is still one provable candidate.
        if (tabs.Count == 1) return tabs[0];
        return null;
    }

    private static List<AutomationElement> FindPanesInWindow(AutomationElement window, string marker)
    {
        try
        {
            return PanesCarryingMarker(window, marker);
        }
        catch (Exception failure)
        {
            Log("stage=realize ok=false reason=\"pane lookup failed: " + Escape(failure.Message) + "\"");
            return new List<AutomationElement>();
        }
    }

    // Selecting a tab does not realize its view immediately, so poll for the pane instead of
    // sleeping a guessed delay. More than one hit inside the selected tab is still ambiguous.
    private static AutomationElement WaitForPane(AutomationElement window, string marker, int capMs)
    {
        List<AutomationElement> hits = new List<AutomationElement>();
        AutomationElement pane = null;
        WaitUntil(() =>
        {
            hits = FindPanesInWindow(window, marker);
            pane = hits.Count == 1 ? hits[0] : null;
            return pane != null || hits.Count > 1;
        }, capMs);
        if (hits.Count > 1) Log("stage=realize ok=false reason=ambiguous paneHits=" + hits.Count);
        return pane;
    }

    // SetForegroundWindow returns true without moving the window while the foreground lock
    // holds, so each attempt asks the desktop instead of trusting the call. Failing here is
    // a known real-machine risk; the stage is reported rather than a success being faked.
    private static bool BringToForeground(IntPtr hwnd)
    {
        for (int attempt = 1; attempt <= ForegroundAttempts; attempt++)
        {
            SetForegroundWindow(hwnd);
            if (WaitUntil(() => GetForegroundWindow() == hwnd, ForegroundCapMs))
            {
                Log("stage=foreground attempt=" + attempt + " ok=true");
                return true;
            }
            Log("stage=foreground attempt=" + attempt + " ok=false");
        }
        return false;
    }

    private static bool SelectTab(AutomationElement tab)
    {
        for (int attempt = 1; attempt <= SelectAttempts; attempt++)
        {
            try
            {
                SelectionItemPattern pattern = (SelectionItemPattern)tab.GetCurrentPattern(SelectionItemPattern.Pattern);
                pattern.Select();
                if (WaitUntil(() => IsSelected(pattern), SelectCapMs))
                {
                    Log("stage=select attempt=" + attempt + " ok=true");
                    return true;
                }
            }
            catch (Exception failure)
            {
                Log("stage=select attempt=" + attempt + " ok=false reason=\"" + Escape(failure.Message) + "\"");
            }
        }
        return false;
    }

    private static bool IsSelected(SelectionItemPattern pattern)
    {
        try
        {
            return pattern.Current.IsSelected;
        }
        catch (Exception)
        {
            return false;
        }
    }

    // Focusing "the first focusable TermControl" proves only that some pane is focused; this
    // focuses the element resolved through the marker and waits until the desktop agrees.
    private static bool FocusPane(AutomationElement pane, string paneRtid, string marker)
    {
        for (int attempt = 1; attempt <= FocusAttempts; attempt++)
        {
            try
            {
                pane.SetFocus();
            }
            catch (Exception failure)
            {
                Log("stage=focus attempt=" + attempt + " ok=false reason=\"SetFocus threw: "
                    + Escape(failure.Message) + "\"");
            }
            if (WaitUntil(() => IsFocused(paneRtid, marker), FocusCapMs))
            {
                Log("stage=focus attempt=" + attempt + " ok=true");
                return true;
            }
            Log("stage=focus attempt=" + attempt + " ok=false reason=\"focus did not land on the target pane\"");
        }
        return false;
    }

    private static bool IsFocused(string paneRtid, string marker)
    {
        try
        {
            AutomationElement focused = AutomationElement.FocusedElement;
            if (focused == null) return false;
            if (RuntimeIdOf(focused) != paneRtid) return false;
            if (!focused.Current.HasKeyboardFocus) return false;
            return HelpTextOf(focused).IndexOf(marker, StringComparison.Ordinal) >= 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    // The five checks the jump-back contract requires, each read from the live desktop
    // after the focus call. A check that cannot be read is false: unproven is not verified.
    private static Checks Verify(string paneRtid, string marker, IntPtr hwnd)
    {
        Checks checks = new Checks();
        try
        {
            AutomationElement focused = AutomationElement.FocusedElement;
            checks.SameElement = focused != null && RuntimeIdOf(focused) == paneRtid;
            checks.KeyboardFocus = focused != null && focused.Current.HasKeyboardFocus;
            checks.HelpText = focused != null
                && HelpTextOf(focused).IndexOf(marker, StringComparison.Ordinal) >= 0;
        }
        catch (Exception failure)
        {
            Log("stage=verify ok=false reason=\"reading the focused element failed: "
                + Escape(failure.Message) + "\"");
        }
        checks.Foreground = GetForegroundWindow() == hwnd;
        checks.NotMinimized = !IsIconic(hwnd);
        return checks;
    }

    // Runtime ids identify an element within the desktop session. They are read after any tab
    // switch because the pane that was not realized before does not have one yet.
    private static bool SameElement(AutomationElement left, AutomationElement right)
    {
        if (left == null || right == null) return false;
        string leftId = RuntimeIdOf(left);
        string rightId = RuntimeIdOf(right);
        return leftId != null && leftId == rightId;
    }

    private static string RuntimeIdOf(AutomationElement element)
    {
        try
        {
            int[] ids = element.GetRuntimeId();
            if (ids == null || ids.Length == 0) return null;
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < ids.Length; i++)
            {
                if (i > 0) text.Append('.');
                text.Append(ids[i].ToString());
            }
            return text.ToString();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static IntPtr HwndOf(AutomationElement element)
    {
        try
        {
            return new IntPtr(element.Current.NativeWindowHandle);
        }
        catch (Exception)
        {
            return IntPtr.Zero;
        }
    }

    private static string HelpTextOf(AutomationElement element)
    {
        try
        {
            return element.Current.HelpText == null ? "" : element.Current.HelpText;
        }
        catch (Exception)
        {
            return "";
        }
    }

    private static string TabNameOf(AutomationElement element)
    {
        try
        {
            return element.Current.Name == null ? "" : element.Current.Name;
        }
        catch (Exception)
        {
            return "";
        }
    }

    private static bool WaitUntil(Func<bool> state, int capMs)
    {
        int waited = 0;
        while (true)
        {
            if (state()) return true;
            if (waited >= capMs) return false;
            int step = Math.Min(PollIntervalMs, capMs - waited);
            Thread.Sleep(step);
            waited += step;
        }
    }

    // The shell starts this outside the TUI's environment, so the data directory is an
    // explicit argument; the fallback mirrors src/utils/paths.ts for a hand run.
    private static string ResolveLogPath(string dataDir)
    {
        try
        {
            string dir = dataDir;
            if (dir == null || dir.Length == 0)
            {
                string home = Environment.GetEnvironmentVariable("USERPROFILE");
                if (home == null || home.Length == 0) home = Environment.GetEnvironmentVariable("HOME");
                if (home == null || home.Length == 0) return null;
                dir = Path.Combine(home, ".dsh-tui");
            }
            return Path.Combine(Path.Combine(dir, "notify"), "jumpback.log");
        }
        catch (Exception)
        {
            return null;
        }
    }

    // The log is the only trace a click leaves, but an unwritable log must never cost the
    // jump. The file copy comes first; the console copy may fail - exit codes are the
    // contract, the console is not (a winexe may have none).
    private static void Log(string message)
    {
        string line = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fff") + " " + message;
        if (logPath != null)
        {
            try
            {
                // The helper creates its own log directory: on a first click neither
                // <DataDir>/notify nor the log exists, and AppendAllText makes no parents.
                string directory = Path.GetDirectoryName(logPath);
                if (directory != null && directory.Length > 0) Directory.CreateDirectory(directory);
                TruncateLogIfFull();
                File.AppendAllText(logPath, line + "\r\n");
            }
            catch (Exception)
            {
            }
        }
        try
        {
            Console.WriteLine(line);
        }
        catch (Exception)
        {
        }
    }

    private static void TruncateLogIfFull()
    {
        FileInfo info = new FileInfo(logPath);
        if (!info.Exists || info.Length <= MaxLogBytes) return;
        File.WriteAllText(logPath, "");
    }

    private static string Escape(string text)
    {
        if (text == null) return "";
        return text.Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", " ")
            .Replace("\n", " ");
    }

    private static string Quote(string text)
    {
        return "\"" + Escape(text) + "\"";
    }

    private static string Bool(bool value)
    {
        return value ? "true" : "false";
    }
}
