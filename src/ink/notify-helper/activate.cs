// activate.cs - the helper Windows starts when a dsh-tui task-completion toast is clicked.
//
// Two modes; the TypeScript side calls only the first:
//   activate.exe --probe    <marker> [-Host vscode] [-DataDir <dir>]
//   activate.exe --activate <marker> [-DataDir <dir>]
//
// `--probe` answers one question without touching the desktop: is the marker carried by
// exactly one pane (or, when that pane is not realized, exactly one tab title)? It runs
// before a toast carries an activation URI, so a toast never promises an unverifiable jump.
//
// `--probe -Host vscode` answers the same question about an editor window: the nearest
// ancestor of this process that owns candidate windows has to route to the window path, i.e.
// own exactly one Chromium window and no terminal one. That is the click's own route, taken
// from the same walk, so a toast only promises the jump the click will really make. The path
// reads only the process tree and the window list - no UI Automation - because an integrated
// terminal's panes carry no UIA title to match. The option is probe-only: the click path
// resolves its target from the desktop rather than from the URI.
//
// `--activate` is the click path. It first reads the marker records under
// <DataDir>/notify/jumpback and keeps the one carrying this marker, because the shell starts
// it with no environment of its own: that record's pid is the only link back to the process
// that sent the notification. Only `marker` and `pid` are read; the rest of the record is
// ignored, and a record that cannot be parsed simply does not participate.
//
// A record whose process is gone stops the click right there (nothing is restored, nothing is
// foregrounded): a window the user can no longer reach must not be moved. From the recorded
// pid the parent chain decides the route by window class - a Windows Terminal ancestor keeps
// the pane path below, a Chromium one (VS Code) takes the window path, anything else keeps the
// old pane path. The route is decided by the class, not by the number of windows: Windows
// Terminal hosts every one of its windows in a single process, so "exactly one window" would
// refuse a perfectly ordinary two-window terminal.
//
// The pane path (Windows Terminal): resolve the marker to one pane, restore and foreground
// its window, select the tab when the pane is not realized yet, and call SetFocus on the
// SAME element that was resolved. It then re-reads the desktop and exits 0 only when all
// five checks hold: that pane is the focused element (runtime id), it has keyboard focus,
// its HelpText still carries the marker, its window is foreground and not minimized.
//
// The window path (VS Code) promises less on purpose: restore if minimized, foreground, and
// prove three facts - the window is foreground, no longer minimized, and still owned by the
// ancestor the pid resolved to. Selecting a terminal or moving keyboard focus is not part of
// that promise, so it is not checked either.
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
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static class JumpBack
{
    private const string TerminalWindowClass = "CASCADIA_HOSTING_WINDOW_CLASS";
    private const string TermControlClass = "TermControl";
    private const int SW_RESTORE = 9;

    // The window class Chromium hosts use, VS Code included. Matching the class keeps the
    // host rule structural: the desktop shell's Progman and every owned or untitled helper
    // window fail it without their titles ever being read.
    private const string ChromiumWindowClass = "Chrome_WidgetWin_1";

    // What the click decided to do, as words rather than an enum, so the stage log and the
    // decision table below describe a click with the same vocabulary.
    private const string RoutePane = "pane";
    private const string RouteWindow = "window";
    private const string RouteRecord = "record";
    private const string RouteAmbiguous = "ambiguous";
    private const string RouteInvalid = "invalid";

    private const uint OwnerWindow = 4;                 // GW_OWNER
    private const uint SnapshotProcesses = 0x00000002;  // TH32CS_SNAPPROCESS

    // A parent chain is not a tree - a recycled pid can point at an unrelated process - so
    // the walk is bounded as well as stopped on a repeat. Real chains are a few links long.
    private const int MaxAncestorDepth = 16;

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
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("kernel32.dll")]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll")]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    private delegate List<QualifiedWindow> WindowLookup(int pid);

    // The Toolhelp snapshot layout. The executable name is not read, but the struct has to
    // keep its full size for PROCESSENTRY32 to marshal.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public int Size;
        public int Usage;
        public int ProcessId;
        public IntPtr DefaultHeapId;
        public int ModuleId;
        public int Threads;
        public int ParentProcessId;
        public int PriorityClass;
        public int Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    private static string logPath;
    private static string dataDirectory;

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

    // Only the two fields the click path needs. DataContractJsonSerializer ignores every
    // other member of the record, so the writer's schemaVersion and startedAt never reach this
    // type and cannot drift with it. `pid` is nullable because a record whose pid is missing
    // or null names no process: it must reach the same rule as a non-positive pid, not fail
    // deserialization and silently disappear from the click.
    [DataContract]
    private sealed class MarkerRecord
    {
        [DataMember(Name = "marker")]
        public string Marker { get; set; }
        [DataMember(Name = "pid")]
        public int? Pid { get; set; }
    }

    // A window of one process that passed the class-independent facts. The class travels with
    // it because the click routes on it while the probe filters on it.
    private sealed class QualifiedWindow
    {
        public IntPtr Hwnd;
        public string ClassName;
    }

    private sealed class WindowChecks
    {
        public bool Foreground;
        public bool NotMinimized;
        public bool OwnedByHost;
    }

    private sealed class Options
    {
        public string Mode;
        public string Marker;
        public string DataDir;
        public string Host;
    }

    // What the ancestor walk found: the candidate windows of the nearest owner (empty when no
    // ancestor owns any) and where that owner sat on the chain. The windows keep their class,
    // because both the probe and the click route on it after the walk.
    private sealed class HostSearch
    {
        public List<QualifiedWindow> Windows;
        public int HostPid;
        public int Depth;
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
            logPath = LogPathOf(ResolveDataDir(options.DataDir));
            Log("stage=args ok=false reason=\"" + Escape(argumentError) + "\"");
            Usage();
            return ExitUsage;
        }

        dataDirectory = ResolveDataDir(options.DataDir);
        logPath = LogPathOf(dataDirectory);
        Log("stage=start mode=" + options.Mode + " marker=" + options.Marker
            + " log=" + (logPath == null ? "<none>" : logPath));

        try
        {
            if (options.Mode == "--probe")
            {
                return options.Host == null ? Probe(options.Marker) : ProbeHost();
            }
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
            else if (argument == "-Host")
            {
                if (i + 1 >= args.Length) { error = "missing value after -Host"; return false; }
                if (options.Host != null) { error = "duplicate -Host"; return false; }
                options.Host = args[++i];
                if (options.Host != "vscode") { error = "unsupported host " + Quote(options.Host); return false; }
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
        // The click path resolves its host from the desktop, so asking for one here would be
        // a second, contradictory rule; the registered protocol command never passes it.
        if (options.Host != null && options.Mode != "--probe")
        {
            error = "-Host is only valid with --probe";
            return false;
        }
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
            Console.Error.WriteLine("usage: activate.exe --probe <marker> [-Host vscode] [-DataDir <dir>]");
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
        string line = "stage=probe ok=" + Bool(capable) + " capable=" + Bool(capable)
            + " paneHits=" + panes.Count + " tabHits=" + tabs.Count
            + " associated=" + Bool(associated) + " tabsAgree=" + Bool(tabsAgree)
            + " lookupMs=" + clock.ElapsedMilliseconds;
        Log(line);
        // The caller reads a failed run's stderr for the stage that failed; the
        // first stdout line is the start banner, not the reason.
        if (!capable) Console.Error.WriteLine(line);
        return capable ? ExitOk : ExitUnreachable;
    }

    // The host rule for an integrated terminal: the nearest ancestor that owns any candidate
    // window has to route to the window path. The probe asks the click's own question - the same
    // walk, the same candidate facts, the same verdict - because a promise the click would
    // refuse is worse than the plain toast it was meant to improve: one domain concept cannot
    // have two definitions. It reads the process tree and the window list only, so a
    // notification pays two cheap enumerations instead of a UI Automation walk.
    private static int ProbeHost()
    {
        Stopwatch clock = Stopwatch.StartNew();
        int startPid = Process.GetCurrentProcess().Id;
        HostSearch search = NearestOwner(startPid, ProcessParents(), QualifiedWindowsOf);
        bool hasTerminalWindow;
        int chromiumWindows;
        IntPtr hostHwnd;
        CountWindows(search.Windows, out hasTerminalWindow, out chromiumWindows, out hostHwnd);
        string route = RouteVerdict(hasTerminalWindow, chromiumWindows);
        bool capable = route == RouteWindow;
        string line = "stage=probe host=vscode ok=" + Bool(capable);
        if (capable)
        {
            line += " hostPid=" + search.HostPid + " hostHwnd=" + hostHwnd.ToInt64();
        }
        else
        {
            // Two outcomes refuse a promise: no single window route (no host window at all, or an
            // owner that routes to the pane path) and more than one Chromium window.
            line += " reason=" + (route == RouteAmbiguous ? "ambiguous" : "no-host-window");
        }
        line += " depth=" + search.Depth + " candidates=" + search.Windows.Count
            + " lookupMs=" + clock.ElapsedMilliseconds;
        Log(line);
        // Same contract as the pane probe: the caller reads stderr for the failed stage.
        if (!capable) Console.Error.WriteLine(line);
        return capable ? ExitOk : ExitUnreachable;
    }

    // The nearest ancestor that owns candidate windows decides, and only those windows are
    // looked at: pooling every ancestor would eventually include the shell's own windows. The
    // walk stops on a repeated pid (a recycled parent can point anywhere) and at the bound.
    // Both callers pass the same lookup: the probe promises from this walk's windows and the
    // click routes from them, so the two can never settle on different ancestors.
    private static HostSearch NearestOwner(int startPid, Dictionary<int, int> parents, WindowLookup lookup)
    {
        HostSearch search = new HostSearch();
        search.Windows = new List<QualifiedWindow>();
        HashSet<int> visited = new HashSet<int>();
        int current = startPid;
        for (int depth = 0; depth < MaxAncestorDepth; depth++)
        {
            if (!visited.Add(current)) break;
            search.Depth = depth;
            search.HostPid = current;
            search.Windows = lookup(current);
            if (search.Windows.Count > 0) return search;
            int parent;
            if (!parents.TryGetValue(current, out parent)) break;
            if (parent == 0 || parent == current) break;
            current = parent;
        }
        return search;
    }

    // Candidate windows owned by one process, class-agnostic on purpose: the class decides a
    // route, not the candidacy, so both the probe and the click walk with this one lookup. A
    // window that disappears mid-enumeration just contributes nothing, which falls on the
    // "no promise" side of the contract.
    private static List<QualifiedWindow> QualifiedWindowsOf(int pid)
    {
        List<QualifiedWindow> hits = new List<QualifiedWindow>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused)
        {
            uint ownerPid = 0;
            GetWindowThreadProcessId(hwnd, out ownerPid);
            if ((int)ownerPid != pid) return true;
            if (!IsQualifiedWindow(
                IsWindowVisible(hwnd),
                GetWindow(hwnd, OwnerWindow) == IntPtr.Zero,
                GetWindowTextLength(hwnd) > 0))
            {
                return true;
            }
            QualifiedWindow hit = new QualifiedWindow();
            hit.Hwnd = hwnd;
            hit.ClassName = ClassNameOf(hwnd);
            hits.Add(hit);
            return true;
        }, IntPtr.Zero);
        return hits;
    }

    private static string ClassNameOf(IntPtr hwnd)
    {
        StringBuilder text = new StringBuilder(256);
        GetClassName(hwnd, text, text.Capacity);
        return text.ToString();
    }

    // pid -> parent for every process alive at the call. One snapshot serves the whole walk;
    // querying per level would repeat the process lookup for every hop.
    private static Dictionary<int, int> ProcessParents()
    {
        Dictionary<int, int> parents = new Dictionary<int, int>();
        IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        // INVALID_HANDLE_VALUE is -1; without a snapshot there is no chain to walk.
        if (snapshot == new IntPtr(-1)) return parents;
        try
        {
            ProcessEntry entry = new ProcessEntry();
            entry.Size = Marshal.SizeOf(typeof(ProcessEntry));
            if (!Process32First(snapshot, ref entry)) return parents;
            do
            {
                parents[entry.ProcessId] = entry.ParentProcessId;
            }
            while (Process32Next(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return parents;
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

    // A candidate window is identified by structure, never by its caption: a jump that picked a
    // window by title could move an unrelated one. Being top-level is not an argument here
    // because EnumWindows already reports only top-level windows; the other facts come from the
    // desktop. Kept free of P/Invoke so the decision table can prove each fact, and free of the
    // class too: the class only decides which route the candidates take.
    private static bool IsQualifiedWindow(bool visible, bool ownerless, bool captioned)
    {
        return visible && ownerless && captioned;
    }

    // The record scan's decision, without touching a file. Zero records is the old world and
    // takes the pane path - that is what a click did before records existed. More than one
    // record carrying the same marker cannot be told apart, so the click refuses instead of
    // guessing, and one record without a usable pid names no process at all.
    private static string LocateVerdict(int matchingRecords, bool usablePid)
    {
        if (matchingRecords == 0) return RoutePane;
        if (matchingRecords > 1) return RouteAmbiguous;
        return usablePid ? RouteRecord : RouteInvalid;
    }

    // The class facts RouteVerdict is called with, counted in one place: the probe's promise and
    // the click's dispatch must not be able to disagree about which windows the nearest owner
    // has. The Chromium handle comes back because the window path acts on that one window, and
    // a usable window route is exactly the case where there is only one of them.
    private static void CountWindows(List<QualifiedWindow> windows, out bool hasTerminalWindow,
        out int chromiumWindows, out IntPtr chromiumHwnd)
    {
        hasTerminalWindow = false;
        chromiumWindows = 0;
        chromiumHwnd = IntPtr.Zero;
        for (int i = 0; i < windows.Count; i++)
        {
            QualifiedWindow window = windows[i];
            if (window.ClassName == TerminalWindowClass) hasTerminalWindow = true;
            else if (window.ClassName == ChromiumWindowClass)
            {
                chromiumWindows++;
                chromiumHwnd = window.Hwnd;
            }
        }
    }

    // The route comes from the window class of the nearest owner, never from how many windows
    // that owner has: Windows Terminal hosts all of its windows in one process, so counting
    // would refuse a two-window terminal (which the pane path has always supported), while the
    // Chromium host has exactly one main window and a second one leaves no target to name.
    private static string RouteVerdict(bool hasTerminalWindow, int chromiumWindows)
    {
        if (hasTerminalWindow) return RoutePane;
        if (chromiumWindows == 1) return RouteWindow;
        if (chromiumWindows > 1) return RouteAmbiguous;
        return RoutePane;
    }

    // Window-level success has exactly three facts. Keyboard focus is not one of them: the
    // contract stops at the window, so a focus check could only fail for reasons the click
    // never promised to fix.
    private static bool WindowVerdict(bool foreground, bool notMinimized, bool ownedByHost)
    {
        return foreground && notMinimized && ownedByHost;
    }

    // Cases: one complete pane/tab candidate is accepted; unrelated pane/tab hits are rejected
    // before any window is touched; a candidate window must satisfy all three structural facts;
    // the record scan decides where the click starts; the owner's window classes pick the route
    // (a terminal window keeps the pane path, one Chromium window the window path, more than one
    // ambiguous); and a finished jump has exactly three facts. Exit 0 only when every row agrees.
    private static int RunCandidateSelfTest()
    {
        int cases = 0;
        bool ok = true;

        object[][] paneCases = new object[][]
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
        for (int i = 0; i < paneCases.Length; i++)
        {
            object[] row = paneCases[i];
            cases++;
            if (!CheckVerdict(row[0], (bool)row[5],
                CandidateVerdict((int)row[1], (int)row[2], (bool)row[3], (bool)row[4]))) ok = false;
        }

        object[][] windowCases = new object[][]
        {
            new object[] { "visible, unowned, captioned", true, true, true, true },
            new object[] { "invisible window", false, true, true, false },
            new object[] { "owned window", true, false, true, false },
            new object[] { "window without a caption", true, true, false, false },
        };
        for (int i = 0; i < windowCases.Length; i++)
        {
            object[] row = windowCases[i];
            cases++;
            if (!CheckVerdict(row[0], (bool)row[4],
                IsQualifiedWindow((bool)row[1], (bool)row[2], (bool)row[3]))) ok = false;
        }

        object[][] locateCases = new object[][]
        {
            new object[] { "no record falls back to the pane path", 0, false, RoutePane },
            new object[] { "one record with a usable pid resumes the click", 1, true, RouteRecord },
            new object[] { "two records with one marker are ambiguous", 2, true, RouteAmbiguous },
            new object[] { "one record without a usable pid has no target", 1, false, RouteInvalid },
        };
        for (int i = 0; i < locateCases.Length; i++)
        {
            object[] row = locateCases[i];
            cases++;
            if (!CheckText(row[0], (string)row[3], LocateVerdict((int)row[1], (bool)row[2]))) ok = false;
        }

        object[][] routeCases = new object[][]
        {
            new object[] { "one terminal window routes to the pane path", true, 1, RoutePane },
            new object[] { "two terminal windows still route to the pane path", true, 2, RoutePane },
            new object[] { "one chromium window routes to the window path", false, 1, RouteWindow },
            new object[] { "two chromium windows are ambiguous", false, 2, RouteAmbiguous },
            new object[] { "no qualified window falls back to the pane path", false, 0, RoutePane },
        };
        for (int i = 0; i < routeCases.Length; i++)
        {
            object[] row = routeCases[i];
            cases++;
            if (!CheckText(row[0], (string)row[3], RouteVerdict((bool)row[1], (int)row[2]))) ok = false;
        }

        object[][] checkCases = new object[][]
        {
            new object[] { "foreground, restored and owned by the host", true, true, true, true },
            new object[] { "not the foreground window", false, true, true, false },
            new object[] { "still minimized", true, false, true, false },
            new object[] { "the window changed owner", true, true, false, false },
        };
        for (int i = 0; i < checkCases.Length; i++)
        {
            object[] row = checkCases[i];
            cases++;
            if (!CheckVerdict(row[0], (bool)row[4],
                WindowVerdict((bool)row[1], (bool)row[2], (bool)row[3]))) ok = false;
        }

        Console.Out.WriteLine(ok ? "candidate selftest passed (" + cases + " cases)" : "candidate selftest failed");
        return ok ? ExitOk : ExitUnreachable;
    }

    private static bool CheckText(object name, string expected, string actual)
    {
        if (actual == expected) return true;
        Console.Error.WriteLine("selftest failed: " + name + " expected " + expected + " got " + actual);
        return false;
    }

    private static bool CheckVerdict(object name, bool expected, bool actual)
    {
        if (actual == expected) return true;
        Console.Error.WriteLine("selftest failed: " + name + " expected " + Bool(expected) + " got " + Bool(actual));
        return false;
    }

    // The marker records the TUI writes before it sends a toast: one file per session. Only the
    // record carrying this marker can name the process to go back to. A file that cannot be
    // read, parsed or matched simply does not participate, so a corrupt neighbour can never
    // turn a click into an ambiguity.
    private static List<MarkerRecord> FindRecords(string marker)
    {
        List<MarkerRecord> matches = new List<MarkerRecord>();
        string[] files;
        try
        {
            if (dataDirectory == null) return matches;
            string directory = Path.Combine(Path.Combine(dataDirectory, "notify"), "jumpback");
            if (!Directory.Exists(directory)) return matches;
            files = Directory.GetFiles(directory, "*.json");
        }
        catch (Exception)
        {
            return matches;
        }
        for (int i = 0; i < files.Length; i++)
        {
            MarkerRecord record = ReadRecord(files[i]);
            if (record == null || record.Marker == null) continue;
            if (string.Compare(record.Marker, marker, StringComparison.Ordinal) != 0) continue;
            matches.Add(record);
        }
        return matches;
    }

    // A record that cannot be parsed is skipped rather than fatal: the click then behaves as it
    // did before records existed and takes the pane path.
    private static MarkerRecord ReadRecord(string path)
    {
        try
        {
            byte[] bytes = File.ReadAllBytes(path);
            DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(MarkerRecord));
            using (MemoryStream stream = new MemoryStream(bytes))
            {
                return (MarkerRecord)serializer.ReadObject(stream);
            }
        }
        catch (Exception)
        {
            return null;
        }
    }

    // A click whose process is gone must not move anything. Asking the process table first is
    // what keeps the window search, the restore and the foreground call out of reach.
    private static bool ProcessExists(int pid)
    {
        try
        {
            using (Process target = Process.GetProcessById(pid))
            {
                return true;
            }
        }
        catch (Exception)
        {
            return false;
        }
    }

    // The click path. Every step is verified, and when a step fails the helper stops there:
    // it never reports success for a jump it could not prove. The record decides whether there
    // is a process to go back to; that process's window classes decide which path runs.
    private static int Activate(string marker)
    {
        List<MarkerRecord> records = FindRecords(marker);
        MarkerRecord record = records.Count == 1 ? records[0] : null;
        bool usablePid = record != null && record.Pid.HasValue && record.Pid.Value > 0;
        string route = LocateVerdict(records.Count, usablePid);
        // `pane` is a route, not a failure: the click goes on down the pane path, so only the two
        // routes that stop here make this stage report ok=false - and each of them says why with
        // the same `reason=` key the other failing stages use.
        Log("stage=locate ok=" + Bool(route == RouteRecord || route == RoutePane) + " route=" + route
            + " matches=" + records.Count
            + (route == RouteRecord ? " pid=" + record.Pid.Value : "")
            + (route == RouteAmbiguous ? " reason=ambiguous" : "")
            + (route == RouteInvalid ? " reason=invalid" : ""));
        // A located record is the only route that continues to the process check. `pane` means
        // there was no record to use - the old world, where a marker written before records
        // existed, or one whose record was already swept, resolves through the pane path exactly
        // as before. `ambiguous` and `invalid` name no single process, so they stop here.
        if (route == RoutePane) return ActivatePane(marker);
        if (route != RouteRecord) return ExitUnreachable;
        int pid = record.Pid.Value;

        if (!ProcessExists(pid))
        {
            Log("stage=liveness ok=false reason=\"the process that recorded the marker is gone\" pid=" + pid);
            return ExitUnreachable;
        }
        Log("stage=liveness ok=true pid=" + pid);

        HostSearch owner = NearestOwner(pid, ProcessParents(), QualifiedWindowsOf);
        IntPtr chromiumHwnd;
        route = RouteOf(owner, out chromiumHwnd);
        if (route == RouteAmbiguous) return ExitUnreachable;
        if (route == RoutePane) return ActivatePane(marker);
        return ActivateWindow(chromiumHwnd, owner.HostPid);
    }

    // The nearest owner's window classes pick the path, and the counts go into the log: a click
    // that refuses has to say which fact refused it, and the refusal names itself with the
    // `reason=` key every other failing stage uses. The counting is shared with the probe, so its
    // promise is taken from these very facts; the Chromium handle travels back because the window
    // path is only reachable when there is exactly one of them.
    private static string RouteOf(HostSearch owner, out IntPtr chromiumHwnd)
    {
        bool hasTerminalWindow;
        int chromiumWindows;
        CountWindows(owner.Windows, out hasTerminalWindow, out chromiumWindows, out chromiumHwnd);
        string route = RouteVerdict(hasTerminalWindow, chromiumWindows);
        Log("stage=dispatch ok=" + Bool(route != RouteAmbiguous) + " route=" + route
            + (route == RouteAmbiguous ? " reason=ambiguous" : "")
            + " hostPid=" + owner.HostPid + " depth=" + owner.Depth
            + " candidates=" + owner.Windows.Count
            + " terminal=" + Bool(hasTerminalWindow) + " chromium=" + chromiumWindows);
        return route;
    }

    // The pane path (Windows Terminal), unchanged: the same discovery predicate the probe used
    // decides, and ambiguity is rejected before any window is touched.
    private static int ActivatePane(string marker)
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

        if (!RestoreAndForeground(hwnd)) return ExitUnreachable;

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

    // The window path. It stops at the window on purpose: the promise is window level, so
    // selecting a terminal or moving keyboard focus would be work whose result is not checked.
    // A failure is logged at the stage that failed and is never reported as a jump.
    private static int ActivateWindow(IntPtr hwnd, int hostPid)
    {
        Stopwatch clock = Stopwatch.StartNew();
        Log("stage=resolve ok=true hwnd=" + hwnd.ToInt64() + " hostPid=" + hostPid);

        if (!RestoreAndForeground(hwnd)) return ExitUnreachable;

        WindowChecks checks = VerifyWindow(hwnd, hostPid);
        bool ok = WindowVerdict(checks.Foreground, checks.NotMinimized, checks.OwnedByHost);
        Log("stage=verify ok=" + Bool(ok)
            + " foreground=" + Bool(checks.Foreground)
            + " notMinimized=" + Bool(checks.NotMinimized)
            + " ownedByHost=" + Bool(checks.OwnedByHost)
            + " hwnd=" + hwnd.ToInt64() + " hostPid=" + hostPid
            + " totalMs=" + clock.ElapsedMilliseconds);
        if (!ok)
        {
            Log("stage=activate ok=false reason=\"one or more of the three window checks failed\"");
            return ExitUnreachable;
        }
        Log("stage=activate ok=true route=window totalMs=" + clock.ElapsedMilliseconds);
        return ExitOk;
    }

    // The three window-level facts, each read from the live desktop after the foreground call.
    // Ownership is re-read rather than remembered because a window can be replaced while the
    // click runs, and a window a stranger owns must never be reported as the host's.
    private static WindowChecks VerifyWindow(IntPtr hwnd, int hostPid)
    {
        WindowChecks checks = new WindowChecks();
        checks.Foreground = GetForegroundWindow() == hwnd;
        checks.NotMinimized = !IsIconic(hwnd);
        uint ownerPid = 0;
        GetWindowThreadProcessId(hwnd, out ownerPid);
        checks.OwnedByHost = (int)ownerPid == hostPid;
        return checks;
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

    // The restore-then-foreground step both hosts use. The caps and attempt counts are the
    // ones the pane path has always used, so moving the sequence here cannot change them; a
    // failure is logged at the stage that failed and never reported as a jump.
    private static bool RestoreAndForeground(IntPtr hwnd)
    {
        if (IsIconic(hwnd))
        {
            ShowWindow(hwnd, SW_RESTORE);
            if (!WaitUntil(() => !IsIconic(hwnd), RestoreCapMs))
            {
                Log("stage=restore ok=false reason=\"the window is still minimized after SW_RESTORE\" hwnd=" + hwnd.ToInt64());
                return false;
            }
            Log("stage=restore ok=true hwnd=" + hwnd.ToInt64());
        }
        if (!BringToForeground(hwnd))
        {
            Log("stage=foreground ok=false reason=\"the window never became the foreground window\" hwnd=" + hwnd.ToInt64());
            return false;
        }
        Log("stage=foreground ok=true hwnd=" + hwnd.ToInt64());
        return true;
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
    // explicit argument; the fallback mirrors src/utils/paths.ts for a hand run. The log and
    // the marker records live under the same directory, so both are resolved from here.
    private static string ResolveDataDir(string dataDir)
    {
        try
        {
            if (dataDir != null && dataDir.Length > 0) return dataDir;
            string home = Environment.GetEnvironmentVariable("USERPROFILE");
            if (home == null || home.Length == 0) home = Environment.GetEnvironmentVariable("HOME");
            if (home == null || home.Length == 0) return null;
            return Path.Combine(home, ".dsh-tui");
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string LogPathOf(string directory)
    {
        if (directory == null) return null;
        try
        {
            return Path.Combine(Path.Combine(directory, "notify"), "jumpback.log");
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
