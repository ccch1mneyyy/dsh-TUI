// Private installer ownership. JOB_LIST requires Windows 10 / Server 2016.
// Assignment failures fail closed before the suspended installer can execute.
// https://learn.microsoft.com/windows/win32/procthread/nested-jobs
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshInstallerJob
{
  public sealed class Result
  {
    public int code = 127;
    public bool cleanupConfirmed = true;
    public string error;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits
  {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters
  {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits
  {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting
  {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo
  {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort ShowWindow, ReservedBytes;
    public IntPtr ReservedData, Stdin, Stdout, Stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfoEx
  {
    public StartupInfo Startup;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo
  {
    public IntPtr Process, Thread;
    public uint Pid, Tid;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute,
    IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
    ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
    out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success, string operation)
  {
    if (!success)
    {
      int code = Marshal.GetLastWin32Error();
      throw new Win32Exception(code, operation + " failed (Win32 " + code + "): " + new Win32Exception(code).Message);
    }
  }
  static bool Exited(IntPtr process)
  {
    uint result = WaitForSingleObject(process, 0);
    if (result == 0) return true;
    if (result == 258) return false;
    throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
  }
  static uint Active(IntPtr job)
  {
    Accounting info;
    Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero),
      "QueryInformationJobObject");
    return info.ActiveProcesses;
  }
  static bool Drain(IntPtr job)
  {
    Stopwatch clock = Stopwatch.StartNew();
    do
    {
      if (Active(job) == 0) return true;
      Thread.Sleep(20);
    } while (clock.ElapsedMilliseconds < 5000);
    return false;
  }
  static IntPtr StandardHandle(int which)
  {
    IntPtr source = GetStdHandle(which);
    if (source == IntPtr.Zero || source == new IntPtr(-1))
      throw new InvalidOperationException("Missing inherited installer standard handle " + which);
    IntPtr copy;
    Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out copy, 0, true, 2),
      "DuplicateHandle(standard stream)");
    return copy;
  }
  static void Close(IntPtr handle)
  {
    if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
  }

  public static Result Run(string application, string commandLine, string directory, uint parentPid, long parentNotAfterMs)
  {
    Result result = new Result();
    IntPtr parent = IntPtr.Zero, job = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    StartupInfoEx startup = new StartupInfoEx();
    IntPtr handleList = IntPtr.Zero, jobList = IntPtr.Zero;
    bool attributesInitialized = false;
    bool assigned = false;
    try
    {
      // Pin identity once, before launching anything. No PID lookup is used to
      // terminate an installer or to rediscover descendants after root exit.
      parent = OpenProcess(0x00101000, false, parentPid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
      Check(parent != IntPtr.Zero, "OpenProcess(installer owner)");
      if (Exited(parent)) throw new InvalidOperationException("Installer owner has exited");
      long created, exited, kernel, user;
      Check(GetProcessTimes(parent, out created, out exited, out kernel, out user), "GetProcessTimes(installer owner)");
      if (created / 10000 - 11644473600000L > parentNotAfterMs)
        throw new InvalidOperationException("Installer owner PID was reused before supervisor startup");
      job = CreateJobObjectW(IntPtr.Zero, null); // unnamed and non-inheritable
      Check(job != IntPtr.Zero, "CreateJobObject");
      uint handleFlags;
      Check(GetHandleInformation(job, out handleFlags), "GetHandleInformation(job)");
      if ((handleFlags & 1) != 0) throw new InvalidOperationException("Installer job handle must not be inheritable");
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x00002000; // KILL_ON_JOB_CLOSE; NEVER allow breakaway
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))),
        "SetInformationJobObject(KILL_ON_JOB_CLOSE)");
      if (File.Exists(Path.Combine(directory, "cancel"))) { result.code = 130; return result; }
      startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
      startup.Startup.Flags = 0x00000100; // STARTF_USESTDHANDLES
      startup.Startup.Stdin = StandardHandle(-10);
      startup.Startup.Stdout = StandardHandle(-11);
      startup.Startup.Stderr = StandardHandle(-12);
      UIntPtr attributeBytes = UIntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
      startup.Attributes = Marshal.AllocHGlobal(checked((int)attributeBytes.ToUInt64()));
      Check(InitializeProcThreadAttributeList(startup.Attributes, 2, 0, ref attributeBytes),
        "InitializeProcThreadAttributeList");
      attributesInitialized = true;
      handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleList, 0, startup.Startup.Stdin);
      Marshal.WriteIntPtr(handleList, IntPtr.Size, startup.Startup.Stdout);
      Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, startup.Startup.Stderr);
      Check(UpdateProcThreadAttribute(startup.Attributes, 0, new UIntPtr(0x00020002), handleList,
        new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(HANDLE_LIST)");
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(startup.Attributes, 0, new UIntPtr(0x0002000d), jobList,
        new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(JOB_LIST)");
      // Atomically assign during creation: killing the supervisor between
      // CreateProcess and a separate AssignProcessToJobObject must not leak an
      // unowned suspended installer. No breakaway or unowned fallback exists.
      Check(CreateProcessW(String.IsNullOrEmpty(application) ? null : application,
        new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
        0x00080004, IntPtr.Zero, null, ref startup, out child), "CreateProcess(CREATE_SUSPENDED, JOB_LIST)");
      result.cleanupConfirmed = false;
      assigned = true;
      bool member;
      Check(IsProcessInJob(child.Process, job, out member), "IsProcessInJob");
      if (!member) throw new InvalidOperationException("Installer job membership could not be verified");
      // Recheck cancellation/parent while the installer still cannot execute.
      if (Exited(parent) || File.Exists(Path.Combine(directory, "cancel")))
      {
        result.code = 130;
        Check(TerminateJobObject(job, 130), "TerminateJobObject");
        result.cleanupConfirmed = Drain(job);
        return result;
      }
      Check(ResumeThread(child.Thread) != 0xffffffff, "ResumeThread");
      Close(child.Thread);
      child.Thread = IntPtr.Zero;
      File.WriteAllText(Path.Combine(directory, "ready.tmp"), "{\"pid\":" + child.Pid + ",\"member\":true,\"inheritable\":false}", Encoding.ASCII);
      File.Move(Path.Combine(directory, "ready.tmp"), Path.Combine(directory, "ready"));
      while (true)
      {
        if (File.Exists(Path.Combine(directory, "cancel")) || Exited(parent))
        {
          result.code = 130;
          Check(TerminateJobObject(job, 130), "TerminateJobObject");
          result.cleanupConfirmed = Drain(job);
          if (!result.cleanupConfirmed) result.error = "Installer job did not empty after termination";
          return result;
        }
        if (Active(job) == 0)
        {
          if (WaitForSingleObject(child.Process, 5000) != 0)
            throw new InvalidOperationException("Empty installer job did not signal root exit");
          uint code;
          Check(GetExitCodeProcess(child.Process, out code), "GetExitCodeProcess");
          result.code = unchecked((int)code);
          result.cleanupConfirmed = true;
          return result;
        }
        Thread.Sleep(25);
      }
    }
    catch (Exception error)
    {
      result.code = 127;
      result.error = error.Message;
      try
      {
        if (job != IntPtr.Zero)
        {
          // Even a failed atomic assignment can briefly leave a terminating
          // process in job accounting. Confirm zero instead of assuming it.
          Check(TerminateJobObject(job, 127), "TerminateJobObject after failure");
          result.cleanupConfirmed = Drain(job);
        }
        if (!assigned && child.Process != IntPtr.Zero)
        {
          // Still suspended and never assigned: terminate only the retained
          // process handle, even when assignment failed under an outer job.
          if (!Exited(child.Process)) Check(TerminateProcess(child.Process, 127), "TerminateProcess(suspended root)");
          bool rootStopped = WaitForSingleObject(child.Process, 5000) == 0;
          result.cleanupConfirmed = result.cleanupConfirmed && rootStopped;
        }
      }
      catch (Exception cleanupError)
      {
        result.cleanupConfirmed = false;
        result.error += "; cleanup: " + cleanupError.Message;
      }
      return result;
    }
    finally
    {
      // Closing the sole job handle is a fail-safe even if confirmation failed.
      Close(job);
      Close(child.Thread);
      Close(child.Process);
      if (attributesInitialized) DeleteProcThreadAttributeList(startup.Attributes);
      if (startup.Attributes != IntPtr.Zero) Marshal.FreeHGlobal(startup.Attributes);
      if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      Close(startup.Startup.Stdin);
      Close(startup.Startup.Stdout);
      Close(startup.Startup.Stderr);
      Close(parent);
    }
  }
}
