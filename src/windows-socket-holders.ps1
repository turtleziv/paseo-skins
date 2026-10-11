# Prints a JSON array of the live processes ({pid, name}) holding the socket bound on
# 127.0.0.1:<Port>, including processes that inherited it from an owner that has exited.
# Get-NetTCPConnection only reports the creating PID, so this enumerates system handles
# (NtQuerySystemInformation class 64), duplicates Winsock socket handles (access mask
# 0x0016019F) from processes this user can open, and asks getsockname on each in turn.
# Sockets with pending synchronous I/O block getsockname and parallel queries contend inside
# Winsock, so each query gets a 150 ms box. Processes started after the socket was created
# (where inheritors are) are queried first and skipped only after three blocked queries; any
# other process is skipped after one. With -OwnerExited, once a holder is found only those
# recent processes are still queried (about 1 s). The whole sweep stops at -SweepMilliseconds,
# so a long sweep can miss holders. Read-only toward the queried processes.
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [switch]$OwnerExited,
  [int]$SweepMilliseconds = 15000
)
$ErrorActionPreference = 'Stop'

$listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $Port -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $listener) { Write-Output '[]'; exit 0 }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class PaseoSocketHolders {
    [StructLayout(LayoutKind.Sequential)]
    struct Entry {
        public IntPtr Object; public UIntPtr Pid; public UIntPtr Handle; public uint Access;
        public ushort BackTrace; public ushort TypeIndex; public uint Attributes; public uint Reserved;
    }
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr b, int l, out int r);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint a, bool i, uint o);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateFileW([MarshalAs(UnmanagedType.LPWStr)] string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
    [DllImport("ws2_32.dll")] static extern int WSAStartup(ushort v, byte[] d);
    [DllImport("ws2_32.dll")] static extern int getsockname(IntPtr s, byte[] name, ref int len);

    const uint PROCESS_DUP_HANDLE = 0x40, DUPLICATE_SAME_ACCESS = 2, SOCKET_ACCESS = 0x0016019F;

    static List<Entry> Handles() {
        int size = 1 << 22;
        while (true) {
            IntPtr buf = Marshal.AllocHGlobal(size);
            int ret; int status = NtQuerySystemInformation(64, buf, size, out ret);
            if (status == unchecked((int)0xC0000004)) { Marshal.FreeHGlobal(buf); size = Math.Max(size * 2, ret + 65536); continue; }
            if (status != 0) { Marshal.FreeHGlobal(buf); throw new Exception("NtQuerySystemInformation 0x" + status.ToString("X")); }
            long count = (long)Marshal.ReadIntPtr(buf);
            int entrySize = Marshal.SizeOf(typeof(Entry));
            var list = new List<Entry>((int)count);
            IntPtr p = buf + IntPtr.Size * 2;
            for (long i = 0; i < count; i++) list.Add((Entry)Marshal.PtrToStructure(p + (int)(i * entrySize), typeof(Entry)));
            Marshal.FreeHGlobal(buf);
            return list;
        }
    }

    // The File object type index, learned from a handle this process holds open in the snapshot.
    static ushort FileTypeIndex(List<Entry> handles, uint self, IntPtr h) {
        foreach (var e in handles)
            if ((uint)e.Pid == self && e.Handle == (UIntPtr)(ulong)h.ToInt64()) return e.TypeIndex;
        throw new Exception("File type index not found");
    }

    static int BoundLoopbackPort(IntPtr s) {
        var name = new byte[128]; int len = name.Length;
        if (getsockname(s, name, ref len) != 0) return -1;
        if (BitConverter.ToUInt16(name, 0) != 2) return -1;
        if (name[4] != 127 || name[5] != 0 || name[6] != 0 || name[7] != 1) return -1;
        return (name[2] << 8) | name[3];
    }

    class Query { public uint Pid; public IntPtr Dup; public int Port = -1; public bool Suspect; }

    static bool StartedAfter(uint pid, DateTime socketCreated, Dictionary<uint, bool> cache) {
        bool suspect;
        if (cache.TryGetValue(pid, out suspect)) return suspect;
        try { suspect = Process.GetProcessById((int)pid).StartTime >= socketCreated.AddSeconds(-1); }
        catch { suspect = false; }
        cache[pid] = suspect;
        return suspect;
    }

    public static uint[] Find(int port, bool ownerExited, DateTime socketCreated, int perQueryMilliseconds,
            int sweepMilliseconds) {
        int wsa = WSAStartup(0x0202, new byte[512]);
        if (wsa != 0) throw new Exception("WSAStartup failed: " + wsa);
        uint self = (uint)Process.GetCurrentProcess().Id;
        IntPtr nul = CreateFileW("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (nul == new IntPtr(-1)) throw new Exception("Opening NUL failed: " + Marshal.GetLastWin32Error());
        List<Entry> handles;
        ushort fileType;
        try {
            handles = Handles();
            fileType = FileTypeIndex(handles, self, nul);
        } finally { CloseHandle(nul); }
        var processes = new Dictionary<uint, IntPtr>();
        var suspects = new Dictionary<uint, bool>();
        var queries = new List<Query>();
        foreach (var e in handles) {
            uint pid = (uint)e.Pid;
            if (e.TypeIndex != fileType || e.Access != SOCKET_ACCESS || pid == self || pid <= 4) continue;
            IntPtr proc;
            if (!processes.TryGetValue(pid, out proc)) { proc = OpenProcess(PROCESS_DUP_HANDLE, false, pid); processes[pid] = proc; }
            if (proc == IntPtr.Zero) continue;
            IntPtr dup;
            if (!DuplicateHandle(proc, (IntPtr)(long)(ulong)e.Handle, GetCurrentProcess(), out dup, 0, false, DUPLICATE_SAME_ACCESS)) continue;
            queries.Add(new Query { Pid = pid, Dup = dup, Suspect = StartedAfter(pid, socketCreated, suspects) });
        }
        foreach (var h in processes.Values) if (h != IntPtr.Zero) CloseHandle(h);
        queries.Sort((a, b) => b.Suspect.CompareTo(a.Suspect));
        var blocks = new Dictionary<uint, int>();
        var holders = new List<uint>();
        var deadline = DateTime.UtcNow.AddMilliseconds(sweepMilliseconds);
        foreach (var q in queries) {
            int blocked; blocks.TryGetValue(q.Pid, out blocked);
            bool skip = DateTime.UtcNow > deadline || holders.Contains(q.Pid) ||
                blocked >= (q.Suspect ? 3 : 1) || (!q.Suspect && ownerExited && holders.Count > 0);
            if (skip) { CloseHandle(q.Dup); continue; }
            var query = q;
            var worker = new System.Threading.Thread(() => {
                query.Port = BoundLoopbackPort(query.Dup);
                CloseHandle(query.Dup);
            }, 64 * 1024);
            worker.IsBackground = true;
            worker.Start();
            if (!worker.Join(perQueryMilliseconds)) blocks[q.Pid] = blocked + 1;
            else if (q.Port == port) holders.Add(q.Pid);
        }
        return holders.ToArray();
    }
}
'@

$holders = foreach ($holderPid in [PaseoSocketHolders]::Find($Port, $OwnerExited.IsPresent, $listener.CreationTime, 150, $SweepMilliseconds)) {
  $process = Get-Process -Id $holderPid -ErrorAction SilentlyContinue
  [pscustomobject]@{ pid = [int]$holderPid; name = $(if ($process) { $process.ProcessName } else { $null }) }
}
ConvertTo-Json -InputObject @($holders) -Compress
