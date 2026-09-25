// ============================================================
//  Windows 进程树治理（零外部依赖 · 直接 kernel32 FFI）
//
//  为什么需要这个模块：原来的实现只用 `taskkill /T /F /PID <直接子进程>`
//  收尾，三种情况下必然残留：
//    1) cli 模式走 `cmd /c start ...`，start 会另起进程并让包装器脱离父子链，
//       记到的 PID 立刻失效，后代全部变孤儿；
//    2) 桌面端是 Electron，ChatGPT.exe 自己再拉起 codex.exe / node_repl.exe
//       / codex-computer-use-swift.exe 等 7+ 个后代，任一环节 re-parent 就逃出
//       taskkill 的树；
//    3) 主程序异常退出（崩溃 / 结束后台清理）时没有任何兜底，树永远活着。
//
//  这里的解法是三保险：
//    A. Job Object（KILL_ON_JOB_CLOSE）：子进程一 spawn 就塞进 job，
//       句柄一关（含主程序退出被系统回收）整棵树由内核直接击杀，不看父子链；
//    B. 快照扫描：按 PID/PPID 自建父子图，从树根自底向上 TerminateProcess，
//       在 job 分配失败（宿主已在别的 job 且不支持嵌套）时兜底；
//    C. 归属清扫：按镜像路径前缀匹配「属于本包运行体的进程」，把历史遗留的
//       孤儿（上一次会话、上次崩溃留下的）一并清掉。
// ============================================================
#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::Path;

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;

    pub const PROCESS_TERMINATE: u32 = 0x0001;
    pub const PROCESS_SET_QUOTA: u32 = 0x0100;
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    pub const SYNCHRONIZE: u32 = 0x0010_0000;
    pub const WAIT_OBJECT_0: u32 = 0;
    /// 最后一个句柄关闭时，内核把 job 内所有进程全部杀掉
    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    pub const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    pub const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    pub const INVALID_HANDLE_VALUE: isize = -1;
    pub const MAX_PATH: usize = 260;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct IoCounters {
        pub ReadOperationCount: u64,
        pub WriteOperationCount: u64,
        pub OtherOperationCount: u64,
        pub ReadTransferCount: u64,
        pub WriteTransferCount: u64,
        pub OtherTransferCount: u64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct JobObjectBasicLimitInformation {
        pub PerProcessUserTimeLimit: i64,
        pub PerJobUserTimeLimit: i64,
        pub LimitFlags: u32,
        pub MinimumWorkingSetSize: usize,
        pub MaximumWorkingSetSize: usize,
        pub ActiveProcessLimit: u32,
        pub Affinity: usize,
        pub PriorityClass: u32,
        pub SchedulingClass: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct JobObjectExtendedLimitInformation {
        pub BasicLimitInformation: JobObjectBasicLimitInformation,
        pub IoInfo: IoCounters,
        pub ProcessMemoryLimit: usize,
        pub JobMemoryLimit: usize,
        pub PeakProcessMemoryUsed: usize,
        pub PeakJobMemoryUsed: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct ProcessEntry32W {
        pub dwSize: u32,
        pub cntUsage: u32,
        pub th32ProcessID: u32,
        pub th32DefaultHeapID: usize,
        pub th32ModuleID: u32,
        pub cntThreads: u32,
        pub th32ParentProcessID: u32,
        pub pcPriClassBase: i32,
        pub dwFlags: u32,
        pub szExeFile: [u16; MAX_PATH],
    }

    impl Default for ProcessEntry32W {
        fn default() -> Self {
            ProcessEntry32W {
                dwSize: std::mem::size_of::<ProcessEntry32W>() as u32,
                cntUsage: 0,
                th32ProcessID: 0,
                th32DefaultHeapID: 0,
                th32ModuleID: 0,
                cntThreads: 0,
                th32ParentProcessID: 0,
                pcPriClassBase: 0,
                dwFlags: 0,
                szExeFile: [0u16; MAX_PATH],
            }
        }
    }

    extern "system" {
        pub fn CreateJobObjectW(lpJobAttributes: *mut c_void, lpName: *const u16) -> *mut c_void;
        pub fn SetInformationJobObject(
            hJob: *mut c_void,
            JobObjectInformationClass: u32,
            lpJobObjectInformation: *mut c_void,
            cbJobObjectInformationLength: u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(hJob: *mut c_void, hProcess: *mut c_void) -> i32;
        pub fn TerminateJobObject(hJob: *mut c_void, uExitCode: u32) -> i32;
        pub fn OpenProcess(
            dwDesiredAccess: u32,
            bInheritHandle: i32,
            dwProcessId: u32,
        ) -> *mut c_void;
        pub fn TerminateProcess(hProcess: *mut c_void, uExitCode: u32) -> i32;
        pub fn CloseHandle(hObject: *mut c_void) -> i32;
        pub fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> *mut c_void;
        pub fn Process32FirstW(hSnapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
        pub fn Process32NextW(hSnapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
        pub fn QueryFullProcessImageNameW(
            hProcess: *mut c_void,
            dwFlags: u32,
            lpExeName: *mut u16,
            lpdwSize: *mut u32,
        ) -> i32;
    }
}

/// 进程快照一行：pid / 父 pid / 镜像名
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// 本进程 pid（清扫时要跳过自己，否则会把自己干掉）
pub fn self_pid() -> u32 {
    std::process::id()
}

// ------------------------------------------------------------
//  A. Job Object
// ------------------------------------------------------------

#[cfg(windows)]
pub struct Job {
    handle: *mut std::ffi::c_void,
}

#[cfg(not(windows))]
pub struct Job;

// Job 句柄是内核对象，跨线程移动没有别名问题；但裸指针默认不是 Send/Sync，
// 这里显式声明，否则 Tauri 的 State<Mutex<..>> 装不进去。
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

/// 建一个「句柄关闭即杀光」的 job
#[cfg(windows)]
pub fn create_kill_on_close_job() -> Option<Job> {
    unsafe {
        let h = ffi::CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if h.is_null() {
            return None;
        }
        let mut info = ffi::JobObjectExtendedLimitInformation::default();
        info.BasicLimitInformation.LimitFlags = ffi::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = ffi::SetInformationJobObject(
            h,
            ffi::JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut info as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<ffi::JobObjectExtendedLimitInformation>() as u32,
        );
        if ok == 0 {
            ffi::CloseHandle(h);
            return None;
        }
        Some(Job { handle: h })
    }
}

#[cfg(not(windows))]
pub fn create_kill_on_close_job() -> Option<Job> {
    None
}

/// 把一个已有进程挂到 job 上（进程 spawn 之后再调用）
#[cfg(windows)]
pub fn assign_pid(job: &Job, pid: u32) -> bool {
    unsafe {
        let p = ffi::OpenProcess(
            ffi::PROCESS_TERMINATE | ffi::PROCESS_SET_QUOTA | ffi::PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if p.is_null() {
            return false;
        }
        let ok = ffi::AssignProcessToJobObject(job.handle, p);
        ffi::CloseHandle(p);
        ok != 0
    }
}

#[cfg(not(windows))]
pub fn assign_pid(_job: &Job, _pid: u32) -> bool {
    false
}

/// 立刻把 job 内所有进程杀掉（不等于关句柄，句柄还要自己收）
#[cfg(windows)]
pub fn terminate_job(job: &Job) -> bool {
    unsafe { ffi::TerminateJobObject(job.handle, 1) != 0 }
}

#[cfg(not(windows))]
pub fn terminate_job(_job: &Job) -> bool {
    false
}

/// 收句柄：这一步就会触发 KILL_ON_JOB_CLOSE（如果还没 terminate 过）
#[cfg(windows)]
pub fn close_job(job: Job) {
    unsafe { ffi::CloseHandle(job.handle) };
}

#[cfg(not(windows))]
pub fn close_job(_job: Job) {}

// ------------------------------------------------------------
//  B/C. 快照 / 树 / 归属清扫
// ------------------------------------------------------------

/// 取一次全系统进程快照（pid / ppid / 镜像名）
#[cfg(windows)]
pub fn snapshot() -> Vec<ProcRow> {
    use std::os::windows::ffi::OsStringExt;
    let mut out = Vec::new();
    unsafe {
        let snap = ffi::CreateToolhelp32Snapshot(ffi::TH32CS_SNAPPROCESS, 0);
        if snap as isize == ffi::INVALID_HANDLE_VALUE || snap.is_null() {
            return out;
        }
        let mut pe = ffi::ProcessEntry32W::default();
        if ffi::Process32FirstW(snap, &mut pe) != 0 {
            loop {
                let len = pe
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(ffi::MAX_PATH);
                let name = std::ffi::OsString::from_wide(&pe.szExeFile[..len])
                    .to_string_lossy()
                    .into_owned();
                out.push(ProcRow {
                    pid: pe.th32ProcessID,
                    ppid: pe.th32ParentProcessID,
                    name,
                });
                pe.dwSize = std::mem::size_of::<ffi::ProcessEntry32W>() as u32;
                if ffi::Process32NextW(snap, &mut pe) == 0 {
                    break;
                }
            }
        }
        ffi::CloseHandle(snap);
    }
    out
}

#[cfg(not(windows))]
pub fn snapshot() -> Vec<ProcRow> {
    Vec::new()
}

/// 取进程镜像全路径（拿不到权限时返回 None）
#[cfg(windows)]
pub fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let p = ffi::OpenProcess(ffi::PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if p.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = ffi::QueryFullProcessImageNameW(p, 0, buf.as_mut_ptr(), &mut size);
        ffi::CloseHandle(p);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

#[cfg(not(windows))]
pub fn image_path(_pid: u32) -> Option<String> {
    None
}

/// 由一个 pid 强杀（拿不到句柄即视为已退出 / 无权限）
#[cfg(windows)]
fn terminate_pid(pid: u32) -> bool {
    if pid <= 4 {
        return false;
    }
    unsafe {
        let p = ffi::OpenProcess(ffi::PROCESS_TERMINATE, 0, pid);
        if p.is_null() {
            return false;
        }
        let ok = ffi::TerminateProcess(p, 1);
        ffi::CloseHandle(p);
        ok != 0
    }
}

#[cfg(not(windows))]
fn terminate_pid(_pid: u32) -> bool {
    false
}

/// 以「外部进程」的身份尝试强杀（仅供测试/验证用）
///
/// 与 `terminate_pid` 是同一套调用，单独暴露出来是为了让测试能明确断言
/// 「DACL 收紧后外部 OpenProcess 被拒绝」这条性质 —— 名字即意图。
pub fn kill_pid_force(pid: u32) -> bool {
    terminate_pid(pid)
}

/// 进程是否还在（外部视角：进程对象 DACL 收紧后会查不到，返回 false）
pub fn pid_exists_external(pid: u32) -> bool {
    snapshot().iter().any(|r| r.pid == pid)
}

// ------------------------------------------------------------
//  D. 新控制台启动（CLI 交互式模式专用）
//
//  为什么不能用 std::process::Command：
//    Rust 的 Command **总是**设置 STARTF_USESTDHANDLES，并把父进程当前的
//    标准句柄写进 STARTUPINFO。alice 是 GUI 子系统程序（windows_subsystem
//    = "windows"），自己没有控制台，GetStdHandle 返回 NULL —— 于是子进程
//    拿到的是三个空句柄，即使加了 CREATE_NEW_CONSOLE 也没有控制台输入，
//    codex TUI 立刻以 `Error: stdin is not a terminal` 退出（实测 exit 1）。
//
//  实测对照（GUI 父进程 pythonw 下跑同一份 codex.exe）：
//    inherit + CREATE_NEW_CONSOLE       → 存活 ✅
//    stdin=DEVNULL + CREATE_NEW_CONSOLE → 1 秒内退出 ❌
//    全部 DEVNULL + CREATE_NEW_CONSOLE  → 1 秒内退出 ❌
//    DETACHED_PROCESS                   → 1 秒内退出 ❌
//  结论：**必须**不设 STARTF_USESTDHANDLES，让系统在分配新控制台时
//  把 CONIN$/CONOUT$ 作为子进程的标准句柄。
//
//  所以这里直接调 CreateProcessW：自己拼命令行与 Unicode 环境块，
//  以 CREATE_SUSPENDED 创建，先挂进 Job Object 再恢复运行 —— 保证
//  「先入 job 后上锁」的顺序，DACL 收紧后不会有漏网窗口。
// ------------------------------------------------------------

#[cfg(windows)]
mod spawn_ffi {
    use std::ffi::c_void;

    pub const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    pub const CREATE_SUSPENDED: u32 = 0x0000_0004;
    pub const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    pub const STARTF_USESHOWWINDOW: u32 = 0x0000_0001;
    pub const SW_SHOWNORMAL: u16 = 1;

    #[repr(C)]
    pub struct StartupInfoW {
        pub cb: u32,
        pub lpReserved: *mut u16,
        pub lpDesktop: *mut u16,
        pub lpTitle: *mut u16,
        pub dwX: u32,
        pub dwY: u32,
        pub dwXSize: u32,
        pub dwYSize: u32,
        pub dwXCountChars: u32,
        pub dwYCountChars: u32,
        pub dwFillAttribute: u32,
        pub dwFlags: u32,
        pub wShowWindow: u16,
        pub cbReserved2: u16,
        pub lpReserved2: *mut u8,
        pub hStdInput: *mut c_void,
        pub hStdOutput: *mut c_void,
        pub hStdError: *mut c_void,
    }

    #[repr(C)]
    pub struct ProcessInformation {
        pub hProcess: *mut c_void,
        pub hThread: *mut c_void,
        pub dwProcessId: u32,
        pub dwThreadId: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateProcessW(
            lpApplicationName: *const u16,
            lpCommandLine: *mut u16,
            lpProcessAttributes: *mut c_void,
            lpThreadAttributes: *mut c_void,
            bInheritHandles: i32,
            dwCreationFlags: u32,
            lpEnvironment: *mut c_void,
            lpCurrentDirectory: *const u16,
            lpStartupInfo: *mut StartupInfoW,
            lpProcessInformation: *mut ProcessInformation,
        ) -> i32;
        pub fn ResumeThread(hThread: *mut c_void) -> u32;
        pub fn GetLastError() -> u32;
    }
}

/// Windows 命令行参数引用规则（MSDN "Parsing C Command-Line Arguments"）
#[cfg(windows)]
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // 引号前的反斜杠要翻倍，再转义引号
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push('\\');
                out.push('"');
            }
            _ => {
                backslashes = 0;
                out.push(c);
            }
        }
    }
    // 收尾反斜杠也要翻倍（否则会转义掉闭合引号）
    for _ in 0..backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

/// 拼 Unicode 环境块（`KEY=VALUE\0...\0`，键按不区分大小写排序去重）
#[cfg(windows)]
fn build_env_block(envs: &[(String, String)]) -> Vec<u16> {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in envs {
        if k.is_empty() {
            continue;
        }
        // 用大写键排序去重；保留原始大小写形式写入
        map.insert(k.to_uppercase(), format!("{k}={v}"));
    }
    let mut block: Vec<u16> = Vec::new();
    for line in map.values() {
        block.extend(line.encode_utf16());
        block.push(0);
    }
    block.push(0); // 结尾双 NUL
    block
}

/// 在**新控制台**里启动一个交互式子进程，并入 Job 后恢复运行
///
/// 返回 pid。与 `Command` 路径的关键差别：
///   · 不设 STARTF_USESTDHANDLES → 子进程拿到真实 CONIN$/CONOUT$，
///     交互式 TUI 才能正常工作（见本模块顶部实测对照）
///   · CREATE_SUSPENDED 创建 → 先 assign 进 job 再 resume，
///     保证没有「已运行但还没进 job」的窗口
#[cfg(windows)]
pub fn spawn_new_console(
    exe: &Path,
    args: &[String],
    envs: &[(String, String)],
    cwd: &Path,
    job: Option<&Job>,
) -> Result<u32, String> {
    use std::os::windows::ffi::OsStrExt;

    let exe_w: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let cwd_w: Vec<u16> = cwd.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

    // lpApplicationName 给全路径，参数从 argv[1] 开始拼
    let mut cmdline = quote_arg(&exe.display().to_string());
    for a in args {
        cmdline.push(' ');
        cmdline.push_str(&quote_arg(a));
    }
    let mut cmd_w: Vec<u16> = cmdline.encode_utf16().collect();
    cmd_w.push(0);

    let mut env_block = build_env_block(envs);

    let mut si = spawn_ffi::StartupInfoW {
        cb: std::mem::size_of::<spawn_ffi::StartupInfoW>() as u32,
        lpReserved: std::ptr::null_mut(),
        lpDesktop: std::ptr::null_mut(),
        lpTitle: std::ptr::null_mut(),
        dwX: 0,
        dwY: 0,
        dwXSize: 0,
        dwYSize: 0,
        dwXCountChars: 0,
        dwYCountChars: 0,
        dwFillAttribute: 0,
        // 只设 USESHOWWINDOW：**刻意不设** USESTDHANDLES
        dwFlags: spawn_ffi::STARTF_USESHOWWINDOW,
        wShowWindow: spawn_ffi::SW_SHOWNORMAL,
        cbReserved2: 0,
        lpReserved2: std::ptr::null_mut(),
        hStdInput: std::ptr::null_mut(),
        hStdOutput: std::ptr::null_mut(),
        hStdError: std::ptr::null_mut(),
    };
    let mut pi = spawn_ffi::ProcessInformation {
        hProcess: std::ptr::null_mut(),
        hThread: std::ptr::null_mut(),
        dwProcessId: 0,
        dwThreadId: 0,
    };

    let flags = spawn_ffi::CREATE_NEW_CONSOLE
        | spawn_ffi::CREATE_SUSPENDED
        | spawn_ffi::CREATE_UNICODE_ENVIRONMENT;

    let ok = unsafe {
        spawn_ffi::CreateProcessW(
            exe_w.as_ptr(),
            cmd_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0, // 不继承句柄：新控制台由系统分配
            flags,
            env_block.as_mut_ptr() as *mut std::ffi::c_void,
            cwd_w.as_ptr(),
            &mut si,
            &mut pi,
        )
    };
    if ok == 0 {
        let err = unsafe { spawn_ffi::GetLastError() };
        return Err(format!("CreateProcessW 失败（Win32 错误 {err}）"));
    }

    let pid = pi.dwProcessId;

    // 先入 Job（此时进程还挂起），再恢复 —— 顺序反了就会出现保护空窗
    if let Some(j) = job {
        if !assign_pid(j, pid) {
            // 绑定失败也要让它跑起来，只是少了内核级兜底
            unsafe {
                spawn_ffi::ResumeThread(pi.hThread);
                ffi::CloseHandle(pi.hThread);
                ffi::CloseHandle(pi.hProcess);
            }
            return Ok(pid);
        }
    }

    unsafe {
        spawn_ffi::ResumeThread(pi.hThread);
        ffi::CloseHandle(pi.hThread);
        ffi::CloseHandle(pi.hProcess);
    }
    Ok(pid)
}

#[cfg(not(windows))]
pub fn spawn_new_console(
    _exe: &Path,
    _args: &[String],
    _envs: &[(String, String)],
    _cwd: &Path,
    _job: Option<&Job>,
) -> Result<u32, String> {
    Err("仅支持 Windows".into())
}

/// 由快照算出某进程的整棵后代（不含自己），按「后代的深度从深到浅」排序
fn descendants_of(rows: &[ProcRow], root: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in rows {
        children.entry(r.ppid).or_default().push(r.pid);
    }
    let mut out = Vec::new();
    let mut stack = vec![(root, 0usize)];
    let mut seen: HashSet<u32> = HashSet::new();
    seen.insert(root);
    while let Some((pid, depth)) = stack.pop() {
        if let Some(kids) = children.get(&pid) {
            for &k in kids {
                if seen.insert(k) {
                    stack.push((k, depth + 1));
                    out.push((k, depth + 1));
                }
            }
        }
    }
    // 深的先杀：父进程先死不会把子进程带走，反而可能让子进程 re-parent 逃逸
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out.into_iter().map(|(p, _)| p).collect()
}

/// 杀一整棵树（自底向上），返回实际杀掉的 pid 列表
pub fn kill_tree(root_pid: u32) -> Vec<u32> {
    let rows = snapshot();
    let mut killed = Vec::new();
    for pid in descendants_of(&rows, root_pid) {
        if pid != self_pid() && terminate_pid(pid) {
            killed.push(pid);
        }
    }
    if root_pid != self_pid() && terminate_pid(root_pid) {
        killed.push(root_pid);
    }
    killed
}

/// 某进程的整棵后代 pid（含深层 grandchildren，按深度从深到浅）
///
/// 用途：启动后要把**整棵树**都上锁 —— 只锁树根的话，codex 拉起的
/// node_repl / adb / conhost 仍是裸的，任务管理器照样能一个个点掉。
/// 实测（未保护时）：`node_repl.exe`、`adb.exe` 均可被非提权调用者打开
/// PROCESS_TERMINATE，即任务管理器能直接结束。
pub fn descendants(root_pid: u32) -> Vec<u32> {
    descendants_of(&snapshot(), root_pid)
}

/// 路径前缀判定（大小写不敏感；`\` 与 `/` 等价）
fn path_under(path: &str, root: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let p = norm(path);
    let r = norm(root);
    if r.is_empty() {
        return false;
    }
    p == r || p.starts_with(&format!("{r}\\"))
}

/// 列出「镜像落在 root 目录下」的所有进程（= 本包运行体自己的进程）
pub fn pids_under_root(root: &str) -> Vec<u32> {
    let me = self_pid();
    snapshot()
        .into_iter()
        .filter(|r| r.pid != me && r.pid > 4)
        .filter(|r| image_path(r.pid).map(|p| path_under(&p, root)).unwrap_or(false))
        .map(|r| r.pid)
        .collect()
}

/// 孤儿判定：父进程已不存在（ppid 不在快照里）或父进程就是自己
///
/// 用途：**启动前**只该清理「上一次留下的孤儿」，绝不能顺手杀掉另一个
/// 仍活跃的实例（比如用户还开着的旧桌面端）。
fn is_orphan(rows: &[ProcRow], pid: u32, ppid: u32) -> bool {
    if pid == ppid {
        return true;
    }
    if ppid <= 4 {
        return true;
    }
    !rows.iter().any(|r| r.pid == ppid)
}

/// 归属清扫（全量）：把 root 目录下的进程全部强杀，返回「杀掉 / 仍在」
///
/// 只在「停止」路径使用 —— 用户点了停止就是要全停，包括另一实例。
pub fn sweep_root(root: &str) -> (Vec<u32>, Vec<u32>) {
    let me = self_pid();
    let mut killed = Vec::new();
    // 连跑两轮：第一轮杀掉的可能还有子进程没退出，第二轮收尾
    for _ in 0..2 {
        for row in snapshot() {
            if row.pid == me || row.pid <= 4 {
                continue;
            }
            let Some(img) = image_path(row.pid) else { continue };
            if !path_under(&img, root) {
                continue;
            }
            if terminate_pid(row.pid) {
                killed.push(row.pid);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    killed.sort_unstable();
    killed.dedup();
    (killed, pids_under_root(root))
}

/// 归属清扫（仅孤儿）：只杀「父进程已经不存在」的包内进程
///
/// 用在**启动前**：收拾上次崩溃/被强杀留下的孤儿，同时不碰任何活跃实例。
pub fn sweep_root_orphans(root: &str) -> Vec<u32> {
    let me = self_pid();
    let rows = snapshot();
    let mut killed = Vec::new();
    for row in rows.iter() {
        if row.pid == me || row.pid <= 4 {
            continue;
        }
        if !is_orphan(&rows, row.pid, row.ppid) {
            continue;
        }
        let Some(img) = image_path(row.pid) else { continue };
        if !path_under(&img, root) {
            continue;
        }
        if terminate_pid(row.pid) {
            killed.push(row.pid);
        }
    }
    killed.sort_unstable();
    killed.dedup();
    // 第一轮杀掉的可能还留着子进程，再扫一遍
    if !killed.is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let rows2 = snapshot();
        for row in rows2.iter() {
            if row.pid == me || row.pid <= 4 || killed.contains(&row.pid) {
                continue;
            }
            if !is_orphan(&rows2, row.pid, row.ppid) {
                continue;
            }
            let Some(img) = image_path(row.pid) else { continue };
            if path_under(&img, root) && terminate_pid(row.pid) {
                killed.push(row.pid);
            }
        }
        killed.sort_unstable();
        killed.dedup();
    }
    killed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, name: &str) -> ProcRow {
        ProcRow {
            pid,
            ppid,
            name: name.to_string(),
        }
    }

    #[test]
    fn descendants_are_collected_and_deepest_first() {
        let rows = vec![
            row(100, 1, "root.exe"),
            row(200, 100, "child.exe"),
            row(300, 200, "grand.exe"),
            row(400, 100, "sibling.exe"),
            row(999, 1, "unrelated.exe"),
        ];
        let d = descendants_of(&rows, 100);
        assert_eq!(d.len(), 3);
        assert!(!d.contains(&999), "不该碰到无关进程");
        assert!(!d.contains(&100), "列表不含树根自己");
        // 孙进程必须排在子进程前面（先深后浅）
        let pos_grand = d.iter().position(|&p| p == 300).unwrap();
        let pos_child = d.iter().position(|&p| p == 200).unwrap();
        assert!(pos_grand < pos_child, "深的后代要先杀：{d:?}");
    }

    #[test]
    fn descendants_survives_cycle_in_ppid_data() {
        // 理论上 ppid 不成环，但快照可能读到 pid 复用造成的自环 —— 不能死循环
        let rows = vec![row(10, 11, "a.exe"), row(11, 10, "b.exe")];
        let d = descendants_of(&rows, 10);
        assert!(d.len() <= 1, "有环时也必须收敛：{d:?}");
    }

    #[test]
    fn path_under_matches_case_and_separator() {
        assert!(path_under(
            "F:\\重构ui\\新alice助手\\resources\\runtime\\desktop\\app\\ChatGPT.exe",
            "F:/重构ui/新alice助手/resources"
        ));
        assert!(path_under("c:\\x\\resources", "C:\\X\\RESOURCES\\"));
        // 不能把同名前缀的兄弟目录吞进来（resources2 不是 resources 的子目录）
        assert!(!path_under("C:\\x\\resources2\\a.exe", "C:\\x\\resources"));
        // 主程序自己在 resources 之外，绝不能被顺手杀掉
        assert!(!path_under("F:\\重构ui\\新alice助手\\新alice助手.exe", "F:\\重构ui\\新alice助手\\resources"));
        assert!(!path_under("C:\\x\\resources", ""));
    }

    #[test]
    fn orphan_detection_excludes_live_parents() {
        let rows = vec![row(100, 1, "live.exe"), row(200, 100, "kid.exe")];
        // 父进程还在 → 不是孤儿（启动前不该动它）
        assert!(!is_orphan(&rows, 200, 100));
        // 父进程不在快照里 → 孤儿
        assert!(is_orphan(&rows, 300, 999));
        // ppid 为系统进程 / 自环 → 孤儿
        assert!(is_orphan(&rows, 400, 0));
        assert!(is_orphan(&rows, 500, 500));
    }

    /// 真机验证：把一份真实的可执行文件放进临时目录、跑起来，
    /// 归属清扫必须能按「镜像路径在 root 下」把它杀掉，并且 remaining 为空。
    /// 这是脱离 Tauri 也能跑的端到端校验（验证的就是停止按钮走的那条路）。
    #[cfg(windows)]
    #[test]
    fn sweep_kills_process_under_root_for_real() {
        use std::process::Command;
        // 找一个系统自带的小程序当靶子，复制进临时 root
        let src = r"C:\Windows\System32\ping.exe";
        if !std::path::Path::new(src).exists() {
            eprintln!("跳过：{src} 不存在");
            return;
        }
        let root = std::env::temp_dir().join(format!("wz-sweep-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        let exe = root.join("ping.exe");
        std::fs::copy(src, &exe).expect("复制靶子失败");

        // 跑 60 秒，足够做完清扫
        let mut child = Command::new(&exe)
            .args(["-n", "60", "127.0.0.1"])
            .spawn()
            .expect("启动靶子失败");
        let pid = child.id();

        // 先确认它确实被识别为「root 下的进程」
        let found = pids_under_root(&root.display().to_string());
        assert!(found.contains(&pid), "应识别出 root 下的进程，实际 {found:?}");

        let (killed, remaining) = sweep_root(&root.display().to_string());
        assert!(killed.contains(&pid), "清扫应杀掉 {pid}，实际 killed={killed:?}");
        assert!(remaining.is_empty(), "清扫后不该有残留：{remaining:?}");

        // 收尾：确认真的退出了（try_wait 返回 Some 即已退出）
        let mut gone = false;
        for _ in 0..20 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(gone, "靶子进程 {pid} 应当已终止");
        let _ = child.kill();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_and_self_pid_are_sane() {
        let rows = snapshot();
        if cfg!(windows) {
            assert!(!rows.is_empty(), "Windows 上快照不应为空");
            assert!(rows.iter().any(|r| r.pid == self_pid()), "快照里应能找到自己");
        }
    }
}
