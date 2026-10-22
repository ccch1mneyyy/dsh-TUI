// Independent test containment, never a substitute installer implementation.
// The worker cannot launch anything until its process handle is in this job.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class InstallerAcceptanceGuard
{
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessBasicInformation {
    public IntPtr Reserved1, Peb, Reserved2, Reserved3, UniquePid, ParentPid;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint length, out uint returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int kind, ref ProcessBasicInformation info, int size, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static void Check(bool value, string operation) {
    if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      slashes = 0;
      result.Append(c);
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static uint Active(IntPtr job) {
    int size = Marshal.SizeOf(typeof(Accounting));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      uint returned;
      Check(QueryInformationJobObject(job, 1, buffer, (uint)size, out returned), "Query job accounting");
      return ((Accounting)Marshal.PtrToStructure(buffer, typeof(Accounting))).ActiveProcesses;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static void KillSupervisor(IntPtr job, int workerPid) {
    // Query only this guard's own job. Every candidate is pinned by a handle
    // before identity/membership checks; numeric PIDs are never termination targets.
    const int capacity = 128;
    IntPtr buffer = Marshal.AllocHGlobal(8 + capacity * IntPtr.Size);
    try {
      uint returned;
      Check(QueryInformationJobObject(job, 3, buffer, (uint)(8 + capacity * IntPtr.Size), out returned), "Query owned job members");
      int count = Marshal.ReadInt32(buffer, 4);
      IntPtr target = IntPtr.Zero;
      try {
        for (int i = 0; i < count; i++) {
          uint pid = (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
          IntPtr handle = OpenProcess(0x1000 | 0x0400 | 0x0001, false, pid);
          if (handle == IntPtr.Zero) continue;
          bool keep = false;
          try {
            bool member;
            Check(IsProcessInJob(handle, job, out member), "Verify owned process");
            ProcessBasicInformation info = new ProcessBasicInformation();
            int length;
            if (!member || NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(ProcessBasicInformation)), out length) != 0
              || info.ParentPid.ToInt64() != workerPid) continue;
            StringBuilder name = new StringBuilder(32768);
            uint size = (uint)name.Capacity;
            Check(QueryFullProcessImageName(handle, 0, name, ref size), "Read owned process image");
            if (!String.Equals(Path.GetFileName(name.ToString()), "powershell.exe", StringComparison.OrdinalIgnoreCase)) continue;
            if (target != IntPtr.Zero) throw new Exception("Ambiguous supervisor; refusing to terminate either process");
            target = handle;
            keep = true;
          } finally { if (!keep) CloseHandle(handle); }
        }
        if (target == IntPtr.Zero) throw new Exception("No live owned supervisor to fault");
        Check(TerminateProcess(target, 99), "Terminate exact owned supervisor handle");
      } finally { if (target != IntPtr.Zero) CloseHandle(target); }
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static int Run(string node, string script, string root, string mode) {
    IntPtr job = IntPtr.Zero;
    Process worker = null;
    bool assigned = false;
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create acceptance guard job");
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
      if (mode == "restricted") {
        limits.Basic.LimitFlags |= 0x0008;
        limits.Basic.ActiveProcessLimit = 1; // Worker only; supervisor launch must fail closed.
      }
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Set guard limits");
      ProcessStartInfo start = new ProcessStartInfo(node, Quote(script) + " --worker " + Quote(root) + " " + Quote(mode));
      if (mode == "native-denial") {
        string denialScript = Path.Combine(Path.GetDirectoryName(script), "fixtures", "update-process-windows", "native-denial.ps1");
        start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
          "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(denialScript)
          + " -NodePath " + Quote(node) + " -RootPath " + Quote(root) + " -GuardPid " + Process.GetCurrentProcess().Id);
      }
      start.UseShellExecute = false;
      worker = Process.Start(start);
      Check(AssignProcessToJobObject(job, worker.Handle), "Assign waiting worker to guard job");
      assigned = true;
      File.WriteAllText(Path.Combine(root, mode + ".go"), "assigned");
      Stopwatch clock = Stopwatch.StartNew();
      bool faulted = false;
      bool limited = false;
      while (!worker.WaitForExit(50)) {
        if (clock.ElapsedMilliseconds > (mode == "normal" ? 240000 : 60000)) throw new Exception("Acceptance worker exceeded its native time bound");
        if (mode == "native-denial" && !limited && File.Exists(Path.Combine(root, "native-denial.compiled")) && Active(job) == 1) {
          limits.Basic.LimitFlags |= 0x0008;
          limits.Basic.ActiveProcessLimit = 1;
          Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Deny native installer process creation after compilation");
          limited = true;
          File.WriteAllText(Path.Combine(root, "native-denial.limited"), "native worker only");
        }
        string fault = Path.Combine(root, "fault.request");
        if (mode == "normal" && !faulted && File.Exists(fault)) {
          KillSupervisor(job, worker.Id);
          faulted = true;
          File.WriteAllText(Path.Combine(root, "fault.done"), "terminated pinned supervisor");
        }
      }
      int code = worker.ExitCode;
      Stopwatch drain = Stopwatch.StartNew();
      while (Active(job) != 0 && drain.ElapsedMilliseconds < 5000) Thread.Sleep(50);
      uint remaining = Active(job);
      Console.WriteLine("{\"case\":\"guard-" + mode + "\",\"activeProcesses\":" + remaining + ",\"workerExitCode\":" + code + "}");
      if (remaining != 0) throw new Exception("Owned processes remained after worker exit: " + remaining);
      return code;
    } catch (Exception error) {
      Console.Error.WriteLine(error.ToString());
      return 1;
    } finally {
      // Cleanup targets the retained job handle, never a discovered PID/tree.
      if (job != IntPtr.Zero) {
        if (!TerminateJobObject(job, 98)) Console.Error.WriteLine("Guard cleanup failed: " + Marshal.GetLastWin32Error());
        CloseHandle(job);
      }
      if (worker != null) {
        if (!assigned && !worker.HasExited) worker.Kill(); // Retained Process handle, waiting worker has spawned nothing.
        worker.WaitForExit(5000);
        worker.Dispose();
      }
    }
  }
}
