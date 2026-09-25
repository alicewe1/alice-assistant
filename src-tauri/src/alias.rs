// ============================================================
//  随机镜像名 + 独占终止保护（alias.rs）
//
//  需求：alice 助手拉起 codex 时**每次用随机进程名**，让按镜像名扫进程的
//  清理工具 / 杀软 / 其它软件杀不掉；同时保证 alice 点「停止」一定杀得掉。
//
//  三层实现（每一层都在真机上单独验证过）：
//
//   ① 随机别名（硬链接，不复制文件）
//      在 codex.exe **同目录**建硬链接 `wz<8位随机>.exe`。硬链接与真身共享
//      同一份 PE 数据（不额外占 300MB 磁盘），但内核记录的可执行镜像路径就是
//      别名 —— 任务管理器 / 进程快照里看到的就是随机名。
//      实测：`_wztest_71bba1a1.exe --version` → `codex-cli 0.154.0`，正常。
//
//   ② 独占终止保护（DACL 收紧 + 预留句柄）
//      进程起来后把**进程对象**的安全描述符收成
//          D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;RC;;;<当前用户>)(A;;WD;;;<当前用户>)
//      SYSTEM / Administrators 完全控制；当前用户**只给** READ_CONTROL 与
//      WRITE_DAC，**不给** PROCESS_TERMINATE。
//      实测：外部 `taskkill /F /PID` → `Access is denied`；
//            `Stop-Process -Force`  → `Access is denied`。
//
//   ③ 钥匙留在自己手里
//      Windows 的访问检查发生在 OpenProcess 那一刻。所以顺序是：
//        **先** OpenProcess(PROCESS_TERMINATE) 拿到句柄 → **再** 收紧 DACL。
//      已持有的句柄不因 DACL 变更而失效 → alice 点停止时用这个句柄
//      TerminateProcess 仍然成功。实测：句柄终止返回 True，进程消失。
//      其它软件没有这个句柄，重新 OpenProcess 会被 DACL 拒绝。
//
//  为什么给当前用户留 WRITE_DAC（关键的自愈设计）：
//    如果 DACL 收得只剩 SYSTEM/BA，那么 alice 自己被强杀 / 崩溃后，
//    残留进程连 alice 重启后都杀不掉（没有终止权限）—— 变成永久僵尸。
//    留 WRITE_DAC 后，下次启动可以先把 DACL 放宽再杀。
//    实测：`recovered-and-killed`。
//    这条路径只在**镜像路径确属包内**时启用，绝不碰别人的进程。
//
//  安全兜底（很重要）：
//    收紧 DACL 后连用户手动都杀不掉，所以**只在 Job Object 绑定成功后**才上锁。
//    这样即使 alice 崩溃，job 句柄被系统回收 → KILL_ON_JOB_CLOSE 由内核杀光
//    整棵树；万一 job 也没兜住，还有上面那条 WRITE_DAC 自愈路径。
//    job 绑定失败则跳过上锁，只保留随机名。
// ============================================================
#![allow(non_snake_case, dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;

    pub const PROCESS_TERMINATE: u32 = 0x0001;
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    pub const SYNCHRONIZE: u32 = 0x0010_0000;
    pub const WRITE_DAC: u32 = 0x0004_0000;
    pub const READ_CONTROL: u32 = 0x0002_0000;
    pub const TOKEN_QUERY: u32 = 0x0008;
    pub const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    pub const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
    pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
    /// WaitForSingleObject 超时常量：0 = 立刻返回，用于存活探测
    pub const WAIT_TIMEOUT: u32 = 258;
    pub const WAIT_OBJECT_0: u32 = 0;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(
            dwDesiredAccess: u32,
            bInheritHandle: i32,
            dwProcessId: u32,
        ) -> *mut c_void;
        pub fn TerminateProcess(hProcess: *mut c_void, uExitCode: u32) -> i32;
        pub fn CloseHandle(hObject: *mut c_void) -> i32;
        pub fn CreateHardLinkW(
            lpFileName: *const u16,
            lpExistingFileName: *const u16,
            lpSecurityAttributes: *mut c_void,
        ) -> i32;
        pub fn SetFileAttributesW(lpFileName: *const u16, dwFileAttributes: u32) -> i32;
        pub fn LocalFree(hMem: *mut c_void) -> *mut c_void;
        pub fn WaitForSingleObject(hHandle: *mut c_void, dwMilliseconds: u32) -> u32;
        pub fn GetExitCodeProcess(hProcess: *mut c_void, lpExitCode: *mut u32) -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            StringSecurityDescriptor: *const u16,
            StringSDRevision: u32,
            SecurityDescriptor: *mut *mut c_void,
            SecurityDescriptorSize: *mut u32,
        ) -> i32;
        pub fn SetKernelObjectSecurity(
            Handle: *mut c_void,
            SecurityInformation: u32,
            SecurityDescriptor: *mut c_void,
        ) -> i32;
        pub fn OpenProcessToken(
            ProcessHandle: *mut c_void,
            DesiredAccess: u32,
            TokenHandle: *mut *mut c_void,
        ) -> i32;
        pub fn GetTokenInformation(
            TokenHandle: *mut c_void,
            TokenInformationClass: i32,
            TokenInformation: *mut c_void,
            TokenInformationLength: u32,
            ReturnLength: *mut u32,
        ) -> i32;
        pub fn ConvertSidToStringSidW(Sid: *mut c_void, StringSid: *mut *mut u16) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentProcess() -> *mut c_void;
        pub fn HeapAlloc(hHeap: *mut c_void, dwFlags: u32, dwBytes: usize) -> *mut c_void;
        pub fn HeapFree(hHeap: *mut c_void, dwFlags: u32, lpMem: *mut c_void) -> i32;
        pub fn GetProcessHeap() -> *mut c_void;
    }

    /// 收紧后只剩 SYSTEM 与 Administrators 完全控制；
    /// 当前用户仅保留 READ_CONTROL + WRITE_DAC（用于崩溃后自愈），
    /// **不给** PROCESS_TERMINATE —— 这正是「外部杀不掉」的来源。
    pub const LOCK_SDDL_FMT: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;RC;;;{sid})(A;;WD;;;{sid})";
    /// 自愈用：把 DACL 放宽到 Everyone 完全控制
    pub const UNLOCK_SDDL: &str = "D:(A;;GA;;;WD)";
}

/// 别名命名：`wz` + 8 位小写字母数字；长度固定 10 字符（不含扩展名）
const ALIAS_PREFIX: &str = "wz";
const ALIAS_BODY_LEN: usize = 8;

fn wide(s: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// 清掉隐藏属性（否则个别场景删不掉）
fn clear_hidden(p: &Path) {
    #[cfg(windows)]
    unsafe {
        ffi::SetFileAttributesW(wide(p).as_ptr(), ffi::FILE_ATTRIBUTE_NORMAL);
    }
    #[cfg(not(windows))]
    let _ = p;
}

/// 生成一个不含任何特征词的随机基名
///
/// 用 时间 + pid + 自增序号 做 xorshift 混合，不引入 rand 依赖。
/// 刻意不带 `codex` / `alice` / `wangzha` 等字样 —— 按名字杀的工具认不出来。
pub fn random_stem() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos
        ^ (std::process::id() as u64).rotate_left(17)
        ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;

    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::from(ALIAS_PREFIX);
    for i in 0..ALIAS_BODY_LEN {
        let idx = ((x >> (i * 5)) % ALPHABET.len() as u64) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out
}

/// 别名命名规则判定（清理遗留时用）
pub fn is_alias_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(stem) = lower.strip_suffix(".exe") else {
        return false;
    };
    if stem.len() != ALIAS_PREFIX.len() + ALIAS_BODY_LEN || !stem.starts_with(ALIAS_PREFIX) {
        return false;
    }
    stem[ALIAS_PREFIX.len()..]
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

// ------------------------------------------------------------
//  ① 别名文件
// ------------------------------------------------------------

/// 一个随机名硬链接。启动命令用它的路径，进程镜像名就是它的文件名。
#[derive(Clone, Debug)]
pub struct AliasFile {
    pub path: PathBuf,
    /// 随机基名（不含扩展名），界面展示用
    pub stem: String,
}

impl AliasFile {
    /// 删除别名链接（不动真身）
    pub fn remove(&self) {
        clear_hidden(&self.path);
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 在目标 exe 同目录建随机名硬链接
///
/// 同目录 = 同卷，硬链接必然可行。失败返回 None，调用方退回原名启动。
pub fn make_alias(target: &Path) -> Option<AliasFile> {
    #[cfg(not(windows))]
    {
        let _ = target;
        return None;
    }
    #[cfg(windows)]
    {
        let dir = target.parent()?;
        let ext = target
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_else(|| "exe".into());
        if !target.exists() {
            return None;
        }

        for _ in 0..8 {
            let stem = random_stem();
            let candidate = dir.join(format!("{stem}.{ext}"));
            if candidate.exists() {
                continue;
            }
            let ok = unsafe {
                ffi::CreateHardLinkW(
                    wide(&candidate).as_ptr(),
                    wide(target).as_ptr(),
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return None;
            }
            // 隐藏起来：目录里默认看不见，少一个被顺手清理的机会
            unsafe { ffi::SetFileAttributesW(wide(&candidate).as_ptr(), ffi::FILE_ATTRIBUTE_HIDDEN) };
            return Some(AliasFile {
                path: candidate,
                stem,
            });
        }
        None
    }
}

// ------------------------------------------------------------
//  ② + ③ 独占终止保护
// ------------------------------------------------------------

/// 一个进程的「终止钥匙」：上锁前预留的句柄
pub struct Guard {
    pub pid: u32,
    #[cfg(windows)]
    handle: *mut std::ffi::c_void,
    /// 是否已用句柄终止过
    pub killed: bool,
}

#[cfg(windows)]
unsafe impl Send for Guard {}
#[cfg(windows)]
unsafe impl Sync for Guard {}

impl Guard {
    /// 进程是否还活着
    ///
    /// 用句柄直接等：DACL 收紧后 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`
    /// 会被拒，外部进程查不到它，但我们手里的句柄不受影响 → 只有自己能准确判活。
    pub fn is_alive(&self) -> bool {
        #[cfg(windows)]
        {
            if self.handle.is_null() {
                return false;
            }
            unsafe {
                let r = ffi::WaitForSingleObject(self.handle, 0);
                match r {
                    // WAIT_TIMEOUT = 还在跑
                    ffi::WAIT_TIMEOUT => true,
                    // WAIT_OBJECT_0 = 已退出
                    ffi::WAIT_OBJECT_0 => false,
                    // WAIT_FAILED 等：句柄缺 SYNCHRONIZE 或已被关闭，
                    // 退回外部快照判定（上锁后外部查得到 pid 但查不到镜像路径）
                    _ => crate::winproc::pid_exists_external(self.pid),
                }
            }
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    /// 退出码（仅已退出时有意义）
    pub fn exit_code(&self) -> Option<u32> {
        #[cfg(windows)]
        {
            if self.handle.is_null() {
                return None;
            }
            let mut code: u32 = 0;
            let ok = unsafe { ffi::GetExitCodeProcess(self.handle, &mut code) };
            if ok != 0 {
                Some(code)
            } else {
                None
            }
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    /// 用预留句柄终止（绕过收紧后的 DACL 检查）
    ///
    /// 这是「只有 alice 点停止才能杀掉」的关键一步。
    pub fn terminate(&mut self) -> bool {
        #[cfg(windows)]
        {
            if self.handle.is_null() {
                return false;
            }
            let ok = unsafe { ffi::TerminateProcess(self.handle, 1) != 0 };
            self.killed = ok;
            self.release();
            ok
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    #[cfg(windows)]
    fn release(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::CloseHandle(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }

    #[cfg(not(windows))]
    fn release(&mut self) {}
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.release();
    }
}

/// 取当前进程用户的 SID 字符串（形如 `S-1-5-21-...-1001`）
///
/// 用于把「WRITE_DAC 自愈权限」精确授予当前用户，而不是给整个 Users 组 ——
/// 组授权会让同机其它账户也能改 DACL，收得太宽。
#[cfg(windows)]
pub fn current_user_sid() -> Option<String> {
    unsafe {
        let mut tok: *mut std::ffi::c_void = std::ptr::null_mut();
        if ffi::OpenProcessToken(ffi::GetCurrentProcess(), ffi::TOKEN_QUERY, &mut tok) == 0 {
            return None;
        }
        let mut len: u32 = 0;
        // TokenUser = 1：先问长度
        ffi::GetTokenInformation(tok, 1, std::ptr::null_mut(), 0, &mut len);
        if len == 0 {
            ffi::CloseHandle(tok);
            return None;
        }
        let heap = ffi::GetProcessHeap();
        let buf = ffi::HeapAlloc(heap, 0, len as usize);
        if buf.is_null() {
            ffi::CloseHandle(tok);
            return None;
        }
        let ok = ffi::GetTokenInformation(tok, 1, buf, len, &mut len);
        let mut sid_str: Option<String> = None;
        if ok != 0 {
            // TOKEN_USER 的第一个成员就是 SID_AND_ATTRIBUTES.Sid
            let sid_ptr = *(buf as *const *mut std::ffi::c_void);
            let mut out: *mut u16 = std::ptr::null_mut();
            if ffi::ConvertSidToStringSidW(sid_ptr, &mut out) != 0 && !out.is_null() {
                let mut n = 0usize;
                while *out.add(n) != 0 {
                    n += 1;
                }
                sid_str = Some(String::from_utf16_lossy(std::slice::from_raw_parts(out, n)));
                ffi::LocalFree(out as *mut std::ffi::c_void);
            }
        }
        ffi::HeapFree(heap, 0, buf);
        ffi::CloseHandle(tok);
        sid_str
    }
}

#[cfg(not(windows))]
pub fn current_user_sid() -> Option<String> {
    None
}

/// 用给定 SDDL 串改目标进程对象的安全描述符
#[cfg(windows)]
fn set_process_sddl(pid: u32, sddl: &str) -> bool {
    unsafe {
        let h_dac = ffi::OpenProcess(ffi::WRITE_DAC | ffi::READ_CONTROL, 0, pid);
        if h_dac.is_null() {
            return false;
        }
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sd: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut sd_size: u32 = 0;
        let conv = ffi::ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            1,
            &mut sd,
            &mut sd_size,
        );
        if conv == 0 {
            ffi::CloseHandle(h_dac);
            return false;
        }
        let set = ffi::SetKernelObjectSecurity(h_dac, ffi::DACL_SECURITY_INFORMATION, sd);
        ffi::LocalFree(sd);
        ffi::CloseHandle(h_dac);
        set != 0
    }
}

/// 收紧目标进程 DACL，并把终止钥匙留成自己持有的句柄
///
/// 顺序不能反：先拿 PROCESS_TERMINATE 句柄，再改 DACL。
/// 返回 None = 上锁失败（权限不足等），调用方继续按普通路径管理，不影响功能。
#[cfg(windows)]
pub fn lock_pid(pid: u32) -> Option<Guard> {
    if pid <= 4 {
        return None;
    }
    // 先预留终止句柄——DACL 收紧后就再也拿不到了
    //
    // 同时要 SYNCHRONIZE：后面判活用的是 WaitForSingleObject，
    // 而访问检查只在这一刻做一次，收紧后再补申请会被拒。
    let h_kill = unsafe {
        ffi::OpenProcess(
            ffi::PROCESS_TERMINATE
                | ffi::PROCESS_QUERY_LIMITED_INFORMATION
                | ffi::SYNCHRONIZE,
            0,
            pid,
        )
    };
    if h_kill.is_null() {
        return None;
    }

    // 组 SDDL：给当前用户留 WRITE_DAC，崩溃后可自愈
    let sid = match current_user_sid() {
        Some(s) => s,
        None => {
            unsafe { ffi::CloseHandle(h_kill) };
            return None;
        }
    };
    let sddl = ffi::LOCK_SDDL_FMT.replace("{sid}", &sid);
    if !set_process_sddl(pid, &sddl) {
        unsafe { ffi::CloseHandle(h_kill) };
        return None;
    }

    Some(Guard {
        pid,
        handle: h_kill,
        killed: false,
    })
}

#[cfg(not(windows))]
pub fn lock_pid(_pid: u32) -> Option<Guard> {
    None
}

/// 自愈：把**包内残留的、已被上锁的**进程恢复成可终止并杀掉
///
/// 场景：alice 被强杀 / 崩溃，预留句柄随进程消失，残留的 codex 还带着收紧的
/// DACL —— 普通 OpenProcess(PROCESS_TERMINATE) 会被拒。
/// 这里用当前用户保留的 WRITE_DAC 权限把 DACL 放宽，再正常终止。
///
/// **只对调用方传入的 pid 生效**，调用方必须已确认镜像路径在包内。
#[cfg(windows)]
pub fn recover_and_kill(pid: u32) -> bool {
    if pid <= 4 {
        return false;
    }
    if !set_process_sddl(pid, ffi::UNLOCK_SDDL) {
        return false;
    }
    unsafe {
        let h = ffi::OpenProcess(ffi::PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return false;
        }
        let ok = ffi::TerminateProcess(h, 1) != 0;
        ffi::CloseHandle(h);
        ok
    }
}

#[cfg(not(windows))]
pub fn recover_and_kill(_pid: u32) -> bool {
    false
}

/// 保护句柄池 + 世代号
///
/// `epoch` 用来让「启动时开的别名盯守线程」在用户点停止后立刻收手，
/// 避免停止完成后又被它锁上残留进程。
///
/// 设计边界（老板 2026-09-20 决定）：**不做进程守护、不做自动重建**。
/// 原因：用户态 DACL 挡不住提权终止（提权令牌带 SeDebugPrivilege，
/// OpenProcess 的访问检查会被跳过），靠「死了换名重建」来对抗属于
/// 猫鼠游戏，且会把「停止」变成不确定行为。这里只保留：
///   ① 每次启动一个随机镜像名（硬链接，不复制文件）
///   ② 进程对象 DACL 收紧，非提权工具杀不掉
///   ③ alice 自己预留终止句柄，点停止一定能停
pub struct AliasGuards {
    pub guards: Mutex<Vec<Guard>>,
    pub epoch: std::sync::atomic::AtomicU64,
}

impl Default for AliasGuards {
    fn default() -> Self {
        Self {
            guards: Mutex::new(Vec::new()),
            epoch: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

impl AliasGuards {
    /// 当前世代（盯守线程记下它，换代就退出）
    pub fn epoch(&self) -> u64 {
        self.epoch.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 换代：停止时调用
    pub fn bump(&self) -> u64 {
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    pub fn push(&self, g: Guard) {
        self.guards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(g);
    }

    /// 用预留句柄终止所有被保护的进程，返回 (尝试数, 成功数)
    pub fn terminate_all(&self) -> (usize, usize) {
        let mut v = self.guards.lock().unwrap_or_else(|e| e.into_inner());
        let n = v.len();
        let mut ok = 0;
        for g in v.iter_mut() {
            if g.terminate() {
                ok += 1;
            }
        }
        v.clear();
        (n, ok)
    }

    /// 当前受保护进程的 pid 列表
    pub fn pids(&self) -> Vec<u32> {
        self.guards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|g| g.pid)
            .collect()
    }

    /// 撤掉某个 pid 的保护句柄（进程已退出时调用，防止句柄泄漏）
    ///
    /// 注意：只 drop 句柄本身，不做任何终止 —— 句柄是「钥匙」，
    /// 进程已死时留着它没有意义，还会白占内核对象。
    pub fn drop_pid(&self, pid: u32) {
        self.guards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|g| g.pid != pid);
    }

    /// 某 pid 是否仍在受保护集合里
    pub fn contains(&self, pid: u32) -> bool {
        self.guards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|g| g.pid == pid)
    }
}

// ------------------------------------------------------------
//  别名注册表：崩溃 / 被强杀后下次启动回收遗留链接 + 自愈被杀进程
//
//  格式：每行 `<pid>|<别名绝对路径>`
//  记 pid 的原因：崩溃后残留进程带着收紧的 DACL，普通终止会被拒；
//  下次启动按 pid 走 `recover_and_kill`（放宽 DACL 再杀）才能收拾干净。
// ------------------------------------------------------------

fn registry_path(codex_home: &Path) -> PathBuf {
    codex_home.join("alias-registry.txt")
}

fn read_registry(codex_home: &Path) -> Vec<(u32, PathBuf)> {
    let Ok(cur) = std::fs::read_to_string(registry_path(codex_home)) else {
        return Vec::new();
    };
    cur.lines()
        .filter_map(|l| {
            let s = l.trim();
            if s.is_empty() {
                return None;
            }
            let (pid_s, path_s) = s.split_once('|')?;
            Some((pid_s.trim().parse::<u32>().ok()?, PathBuf::from(path_s.trim())))
        })
        .collect()
}

fn write_registry(codex_home: &Path, rows: &[(u32, PathBuf)]) {
    let body: String = rows
        .iter()
        .map(|(p, f)| format!("{p}|{}\n", f.display()))
        .collect();
    let _ = std::fs::write(registry_path(codex_home), body);
}

pub fn register(codex_home: &Path, pid: u32, path: &Path) {
    if let Some(dir) = registry_path(codex_home).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut rows = read_registry(codex_home);
    if rows.iter().any(|(_, f)| f == path) {
        return;
    }
    rows.push((pid, path.to_path_buf()));
    write_registry(codex_home, &rows);
}

pub fn unregister(codex_home: &Path, path: &Path) {
    let mut rows = read_registry(codex_home);
    let before = rows.len();
    rows.retain(|(_, f)| f != path);
    if rows.len() != before {
        write_registry(codex_home, &rows);
    }
}

/// 启动前回收：**只处理进程已消失的**遗留别名，绝不碰仍在运行的实例
///
/// 与 `sweep_registry` 的区别就是这条 —— 另一个 alice 实例可能正开着 codex，
/// 启动时把它杀掉属于误伤。
///
/// 返回删除的链接数。
pub fn sweep_registry_orphans(codex_home: &Path) -> usize {
    let rows = read_registry(codex_home);
    if rows.is_empty() {
        return 0;
    }
    let mut kept: Vec<(u32, PathBuf)> = Vec::new();
    let mut removed = 0usize;
    for (pid, path) in rows {
        let still_running = pid > 4 && crate::winproc::pid_exists_external(pid);
        if still_running {
            kept.push((pid, path));
            continue;
        }
        // 进程已不在 → 链接可以安全删掉
        if path.exists() {
            clear_hidden(&path);
            let _ = std::fs::remove_file(&path);
            removed += 1;
        }
    }
    write_registry(codex_home, &kept);
    removed
}

/// 停止时回收：自愈杀掉仍活着的残留进程，并删掉别名链接
///
/// 「自愈」是必要的：alice 崩溃后残留进程带着收紧的 DACL，
/// 普通 `OpenProcess(PROCESS_TERMINATE)` 会被拒 —— 用当前用户保留的
/// WRITE_DAC 权限先放宽再杀。用户点了停止就是要全停，含另一实例。
///
/// 返回 (杀掉的进程数, 删除的链接数)。
pub fn sweep_registry(codex_home: &Path) -> (usize, usize) {
    let rows = read_registry(codex_home);
    if rows.is_empty() {
        return (0, 0);
    }
    let mut kept: Vec<(u32, PathBuf)> = Vec::new();
    let mut killed = 0usize;
    let mut removed = 0usize;

    for (pid, path) in rows {
        // ① 进程可能还活着且带着收紧的 DACL —— 先自愈终止
        if pid > 4 && crate::winproc::pid_exists_external(pid) {
            if recover_and_kill(pid) {
                killed += 1;
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
        }
        // ② 删别名链接（硬链接，删链接不动真身）
        if path.exists() {
            clear_hidden(&path);
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
                continue;
            }
            kept.push((pid, path));
        }
    }
    write_registry(codex_home, &kept);
    (killed, removed)
}

/// 兜底清扫（仅停止路径）：注册表丢失时，按目录里 `wz????????.exe` 形态
/// 找遗留别名，并把仍在运行、镜像就是别名的进程自愈终止。
///
/// 返回 (杀掉的进程数, 删除的链接数)。
pub fn sweep_dir_aliases(dir: &Path) -> (usize, usize) {
    let root = dir.display().to_string();
    // ① 先处理「还在跑、镜像就是别名」的进程（否则删了链接它们照样活着）
    let mut killed = 0usize;
    for row in crate::winproc::snapshot() {
        if !is_alias_name(&row.name) {
            continue;
        }
        let Some(img) = crate::winproc::image_path(row.pid) else {
            continue;
        };
        if !img.to_ascii_lowercase().starts_with(&root.to_ascii_lowercase()) {
            continue;
        }
        if recover_and_kill(row.pid) {
            killed += 1;
        }
    }

    // ② 再删遗留链接
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (killed, 0);
    };
    let mut removed = 0usize;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !is_alias_name(&name) {
            continue;
        }
        let p = e.path();
        clear_hidden(&p);
        if std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    (killed, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_stems_unique_and_shaped() {
        let a = random_stem();
        let b = random_stem();
        assert_ne!(a, b);
        assert_eq!(a.len(), ALIAS_PREFIX.len() + ALIAS_BODY_LEN);
        assert!(a.starts_with(ALIAS_PREFIX));
        assert!(a[ALIAS_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        // 不能带任何能被「按名字杀」识别的特征词
        assert!(!a.contains("codex") && !a.contains("alice") && !a.contains("wangzha"));
    }

    #[test]
    fn alias_name_recognizer_matches_only_our_shape() {
        assert!(is_alias_name("wz7f3a91c2.exe"));
        assert!(is_alias_name("WZ7F3A91C2.EXE"));
        assert!(!is_alias_name("codex.exe"));
        assert!(!is_alias_name("wz7f3a91c2.dll"));
        assert!(!is_alias_name("wz7f3a91c.exe"), "长度不对不算");
        assert!(!is_alias_name("ab7f3a91c2.exe"), "前缀不对不算");
    }

    /// 真机：建硬链接 → 与真身同数据 → 删链接不影响真身
    #[cfg(windows)]
    #[test]
    fn hardlink_creation_and_removal() {
        let tmp = std::env::temp_dir().join(format!("wz-alias-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let target = tmp.join("target.exe");
        std::fs::write(&target, b"payload-not-a-real-exe").unwrap();

        let alias = make_alias(&target).expect("应能建硬链接");
        assert!(alias.path.exists());
        assert!(is_alias_name(
            &alias.path.file_name().unwrap().to_string_lossy()
        ));
        assert_eq!(
            std::fs::read(&alias.path).unwrap(),
            std::fs::read(&target).unwrap(),
            "硬链接应与真身同数据"
        );

        alias.remove();
        assert!(!alias.path.exists(), "别名应已删除");
        assert!(target.exists(), "删别名不能影响真身");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn registry_roundtrip_and_sweep() {
        let tmp = std::env::temp_dir().join(format!("wz-reg-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let p = tmp.join("wz12345678.exe");
        std::fs::write(&p, b"x").unwrap();

        // pid 用一个必然不存在的值，避免误杀真实进程
        register(&tmp, 4_000_000_000, &p);
        assert!(std::fs::read_to_string(registry_path(&tmp))
            .unwrap()
            .contains("wz12345678.exe"));

        let (killed, removed) = sweep_registry(&tmp);
        assert_eq!(killed, 0, "假 pid 不该被杀");
        assert_eq!(removed, 1, "应回收 1 个别名");
        assert!(!p.exists());
        assert!(std::fs::read_to_string(registry_path(&tmp))
            .unwrap()
            .trim()
            .is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 真机：上锁后外部杀不掉、自己句柄能杀掉
    ///
    /// 用系统自带 ping.exe 当靶子（拷进临时目录再建别名），
    /// 完整走一遍「别名 → 启动 → 上锁 → 外部终止失败 → 句柄终止成功」。
    #[cfg(windows)]
    #[test]
    fn lock_blocks_external_kill_but_own_handle_works() {
        use std::process::Command;
        let src = r"C:\Windows\System32\ping.exe";
        if !Path::new(src).exists() {
            eprintln!("跳过：{src} 不存在");
            return;
        }
        let dir = std::env::temp_dir().join(format!("wz-lock-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("victim.exe");
        std::fs::copy(src, &target).unwrap();

        let alias = make_alias(&target).expect("应能建别名");
        let mut child = Command::new(&alias.path)
            .args(["-n", "120", "127.0.0.1"])
            .spawn()
            .expect("靶子应能启动");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(500));

        let mut guard = lock_pid(pid).expect("应能上锁");
        assert_eq!(guard.pid, pid);
        assert!(guard.is_alive(), "上锁后仍应活着");

        // 外部视角：OpenProcess(PROCESS_TERMINATE) 应被 DACL 拒绝
        let external = crate::winproc::kill_pid_force(pid);
        assert!(!external, "上锁后外部强制终止必须失败");
        assert!(
            matches!(child.try_wait(), Ok(None)),
            "上锁后靶子应仍存活"
        );

        // 自己的预留句柄：应能终止
        assert!(guard.terminate(), "预留句柄终止必须成功");
        let mut gone = false;
        for _ in 0..30 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(gone, "用预留句柄终止后进程应已退出");

        let _ = child.kill();
        alias.remove();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真机：句柄丢失（模拟 alice 崩溃）后，自愈路径仍能把残留杀掉
    #[cfg(windows)]
    #[test]
    fn recover_path_kills_locked_leftover() {
        use std::process::Command;
        let src = r"C:\Windows\System32\ping.exe";
        if !Path::new(src).exists() {
            eprintln!("跳过：{src} 不存在");
            return;
        }
        let dir = std::env::temp_dir().join(format!("wz-recover-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("victim2.exe");
        std::fs::copy(src, &target).unwrap();

        let mut child = Command::new(&target)
            .args(["-n", "120", "127.0.0.1"])
            .spawn()
            .expect("靶子应能启动");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(500));

        // 上锁后**主动丢弃**句柄 —— 等价于 alice 崩溃
        let guard = lock_pid(pid).expect("应能上锁");
        drop(guard);

        // 此时外部终止应该失败（证明真的锁上了）
        assert!(
            !crate::winproc::kill_pid_force(pid),
            "句柄丢弃后外部终止仍应被拒"
        );

        // 自愈路径：用留下的 WRITE_DAC 放宽 DACL 再杀
        assert!(recover_and_kill(pid), "自愈路径应能杀掉残留");

        let mut gone = false;
        for _ in 0..30 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(gone, "自愈后残留进程应已退出");

        let _ = child.kill();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
