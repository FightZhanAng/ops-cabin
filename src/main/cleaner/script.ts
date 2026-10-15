/**
 * 清理判定的 PowerShell 脚本：删除一个条目，并把"删掉了多少、还剩什么"量出来。
 *
 * 为什么不用 node:fs 直接删：
 *   回收站模式要靠 shell32 的 SHFileOperation（FOF_ALLOWUNDO），Node 没有等价能力；
 *   而 SHFileOperation 是 Windows 官方删除路径，权限、长路径、junction 都已由系统处理。
 *
 * 为什么必须**逐条目**执行（这一步是清理可靠性的关键）：
 *   SHFileOperation 对"部分失败"只回一个非 0，看不出删掉多少、也看不出卡在哪个文件；
 *   更糟的是回收站模式（FOF_ALLOWUNDO）遇到内含被占用文件的目录会返回 124 并
 *   **整体取消** —— 一个字节都不删。早期实现把整棵目录树交给它，于是
 *   "3.5 GB 只因为 20 个小文件被占就一项都没删成，界面只显示『1 项失败（文件正被占用）』"。
 *   逐条目执行后，能删的条目当场删掉，删不掉的才进入残留量测，再由相邻的
 *   holder.ts 点名持有进程。
 *
 * 关于「谁占着」为什么不在这个脚本里问：
 *   整段脚本经 -EncodedCommand 落到 Windows 命令行，上限 32767 字符（实测超限报
 *   `spawn ENAMETOOLONG`）。Restart Manager 的 P/Invoke 放在 holder.ts 单独一段跑。
 *
 * I/O 约定：
 *   清单文件路径经环境变量 OPS_CABIN_CLEAN_LIST 传入（路径里的引号/中文破坏不了脚本）；
 *   每条目输出一行 JSON，由 cleaner.ts 的 parseCleanerOutput 解析，
 *   故 C# 里的字符串拼接全部手写转义，不引第三方 JSON 库。
 */

/** 清单文件路径经这个环境变量传给脚本 */
export const CLEAN_LIST_ENV = 'OPS_CABIN_CLEAN_LIST'

/** 残留递归枚举的文件数上限：超过就只报数字，不再继续（避免超大目录把内存吃光） */
const RESIDUE_WALK_LIMIT = 500000

/** 条目失败时最多回报几个残留文件样本（样本会被逐个拿去点名） */
const SAMPLE_LIMIT = 4

/**
 * 清理脚本。用 String.raw 是为了让 C# 里的 "\0\0" 原样落到脚本里
 * —— 普通模板串会把 \0 变成真正的 NUL 字符，pFrom 的双 NUL 结尾就废了。
 */
export const CLEAN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

/** 一个条目的判定结果 */
public sealed class CleanProbe {
  public string path = "";
  public bool isDir;
  public int code;                 // SHFileOperation 返回码
  public bool ok;                  // 条目本身已经不在磁盘上
  public long walkBytes = 0;       // 残留的原始字节数（量测前）
  public int walkFiles = 0;        // 残留的原始文件数（量测前）
  public long bytes = 0;           // 真正删不掉的残留字节
  public int files = 0;            // 真正删不掉的残留文件数
  public int residueItems = 0;     // 残留顶层条目数
  public bool partial = false;     // 有内容被删掉、也有内容残留
  public bool pruned = false;      // 残留量测阶段**真的删掉了**文件（不是被占的那些）
  public bool truncated = false;   // 残留被截断（超过枚举上限）
  public List<string> samples = new List<string>();
  public List<int> errs = new List<int>();   // 残留项上撞到的 Win32 错误码（去重）
}

public static class OpsCabinClean {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    public string pFrom;
    public string pTo;
    public ushort fFlags;
    public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    public string lpszProgressTitle;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
                                          IntPtr lpSecurityAttributes, uint dwCreationDisposition,
                                          uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll")]
  private static extern uint GetLastError();

  private const uint DELETE = 0x00010000;
  private const uint FILE_SHARE_ALL = 0x1 | 0x2 | 0x4;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint READONLY = 0x00000001;
  private const uint HIDDEN = 0x00000002;

  private static string Esc(string s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      if (c == '\\') b.Append("\\\\");
      else if (c == '"') b.Append("\\\"");
      else if (c == '\r' || c == '\n' || c == '\t') b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }

  private static string JsonStr(string s) {
    return "\"" + Esc(s) + "\"";
  }

  /** 能不能删/改名：以只求 DELETE 权限 + 完全共享打开目标；被拒就是真删不掉 */
  private static bool CanDelete(string p, out int lastErr) {
    lastErr = 0;
    IntPtr h = CreateFile(p, DELETE, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (h == new IntPtr(-1)) {
      lastErr = (int)GetLastError();     // 32 = 被别人占着；5 = 拒绝访问；19 = 介质写保护
      return false;
    }
    CloseHandle(h);
    return true;
  }

  public static int Delete(string path, bool toRecycleBin) {
    SHFILEOPSTRUCT op = new SHFILEOPSTRUCT();
    op.wFunc = 0x0003;                 // FO_DELETE
    op.pFrom = path + "\0\0";          // 多路径以 \0 分隔、末尾双 \0
    ushort flags = 0x0010 | 0x0004 | 0x0400 | 0x0200;   // NOCONFIRMATION|SILENT|NOERRORUI|NOCONFIRMMKDIR
    if (toRecycleBin) flags |= 0x0040;                  // ALLOWUNDO
    op.fFlags = flags;
    return SHFileOperation(ref op);
  }

  /** 自下而上删自己能删的，返回仍然存在（= 被占 / 受限）的文件；空目录一并清掉 */
  private static List<string> Prune(string root, ref long bytes, ref int files, ref int lastErr) {
    List<string> left = new List<string>();
    Stack<string> dirs = new Stack<string>();
    dirs.Push(root);
    while (dirs.Count > 0) {
      string dir = dirs.Pop();
      string[] fs;
      string[] subs;
      try { fs = Directory.GetFiles(dir); } catch (Exception) { fs = new string[0]; }
      try { subs = Directory.GetDirectories(dir); } catch (Exception) { subs = new string[0]; }
      foreach (string s in subs) dirs.Push(s);
      foreach (string f in fs) {
        try {
          FileAttributes at = File.GetAttributes(f);
          if ((at & FileAttributes.ReadOnly) != 0) {
            File.SetAttributes(f, (FileAttributes)((uint)at & ~READONLY));
          }
          File.Delete(f);
        } catch (Exception) {
          left.Add(f);
          int probe;
          if (!CanDelete(f, out probe) && lastErr == 0) lastErr = probe;
          try { bytes += new FileInfo(f).Length; } catch (Exception) { }
          files++;
        }
      }
      foreach (string s in subs) {
        try {
          FileAttributes at = File.GetAttributes(s);
          if ((at & (FileAttributes.Hidden | FileAttributes.ReadOnly)) != 0) {
            File.SetAttributes(s, (FileAttributes)((uint)at & ~(HIDDEN | READONLY)));
          }
        } catch (Exception) { }
        try { Directory.Delete(s, false); } catch (Exception) { }
      }
    }
    return left;
  }

  /**
   * 删除后重新量残留。
   *
   * 对残留的顶层条目做一次"自下而上能删就删"：删得掉的说明不是被占（回收站模式
   * 整体取消时，整棵树其实一个都没删，这一步能把没被占的部分真正清掉）；
   * 删不掉的正是被占用/受限的那些 —— 它们才是要报给用户、并拿去点名的文件。
   */
  private static void ScanResidue(CleanProbe r, int sampleLimit, int walkLimit) {
    List<string> samples = new List<string>();

    if (!r.isDir) {
      if (File.Exists(r.path)) {
        long size = 0;
        try { size = new FileInfo(r.path).Length; } catch (Exception) { }
        r.walkBytes = size;
        r.walkFiles = 1;
        r.bytes = size;
        r.files = 1;
        r.residueItems = 1;
        int err;
        if (CanDelete(r.path, out err)) {
          // 能删却没删掉：多半只是"没进成回收站"这类失败，不是被占用。
          // 这里**不补删**（补删是永久删除，会绕开用户选的回收站）—— 只如实归类。
          samples.Add(r.path);
        } else {
          if (err != 0) r.errs.Add(err);
          samples.Add(r.path);
        }
      }
      r.samples = samples;
      return;
    }

    if (!Directory.Exists(r.path)) {
      r.samples = samples;
      return;
    }

    string[] first;
    try { first = Directory.GetFileSystemEntries(r.path); } catch (Exception) { first = new string[0]; }
    r.residueItems = first.Length;

    long bytes = 0;
    int files = 0;
    foreach (string e in first) {
      bool isDir = false;
      try { isDir = (File.GetAttributes(e) & FileAttributes.Directory) != 0; } catch (Exception) { }
      if (!isDir) {
        files++;
        try { bytes += new FileInfo(e).Length; } catch (Exception) { }
      }
    }
    // 目录里的内容也要计数：只算顶层会把"几乎全删掉的目录"报成 0
    foreach (string e in first) {
      bool isDir = false;
      try { isDir = (File.GetAttributes(e) & FileAttributes.Directory) != 0; } catch (Exception) { }
      if (!isDir) continue;
      if (files >= walkLimit) { r.truncated = true; break; }
      CountTree(e, ref bytes, ref files, walkLimit);
    }

    // 逐个顶层条目探"删不掉的那部分"
    long stuckBytes = 0;
    int stuckFiles = 0;
    int lastErr = 0;
    foreach (string e in first) {
      bool isDir = false;
      try { isDir = (File.GetAttributes(e) & FileAttributes.Directory) != 0; } catch (Exception) { }
      if (!isDir) {
        int err;
        if (!CanDelete(e, out err)) {
          stuckFiles++;
          if (err != 0 && lastErr == 0) lastErr = err;
          try { stuckBytes += new FileInfo(e).Length; } catch (Exception) { }
          if (samples.Count < sampleLimit) samples.Add(e);
        }
        continue;
      }
      List<string> left = Prune(e, ref stuckBytes, ref stuckFiles, ref lastErr);
      foreach (string f in left) {
        if (samples.Count < sampleLimit) samples.Add(f);
      }
    }

    r.walkBytes = bytes;
    r.walkFiles = files;
    r.files = stuckFiles;
    r.bytes = stuckBytes;
    // 量测阶段确实删掉了东西：回收站模式被整体取消后，没被占的那部分是被这里清掉的
    // （这一步是**永久删除**，与界面上选的"回收站"不同）—— 必须如实标出来，否则
    // 界面会在 releasedBytes>0 的同时说"一个文件都没删"。
    r.pruned = stuckBytes < bytes || stuckFiles < files;
    r.samples = samples;
    if (lastErr != 0) r.errs.Add(lastErr);
  }

  private static void CountTree(string root, ref long bytes, ref int files, int walkLimit) {
    Stack<string> stack = new Stack<string>();
    stack.Push(root);
    while (stack.Count > 0) {
      string dir = stack.Pop();
      string[] fs;
      string[] subs;
      try { fs = Directory.GetFiles(dir); } catch (Exception) { fs = new string[0]; }
      try { subs = Directory.GetDirectories(dir); } catch (Exception) { subs = new string[0]; }
      foreach (string s in subs) stack.Push(s);
      foreach (string f in fs) {
        if (files >= walkLimit) return;
        files++;
        try { bytes += new FileInfo(f).Length; } catch (Exception) { }
      }
    }
  }

  /**
   * 处理一个条目：删 -> 量残留。
   *
   * 返回码语义（本机实测）：
   *   0   条目已不在磁盘上
   *   32  部分失败：能删的删掉了，剩下的被占/受限
   *   124 回收站模式对目录整体放弃：一个字节都没动（FOF_ALLOWUNDO 遇到占用的目录会取消）
   */
  public static CleanProbe Process(string path, bool toRecycleBin, int sampleLimit, int walkLimit) {
    CleanProbe r = new CleanProbe();
    r.path = path;
    try {
      if ((File.GetAttributes(path) & FileAttributes.Directory) != 0) r.isDir = true;
    } catch (Exception) {
      r.ok = true;      // 目标已经不在了：目的达成
      return r;
    }

    r.code = Delete(path, toRecycleBin);
    if (r.code == 0) {
      r.ok = !(File.Exists(path) || Directory.Exists(path));
      if (r.ok) return r;
    }

    ScanResidue(r, sampleLimit, walkLimit);
    r.ok = !(File.Exists(path) || Directory.Exists(path));
    if (r.ok) return r;
    // 有内容被删掉、又有内容残留：返回码不会是 0，但"部分成功"必须让它自己站出来，
    // 否则界面会把"删掉了一半"说成"一项都没删成"。
    r.partial = true;
    return r;
  }

  /** 把判定结果拼成一行 JSON（TS 侧只认这行，不解析 CLIXML 之类的噪音） */
  public static string ToJson(CleanProbe r) {
    StringBuilder b = new StringBuilder(512);
    b.Append("{\"path\":").Append(JsonStr(r.path));
    b.Append(",\"code\":").Append(r.code);
    b.Append(",\"ok\":").Append(r.ok ? "true" : "false");
    b.Append(",\"isDir\":").Append(r.isDir ? "true" : "false");
    b.Append(",\"bytes\":").Append(r.bytes);
    b.Append(",\"files\":").Append(r.files);
    b.Append(",\"residueItems\":").Append(r.residueItems);
    b.Append(",\"partial\":").Append(r.partial ? "true" : "false");
    b.Append(",\"pruned\":").Append(r.pruned ? "true" : "false");
    b.Append(",\"truncated\":").Append(r.truncated ? "true" : "false");
    b.Append(",\"errs\":[");
    for (int i = 0; i < r.errs.Count; i++) {
      if (i > 0) b.Append(",");
      b.Append(r.errs[i]);
    }
    b.Append("],\"samples\":[");
    for (int i = 0; i < r.samples.Count; i++) {
      if (i > 0) b.Append(",");
      b.Append(JsonStr(r.samples[i]));
    }
    b.Append("]}");
    return b.ToString();
  }
}
'@

# 输出编码：本机实测 powershell.exe 把重定向 stdout 写成 UTF-8（"运维舱" 原样返回），
# 与 Node 侧的 chunk.toString('utf8') 一致，所以这里**不动** [Console]::OutputEncoding
# —— 显式改成 GetEncoding(OEM) 反而会把中文写成 GBK 而让 TS 侧解出乱码。
$listPath = $env:OPS_CABIN_CLEAN_LIST
if (-not $listPath -or -not (Test-Path -LiteralPath $listPath)) {
  Write-Output '{"error":"清单文件缺失"}'
  exit 0
}
try {
  # 用 StreamReader + 探测 BOM：不依赖运行时对 -Encoding UTF8 的默认值差异
  $reader = New-Object System.IO.StreamReader($listPath, [System.Text.Encoding]::UTF8, $true)
  $paths = @()
  while ($true) {
    $line = $reader.ReadLine()
    if ($line -eq $null) { break }
    if (-not [string]::IsNullOrWhiteSpace($line)) { $paths += $line.Trim() }
  }
  $reader.Close()
} catch {
  Write-Output '{"error":"清单读取失败"}'
  exit 0
}

foreach ($p in $paths) {
  try {
    $r = [OpsCabinClean]::Process($p, $TO_RECYCLE, $SAMPLE_LIMIT, $WALK_LIMIT)
    Write-Output ([OpsCabinClean]::ToJson($r))
  } catch {
    Write-Output ('{"path":"' + $p.Replace('\', '\\').Replace('"', '\"') + '","code":-1,"ok":false,"isDir":false,"bytes":0,"files":0,"residueItems":0,"partial":false,"truncated":false,"samples":[]}')
  }
}
`

/** 生成可直接交给 runPowerShell 的脚本（把编译期已知的开关折进脚本头部） */
export function buildCleanScript(options: {
  toRecycleBin: boolean
  sampleLimit?: number
  walkLimit?: number
}): string {
  const head = [
    `$TO_RECYCLE = $${options.toRecycleBin ? 'true' : 'false'}`,
    `$SAMPLE_LIMIT = ${options.sampleLimit ?? SAMPLE_LIMIT}`,
    `$WALK_LIMIT = ${options.walkLimit ?? RESIDUE_WALK_LIMIT}`
  ].join('\n')
  return `${head}\n${CLEAN_SCRIPT}`
}
