/**
 * 「谁占着这个文件」—— Restart Manager 查询脚本。
 *
 * 为什么单独一段脚本（而不是并进 cleaner/script.ts）：
 *   传给 powershell.exe 的 -EncodedCommand 最终落到 Windows 命令行上，上限 32767 字符。
 *   删除判定那段已经很大（含 SHFileOperation + 残留量测），再塞进 Restart Manager 的
 *   P/Invoke 就会超限 —— 实测报 `spawn ENAMETOOLONG`，清理直接全军覆没。
 *   拆开之后两段各自只有原来的一小半，留有充足余量；代价是同一个进程要起两次 PowerShell。
 *
 * 为什么需要它：
 *   Windows 没有别的公开接口能回答"这个文件被哪个进程开着"。Restart Manager 是
 *   安装程序判断"能不能替换这个文件"用的官方接口，返回的就是持有句柄的 PID 与程序名。
 *
 * 两个必须注意的点：
 *   1. **一次会话只问一个文件**。RmRegisterResources 的资源在同一会话内是累加的，
 *      循环注册会让每个文件都返回"这一批里所有占用者"的并集（实测踩过：25 个文件
 *      报出同一串 25 个进程），于是每个文件的占用者都成了假的。
 *   2. 会话必须 RmEndSession 配对释放，否则句柄泄漏。
 *
 * I/O 约定：待查路径经环境变量 OPS_CABIN_HOLDER_LIST 指向一个换行分隔的文本文件
 * （路径里的引号/中文/分号破坏不了脚本），输出 `{"path":...,"holders":["名字|PID"]}` 行。
 */

/** 待查清单的路径（换行分隔）经这个环境变量传给脚本 */
export const HOLDER_LIST_ENV = 'OPS_CABIN_HOLDER_LIST'

/**
 * 最多查几个文件。
 * 一个被占文件可能列出一串持有者（Edge 每个渲染进程都开同一份共享内存），
 * 而每个文件又要单独开一次 RM 会话，路径越多越慢 —— 几个足以说明是谁在占。
 */
export const HOLDER_SAMPLE_MAX = 4

/** 单个文件最多回报几个持有进程 */
const HOLDER_PER_FILE_MAX = 8

export const HOLDER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$holderMax = ${HOLDER_PER_FILE_MAX}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class HolderResult {
  public string path = "";
  public List<string> holders = new List<string>();   // "进程名|PID"
}

public static class OpsCabinHolder {
  [StructLayout(LayoutKind.Sequential)]
  private struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public int TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
                                                uint nApplications, RM_UNIQUE_PROCESS[] rgApplications,
                                                uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
                                      [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

  private static string JsonStr(string s) {
    if (s == null) return "\"\"";
    StringBuilder b = new StringBuilder(s.Length + 8);
    b.Append('"');
    foreach (char c in s) {
      if (c == '\\') b.Append("\\\\");
      else if (c == '"') b.Append("\\\"");
      else if (c == '\r' || c == '\n' || c == '\t') b.Append(' ');
      else b.Append(c);
    }
    b.Append('"');
    return b.ToString();
  }

  /** 问一个文件：返回 "进程名|PID" 列表（空列表 = 没人占，句柄已经放掉了） */
  public static List<string> Ask(string path, int max) {
    List<string> found = new List<string>();
    string full;
    try { full = System.IO.Path.GetFullPath(path); } catch (Exception) { return found; }

    uint session = 0;
    StringBuilder key = new StringBuilder(33);
    if (RmStartSession(out session, 0, key) != 0) return found;
    try {
      string[] files = new string[] { full };
      if (RmRegisterResources(session, 1, files, 0, null, 0, null) != 0) return found;

      uint needed = 0;
      uint count = 0;
      uint why = 0;
      int rc = RmGetList(session, out needed, ref count, null, ref why);
      if (needed == 0) return found;             // 无人占用
      if (rc != 0 && rc != 234) return found;    // 234 = ERROR_MORE_DATA，正常

      RM_PROCESS_INFO[] buf = new RM_PROCESS_INFO[needed];
      count = needed;
      if (RmGetList(session, out needed, ref count, buf, ref why) != 0) return found;
      for (uint i = 0; i < count && found.Count < max; i++) {
        string app = buf[i].strAppName;
        if (app == null || app.Length == 0) app = "";
        found.Add(app + "|" + buf[i].Process.dwProcessId);
      }
    } finally {
      RmEndSession(session);
    }
    return found;
  }

  public static string ToJson(HolderResult r) {
    StringBuilder b = new StringBuilder(256);
    b.Append("{\"path\":").Append(JsonStr(r.path)).Append(",\"holders\":[");
    for (int i = 0; i < r.holders.Count; i++) {
      if (i > 0) b.Append(",");
      b.Append(JsonStr(r.holders[i]));
    }
    b.Append("]}");
    return b.ToString();
  }
}
'@

$listPath = $env:OPS_CABIN_HOLDER_LIST
if (-not $listPath -or -not (Test-Path -LiteralPath $listPath)) { exit 0 }
$paths = @()
try {
  $reader = New-Object System.IO.StreamReader($listPath, [System.Text.Encoding]::UTF8, $true)
  while ($true) {
    $line = $reader.ReadLine()
    if ($line -eq $null) { break }
    if (-not [string]::IsNullOrWhiteSpace($line)) { $paths += $line.Trim() }
  }
  $reader.Close()
} catch {
  exit 0
}

foreach ($p in $paths) {
  $r = New-Object HolderResult
  $r.path = $p
  try {
    $r.holders = [OpsCabinHolder]::Ask($p, $holderMax)
  } catch {
    $r.holders = New-Object 'System.Collections.Generic.List[string]'
  }
  Write-Output ([OpsCabinHolder]::ToJson($r))
}
`
