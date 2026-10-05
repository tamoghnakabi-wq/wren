import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';
import { tracked } from './proctree';

// Windows: each agent shell command puts its own PowerShell process in a new Job Object that ends
// every process in it when the last handle closes. Only that PowerShell process holds the handle,
// so when the command ends (or is stopped), everything it started ends with it, however it was
// started. Nothing breaks away: the job doesn't allow it. The few lines of C# that call the
// Job Object API are compiled once with PowerShell's own Add-Type into Wren's data folder.
//
// Without an OS sandbox on Windows this keeps ordinary leftovers in check; it is not a barrier
// against a command set on escaping (proctree.ts still checks by parent id).

const SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class WrenJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimits; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr held;
  public static bool Contain() {
    IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) return false;
    Extended info = new Extended();
    info.BasicLimits.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended)))) return false;
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) return false;
    held = job; // never closed here: it closes when this process exits
    return true;
  }
}
`;

/** Runs before every agent command on Windows (the command follows it in the same -Command script). */
export const JOB_PRELUDE =
  'if ($env:WREN_JOB_DLL) { try { Add-Type -Path $env:WREN_JOB_DLL -ErrorAction Stop; $null = [WrenJob]::Contain() } catch { } }; Remove-Item Env:WREN_JOB_DLL -ErrorAction SilentlyContinue';

let building: Promise<string | null> | null = null;

/** The compiled helper (built on first use), or null if it couldn't be built: commands then run without a job. */
export function jobLibrary(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  building ??= new Promise((resolve) => {
    const dir = join(dataDir(), 'bin');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, 'WrenJob-1.dll');
    if (existsSync(out)) return resolve(out);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -TypeDefinition $env:WREN_JOB_SRC -OutputAssembly $env:WREN_JOB_OUT -OutputType Library'],
      { windowsHide: true, timeout: 120_000, env: { ...process.env, WREN_JOB_SRC: SOURCE, WREN_JOB_OUT: out } },
      (err) => resolve(!err && existsSync(out) ? out : null),
    );
  });
  return building;
}

/** Run an agent command in PowerShell, contained in its own Job Object when the helper is available. */
export async function spawnContained(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const dll = await jobLibrary();
  return tracked(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${JOB_PRELUDE}\n${command}`], { cwd, env: dll ? { ...env, WREN_JOB_DLL: dll } : env, windowsHide: true }));
}
