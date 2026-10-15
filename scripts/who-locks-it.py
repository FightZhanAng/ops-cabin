# -*- coding: utf-8 -*-
"""定位目录里"删不掉"的文件，并点名持有它们的进程（Windows）。

为什么需要它：Windows 没有公开接口能直接回答"这个文件被谁占着"。这里用两招组合：
  1. 判定"能不能删"——以 DELETE 权限 + 完全共享打开目标；被拒（32 被占 / 5 拒绝访问 /
     19 写保护）才是真的删不掉。这比 stat 更贴近清理动作真正需要的能力。
  2. 用 **Restart Manager** 问持有者——它是安装程序判断"这个文件能不能替换"用的官方接口，
     返回持有句柄的进程号与程序名。

⚠️ 一次会话只能问一个文件：RmRegisterResources 的资源在同一会话内是**累加**的，
   循环注册会让每个文件都返回"这一批里所有占用者"的并集（实测踩过：25 个文件报出
   同一串 25 个进程），于是每个文件的占用者都成了假的。

用法：
    python scripts/who-locks-it.py                # 扫 %TEMP%
    python scripts/who-locks-it.py <目录> [更多目录]  # 扫指定目录
输出：结果同时打印到 stdout，并写到**当前目录**的 holder-report.txt（UTF-8）。

与 `src/main/cleaner/` 的关系：应用内的清理用的是同一套判据（见 src/main/cleaner/script.ts
与 holder.ts），这个脚本是不依赖应用、可单独跑的诊断版。
"""
import os, sys, time, ctypes
from ctypes import wintypes

TARGETS = sys.argv[1:] or [os.environ.get('TEMP') or os.environ.get('TMP') or '.']
LOG = os.path.join(os.getcwd(), 'holder-report.txt')

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
rm = ctypes.WinDLL('rstrtmgr')

DELETE = 0x00010000
SYNCHRONIZE = 0x00100000
OPEN_EXISTING = 3
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
SHARE_ALL = 0x1 | 0x2 | 0x4

class RM_UNIQUE_PROCESS(ctypes.Structure):
    _fields_ = [('dwProcessId', wintypes.DWORD), ('ProcessStartTime', wintypes.FILETIME)]
class RM_PROCESS_INFO(ctypes.Structure):
    _fields_ = [('Process', RM_UNIQUE_PROCESS),
                ('strAppName', wintypes.WCHAR * 256),
                ('strServiceShortName', wintypes.WCHAR * 64),
                ('ApplicationType', ctypes.c_uint),
                ('AppStatus', wintypes.ULONG),
                ('TSSessionId', wintypes.DWORD),
                ('bRestartable', wintypes.BOOL)]

def cant_delete(path):
    """返回 (True, 错误码) 表示删除/改名会失败"""
    h = k32.CreateFileW(path, DELETE | SYNCHRONIZE, SHARE_ALL, None, OPEN_EXISTING,
                        FILE_FLAG_BACKUP_SEMANTICS, None)
    if h in (wintypes.HANDLE(-1).value, -1):
        return True, ctypes.get_last_error()
    k32.CloseHandle(h)
    return False, 0

def holders(path):
    """独立会话问一个文件, 返回 [(pid, appname)] / [] / '错误'"""
    hs = wintypes.DWORD(); key = ctypes.create_unicode_buffer(33)
    if rm.RmStartSession(ctypes.byref(hs), 0, key):
        return 'RmStartSession 失败'
    try:
        arr = (wintypes.LPCWSTR * 1)(os.path.abspath(path))
        if rm.RmRegisterResources(hs, 1, arr, 0, None, 0, None):
            return 'RmRegisterResources 失败'
        need = wintypes.UINT(0); cnt = wintypes.UINT(0); why = wintypes.DWORD(0)
        r = rm.RmGetList(hs, ctypes.byref(need), ctypes.byref(cnt), None, ctypes.byref(why))
        if r == 0 and need.value == 0:
            return []
        if need.value == 0:
            return 'RmGetList r=%d why=%d' % (r, why.value)
        buf = (RM_PROCESS_INFO * need.value)()
        cnt = wintypes.UINT(need.value)
        if rm.RmGetList(hs, ctypes.byref(need), ctypes.byref(cnt), buf, ctypes.byref(why)):
            return 'RmGetList(2) 失败'
        return [(buf[i].Process.dwProcessId, buf[i].strAppName) for i in range(cnt.value)]
    finally:
        rm.RmEndSession(hs)

_cached = {}
def proc_path(pid):
    if pid in _cached:
        return _cached[pid]
    val = ''
    try:
        h = k32.OpenProcess(0x1000, False, pid)
        if h:
            buf = ctypes.create_unicode_buffer(1024); n = wintypes.DWORD(1024)
            if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                val = buf.value
            k32.CloseHandle(h)
    except Exception:
        pass
    _cached[pid] = val
    return val

def mb(b):
    return round(b / 1048576.0, 2)

lines = []
def out(s=''):
    print(s, flush=True)
    lines.append(s)

t0 = time.time()
for root in TARGETS:
    out('=' * 100)
    out('目录: %s' % root)
    if not os.path.exists(root):
        out('  不存在, 跳过')
        continue
    locked = []
    n = 0
    t1 = time.time()
    for dp, dn, fn in os.walk(root):
        for f in fn:
            full = os.path.join(dp, f)
            n += 1
            try:
                bad, err = cant_delete(full)
            except OSError:
                continue
            if bad:
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    sz = 0
                locked.append((full, sz, err))
    out('  扫描 %d 个文件 -> 删不掉的 %d 个 (用时 %.1fs)' % (n, len(locked), time.time() - t1))
    if not locked:
        continue

    out('\n  ---- 逐个点名持有者 ----')
    by_proc = {}
    orphan = []
    t2 = time.time()
    for path, sz, err in locked:
        hs = holders(path)
        if not isinstance(hs, list):
            out('  [查询异常] %s : %s' % (path, hs))
            continue
        if not hs:
            orphan.append((path, sz, err))
            continue
        names = []
        for pid, app in hs:
            d = by_proc.setdefault((pid, app), {'n': 0, 'sz': 0, 'files': []})
            d['n'] += 1; d['sz'] += sz
            d['files'].append(path)
            names.append('%s(%d)' % (app, pid))
        out('  %8.2f MB  %s' % (mb(sz), path))
        out('              <- %s' % ', '.join(names))
    out('\n  ---- 按持有者汇总 (用时 %.1fs) ----' % (time.time() - t2))
    for (pid, app), d in sorted(by_proc.items(), key=lambda kv: -kv[1]['sz']):
        out('  PID %-7d %-32s 占用 %3d 个 / %8.2f MB' % (pid, app, d['n'], mb(d['sz'])))
        out('      映像: %s' % (proc_path(pid) or '(已退出或受保护, 句柄仍被内核持有)'))
    if orphan:
        out('\n  ---- 删不掉但查不到持有者(权限/杀软过滤驱动): %d 个 ----' % len(orphan))
        for path, sz, err in orphan:
            out('    err=%-3d %8.2f MB %s' % (err, mb(sz), path))

out('\n总用时 %.1fs' % (time.time() - t0))
with open(LOG, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print('\n报告已写: %s' % LOG)
