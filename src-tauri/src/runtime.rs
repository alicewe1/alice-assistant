// 运行时探针与王炸codex 生命周期管理
//
// 设计要点：
// - 路径全部从 runtime root 推导，不写死盘符（环境变量 ALICE_RUNTIME_ROOT 可覆盖）
// - 子进程带 CREATE_NO_WINDOW，避免 GUI 程序启动 console 程序时闪黑框
// - 进程树终止用原生 taskkill /T /F（零额外依赖）；阶段三可换 Job Object 硬限制
// - exec 模式：stdout/stderr 逐行读取，通过 Tauri 事件流推给前端

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

// 进程树治理：Job Object + 快照清扫（见 winproc.rs）
use crate::winproc;
// 随机镜像名 + 独占终止保护（见 alias.rs）
use crate::alias;

/// 本机（用户自己装的）codex 配置目录：`%USERPROFILE%\.codex`
///
/// 与包内 `.codex` 区分：这个是「透传源」，只在用户点「透传」时读。
/// 不写死盘符/用户名，从 USERPROFILE 推导。
fn host_codex_home() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOME").ok().filter(|s| !s.is_empty()))?;
    Some(PathBuf::from(home).join(".codex"))
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// CLI 模式要真控制台：新开一个 console 窗口（不能用 CREATE_NO_WINDOW）
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// 运行体根目录定位（按优先级）
///
/// 分发形态（扁平化后）：
///   新alice助手\
///   ├── 新alice助手.exe
///   └── resources\        ← 运行体直接展开在这（不再有 王炸codex 包装层）
///       ├── .codex\  runtime\  tools\  data\  workspace\
///       ├── _assets\        素材库（技能/提示词）
///       └── profiles\       版本清单
///
/// 顺序：
///   1. ALICE_RUNTIME_ROOT 环境变量（排障/自定义部署）
///   2. exe 同级 resources            ← 正式分发形态
///   3. exe 同级 resources\王炸codex   ← 兼容旧包装结构
///   4. exe 同级 王炸codex
///   5. Tauri resource_dir
///   6. 开发期兜底
pub fn runtime_root(app: &AppHandle) -> PathBuf {
    if let Ok(env) = std::env::var("ALICE_RUNTIME_ROOT") {
        if !env.is_empty() {
            return PathBuf::from(env);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for c in [
                dir.join("resources"),
                dir.join("resources/王炸codex"),
                dir.join("王炸codex"),
            ] {
                // 认「含 .codex 的 resources」为运行体根，避免把恰好的空目录认错
                if c.join(".codex").exists() || c.join("runtime").exists() {
                    return c;
                }
            }
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        for c in [dir.join("resources"), dir.join("王炸codex"), dir.clone()] {
            if c.join(".codex").exists() {
                return c;
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    for c in [
        cwd.join("resources"),
        PathBuf::from("F:/重构ui/新alice助手/resources"),
        cwd.join("../新alice助手/resources"),
        PathBuf::from("F:/重构ui/alice破甲/resources/王炸codex"),
    ] {
        if c.join(".codex").exists() {
            return c;
        }
    }
    cwd
}

fn codex_exe_path(root: &Path) -> PathBuf {
    root.join(
        "runtime/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    )
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// ---------- 引擎探针 ----------

#[derive(Serialize, Clone)]
pub struct ProbeCheck {
    pub key: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct Counts {
    pub skills: usize,
    pub prompts: usize,
    pub mcp_libs: usize,
}

/// 提示词库的一个来源（体检项里可切换查看）
#[derive(Serialize, Clone)]
pub struct PromptSource {
    /// 相对包根的路径，如 `_assets/prompts`
    pub rel: String,
    pub label: String,
    /// 绝对路径
    pub path: String,
    /// 该来源下的 .md 数量
    pub count: usize,
    /// 是否被 config.toml 的 model_instructions_file 指向（即「当前生效」）
    pub active: bool,
}

/// config.toml 的关键字段（只同步这些，不整份覆盖）
#[derive(Serialize, Clone, Default)]
pub struct ConfigModelFields {
    pub model: String,
    pub model_provider: String,
    pub model_reasoning_effort: String,
    pub model_context_window: String,
    pub model_auto_compact_token_limit: String,
    pub disable_response_storage: String,
    /// [model_providers.<name>] 段的原始文本（含 base_url 等）
    pub provider_block: String,
    /// 从哪个文件读到的（本机 or 包内）
    pub from: String,
}

#[derive(Serialize, Clone)]
pub struct ProbeReport {
    pub root: String,
    pub checks: Vec<ProbeCheck>,
    pub counts: Counts,
    pub runtime_mb: u64,
    pub has_key: bool,
    pub codex_version: String,
    pub adb_version: String,
    pub python_version: String,
    pub ok: bool,
    /// 提示词库来源清单（供体检项切换）
    pub prompt_sources: Vec<PromptSource>,
    /// 包内 config.toml 当前使用的 provider 名（如 custom）
    pub config_provider: String,
    /// 本机 config.toml 是否存在
    pub host_config_exists: bool,
    /// 本机 config.toml 路径
    pub host_config_path: String,
}

fn dir_count(p: &Path) -> usize {
    std::fs::read_dir(p)
        .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).count())
        .unwrap_or(0)
}

// ============================================================
// 运行体体积：只扫关键子目录 + 缓存
// ============================================================
//
// 为什么不能整树 walk 包根（实测数据，2026-09-20）：
//   包根共 26131 个文件 / 4741 MB，`Get-ChildItem -Recurse` 等价遍历实测 1.8s，
//   逐目录拆开是 runtime 351ms + _assets 550ms + .codex 1331ms + data 195ms，
//   合计 ≈2.4s。engine_probe 里这一项就吃掉了探针 2.6s 总耗时里的 93%。
//
// 两处修正：
//   ① 只统计真正决定**分发体积**的四块（见 SIZE_DIRS），跳过 data/ 与 workspace/；
//   ② 结果带缓存 —— 体积不会每次自检都变，没必要反复重走几万个文件。

/// 参与体积统计的子目录（相对包根）。
///
/// 为什么跳过 data/ 与 workspace/：
///   · data/ 是运行时私有 APPDATA/TEMP，README 明说「可删，自动重建」，
///     里面是 WebView2 缓存与日志；它还是**最多变**的一块（每次运行都在长），
///     把它算进「运行体体积」既没意义又让读数每次都变。
///   · workspace/ 是 codex 工作目录，装的是用户自己的工程文件，同样不属于运行体。
const SIZE_DIRS: [&str; 4] = ["runtime", "_assets", ".codex", "tools"];

/// 体积缓存有效期。到期后重算一次，保证用户手工增删素材后读数最终会跟上。
const SIZE_CACHE_TTL_MS: u64 = 120_000;

/// (包根, 值MB, 计算时刻ms, 关键子目录 mtime 指纹)
static SIZE_CACHE: Mutex<Option<(String, u64, u64, Vec<u64>)>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 关键子目录的 mtime 指纹。
///
/// 说明：NTFS 的目录 mtime **不保证**随子树增删而变（深层文件改动不会冒泡到根），
/// 所以它只当「廉价的第一道提示」，真正兜底的是 TTL。两者取或：
/// 指纹变了立刻重算，指纹没变也最多 120s 重算一次。
fn size_dirs_stamp(root: &Path) -> Vec<u64> {
    SIZE_DIRS
        .iter()
        .map(|d| {
            std::fs::metadata(root.join(d))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0)
        })
        .collect()
}

/// 递归累加目录体积（字节）。
fn dir_bytes(dir: &Path, acc: &mut u64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let path = e.path();
        if path.is_dir() {
            dir_bytes(&path, acc);
        } else if let Ok(meta) = e.metadata() {
            *acc += meta.len();
        }
    }
}

/// 运行体体积（MB）。`force=true` 跳过缓存强制重算。
fn runtime_size_mb(root: &Path, force: bool) -> u64 {
    let key = root.display().to_string();
    let stamp = size_dirs_stamp(root);

    if !force {
        if let Ok(g) = SIZE_CACHE.lock() {
            if let Some((k, mb, at, st)) = g.as_ref() {
                if *k == key && *st == stamp && now_ms().saturating_sub(*at) < SIZE_CACHE_TTL_MS {
                    return *mb;
                }
            }
        }
    }

    let mut total = 0u64;
    for d in SIZE_DIRS {
        let p = root.join(d);
        if p.is_dir() {
            dir_bytes(&p, &mut total);
        }
    }
    let mb = total / 1024 / 1024;
    if let Ok(mut g) = SIZE_CACHE.lock() {
        *g = Some((key, mb, now_ms(), stamp));
    }
    mb
}

fn first_line(exe: &Path, args: &[&str]) -> String {
    if !exe.exists() {
        return String::new();
    }
    let mut cmd = Command::new(exe);
    cmd.args(args);
    hidden(&mut cmd);
    match cmd.output() {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.lines().next().unwrap_or("").trim().to_string()
        }
        Err(_) => String::new(),
    }
}

/// 从 TOML 文本里取顶层 `key = value` 的原始值（去引号）
///
/// 为什么不引 toml crate：这里只需要读几个已知的顶层标量，
/// 加一个依赖不值得；而且必须**原样保留**用户写的值（含引号风格），
/// 解析再序列化反而会改写格式。
pub(crate) fn toml_scalar(text: &str, key: &str) -> String {
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let v = rest.trim();
        // 去掉行尾注释（只处理不在引号内的 #，简单起见按第一个 " #" 切）
        let v = v.split(" #").next().unwrap_or(v).trim();
        return v.trim_matches('"').trim_matches('\'').to_string();
    }
    String::new()
}

/// 取顶层 `key = value` 的右侧**原文**（含引号、含数字/布尔字面量）。
///
/// ══ 为什么必须有这个函数（一次真实事故的教训）══════════════════════
/// 首版 sync 用的是 `toml_scalar` —— 那个函数为了**界面显示**会把引号剥掉，
/// 返回 `cn:deepseek-v4.1-flash`。把它直接拼回文件就写出：
///     model = cn:deepseek-v4.1-flash      ← 非法 TOML（冒号值必须带引号）
/// 桌面端启动时报 `string values must be quoted, expected literal string`。
///
/// 结论：**回写一律用原文，绝不重新渲染**。
/// 显示走 toml_scalar（剥引号好看），写入走 raw_scalar（逐字照抄），
/// 两条路分开，就不存在「引号风格丢失」这类问题。
fn raw_scalar(text: &str, key: &str) -> Option<String> {
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let rest = match line.strip_prefix(key) {
            Some(r) => r,
            None => continue,
        };
        let rest = match rest.trim_start().strip_prefix('=') {
            Some(r) => r,
            None => continue,
        };
        // 行尾注释要切掉，但只切引号之外的 #（简化：按 " #" 切，够用且安全）
        let v = rest.trim().split(" #").next().unwrap_or(rest).trim();
        if v.is_empty() {
            return None;
        }
        return Some(v.to_string());
    }
    None
}

/// 结构校验：挡住「裸字符串」这类会让整个文件失效的错误。
///
/// 不引 toml crate（只用一次，不值当），但必须挡住事故那一类：
/// 裸 token 里含 `:` `/` 空格 或非 ASCII —— 合法 TOML 中这些必须带引号。
fn toml_looks_valid(text: &str) -> Result<(), String> {
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            return Err(format!("第 {} 行不是合法的 key = value：{}", i + 1, line));
        };
        let v = v.split(" #").next().unwrap_or(v).trim();
        if v.is_empty() {
            return Err(format!("第 {} 行的值为空：{}", i + 1, line));
        }
        let quoted = v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\'')));
        let structural = v.starts_with('[') || v.starts_with('{');
        let literal = v == "true" || v == "false" || v.parse::<f64>().is_ok();
        if !quoted && !structural && !literal {
            if v.contains(':') || v.contains('/') || v.contains(' ') || !v.is_ascii() {
                return Err(format!(
                    "第 {} 行的字符串值缺少引号：{} = {}",
                    i + 1,
                    k.trim(),
                    v
                ));
            }
        }
    }
    Ok(())
}

/// 抽取 `[model_providers.<name>]` 整段（含段头到下一个段头之前）
fn toml_section(text: &str, header: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim_start().starts_with('[') {
            let is_target = line.trim() == header;
            if inside && !is_target {
                break;
            }
            inside = is_target;
        }
        if inside {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim_end().to_string()
}

/// 解析 config.toml 的关键字段（只读，不改文件）
fn read_config_fields(path: &Path, from: &str) -> ConfigModelFields {
    let Ok(text) = std::fs::read_to_string(path) else {
        return ConfigModelFields {
            from: from.to_string(),
            ..Default::default()
        };
    };
    let provider = {
        let p = toml_scalar(&text, "model_provider");
        if p.is_empty() {
            "custom".to_string()
        } else {
            p
        }
    };
    ConfigModelFields {
        model: toml_scalar(&text, "model"),
        model_provider: provider.clone(),
        model_reasoning_effort: toml_scalar(&text, "model_reasoning_effort"),
        model_context_window: toml_scalar(&text, "model_context_window"),
        model_auto_compact_token_limit: toml_scalar(&text, "model_auto_compact_token_limit"),
        disable_response_storage: toml_scalar(&text, "disable_response_storage"),
        provider_block: toml_section(&text, &format!("[model_providers.{provider}]")),
        from: from.to_string(),
    }
}

/// config.toml 里 model_instructions_file 指向的相对路径（用于标记「当前生效」的提示词源）
fn active_instructions_rel(path: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    // 形如 "./prompts/wangzha-jailbreak.md" → prompts
    let v = toml_scalar(&text, "model_instructions_file");
    let v = v.trim_start_matches("./");
    match v.split_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    }
}

/// 扫描提示词库的各个来源（体检项里可切换）
fn scan_prompt_sources(root: &Path, codex_home: &Path) -> (Vec<PromptSource>, usize) {
    let candidates: [(&str, &str); 5] = [
        ("_assets/prompts", "内置提示词库"),
        (".codex/prompts", "包内 .codex/prompts"),
        ("_assets/gpt-6-astra-v1", "Astra 合集"),
        ("_assets/dsh-lazy-pack-v5/prompts", "DSH 懒人包"),
        ("_assets/prompts/other", "第三方素材"),
    ];
    let active_rel = active_instructions_rel(&codex_home.join("config.toml"));

    let mut out = Vec::new();
    let mut total = 0usize;
    for (rel, label) in candidates {
        let dir = root.join(rel);
        if !dir.is_dir() {
            continue;
        }
        let n = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| {
                        let p = e.path();
                        p.is_file() && p.extension().map(|x| x == "md").unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0);
        if n == 0 {
            continue;
        }
        total += n;
        out.push(PromptSource {
            rel: rel.to_string(),
            label: label.to_string(),
            path: dir.display().to_string(),
            count: n,
            // model_instructions_file 指向 prompts/* 时，_assets/prompts 与 .codex/prompts
            // 都算「生效源」——两者内容由构建期同步，不能只认一个
            active: !active_rel.is_empty() && rel.ends_with(&active_rel),
        });
    }
    (out, total)
}

/// 运行体根目录（前端要拼 `_assets/other` 之类的路径时用）。
///
/// 单独开这个命令，是为了让界面上的「选源」对话框能默认打开
/// `_assets/other/`（第三方素材约定存放处），不必让用户自己翻盘符。
#[tauri::command]
pub fn runtime_root_path(app: AppHandle) -> String {
    runtime_root(&app).display().to_string()
}

/// 引擎自检。
///
/// 为什么必须是 `async`（2026-09-20 修「启动后第一次点击卡 1s」）：
///   Tauri v2 的**同步** command 跑在主线程上。本函数原先同步，内部还要
///   走目录树算体积，实测一次 2.6s —— 主线程被占住期间窗口收不到输入消息，
///   表现就是「点哪都没反应」。CDP 实测：probe 执行中调用任意简单命令
///   也要排队 2619ms，而同刻渲染进程 rAF 最大空档仅 7ms、无 longtask
///   （即画面没卡，卡的是应用进程的消息泵）。
///   本仓库 import_skill.rs 早已踩过同一个坑并写下结论：
///   「同步 command 跑在主线程上，直接用它会把界面卡死」。
///   `#[tauri::command(async)]` 把它挪到线程池，界面全程可响应。
#[tauri::command(async)]
pub fn engine_probe(app: AppHandle, deep: Option<bool>) -> ProbeReport {
    let root = runtime_root(&app);
    // deep = 用户主动点的「自检」：跑子进程版本号 + 强制重算体积。
    // 启动时的自动探针传 false/缺省：跳过 --version 子进程（省 ~100ms），
    // 体积走缓存（首次仍要算一次，之后 120s 内直接命中）。
    let deep = deep.unwrap_or(false);
    let codex_home = root.join(".codex");
    let skills = codex_home.join("skills");
    let prompts = codex_home.join("prompts");
    let mcp_libs = codex_home.join("mcp/_libs");
    let tools = root.join("tools");
    let codex_exe = codex_exe_path(&root);
    let config = codex_home.join("config.toml");
    let key_file = codex_home.join("api_key.txt");
    let adb = tools.join("adb.exe");

    // 版本号要起子进程（codex 47ms / adb 44ms / python 15ms，实测）。
    // 启动路径不必知道确切版本，省掉这三次进程创建；体检项的 detail 用
    // 路径/「已就绪」占位，用户点「自检」时才填真实版本。
    let (codex_version, adb_version, python_version) = if deep {
        (
            first_line(&codex_exe, &["--version"]),
            first_line(&adb, &["version"]),
            first_line(Path::new("python"), &["--version"]),
        )
    } else {
        (String::new(), String::new(), String::new())
    };

    // ---- 桌面端完整性：不能只看 ChatGPT.exe 在不在 ----
    //
    // 为什么必须查目录内这几项：包内 ChatGPT.exe 与用户自己装的 Codex
    // **同属 AppX 身份 OpenAI.Codex**。若包内的 .codex / resources 不完整，
    // 它会退化成加载本机已装版的数据，看起来「能启动」但用的不是包内配置。
    // 这里逐项验证包内自足所需的最小集合。
    let desktop_dir = root.join("runtime/desktop/app");
    let desktop_parts: [(&str, PathBuf); 4] = [
        ("ChatGPT.exe", desktop_dir.join("ChatGPT.exe")),
        ("resources/codex.exe", desktop_dir.join("resources/codex.exe")),
        ("app.asar", desktop_dir.join("resources/app.asar")),
        ("cua_node", desktop_dir.join("resources/cua_node")),
    ];
    let missing: Vec<&str> = desktop_parts
        .iter()
        .filter(|(_, p)| !p.exists())
        .map(|(n, _)| *n)
        .collect();
    let desktop_ok = missing.is_empty();

    // ---- 提示词库来源 ----
    let (prompt_sources, prompt_total) = scan_prompt_sources(&root, &codex_home);

    // ---- 目标客户端工作路径体检 ----
    //
    // 每个客户端（profiles/<id>/）的工作路径由 manifest 的注入落点反推
    // （见 profiles::infer_work_dir）。路径不存在 = 该客户端的注入点
    // 指向一个不存在的目录，安装必然失败或装到错地方。
    // 用户要求体检必须覆盖这一项。
    let client_paths: Vec<(String, String, bool)> = crate::profiles::clients_list(app.clone())
        .into_iter()
        .map(|c| {
            let wd = c.work_dir.clone();
            let exists = !wd.is_empty() && PathBuf::from(&wd).is_dir();
            (c.label, wd, exists)
        })
        .collect();
    let bad_clients: Vec<&(String, String, bool)> =
        client_paths.iter().filter(|(_, wd, ok)| !*ok || wd.is_empty()).collect();
    let client_ok = bad_clients.is_empty();

    // config.toml 里当前用的 provider 名（如 custom）
    let config_provider = {
        let p = toml_scalar(
            &std::fs::read_to_string(&config).unwrap_or_default(),
            "model_provider",
        );
        if p.is_empty() {
            "—".to_string()
        } else {
            p
        }
    };
    let host_cfg = host_codex_home().map(|h| h.join("config.toml"));
    let host_config_exists = host_cfg.as_ref().map(|p| p.exists()).unwrap_or(false);
    let host_config_path = host_cfg
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    let checks = vec![
        ProbeCheck {
            key: "codexHome".into(),
            label: "配置文件 config.toml".into(),
            ok: config.exists(),
            detail: if host_config_exists {
                format!("包内 provider={config_provider} · 可透传本机")
            } else {
                format!("包内 provider={config_provider} · 本机无配置")
            },
        },
        ProbeCheck {
            key: "codexExe".into(),
            label: "codex 运行时".into(),
            ok: codex_exe.exists(),
            detail: if !codex_exe.exists() {
                codex_exe.display().to_string()
            } else if codex_version.is_empty() {
                "已就绪（版本号需点「自检」读取）".into()
            } else {
                codex_version.clone()
            },
        },
        ProbeCheck {
            key: "desktopExe".into(),
            label: "桌面端完整性".into(),
            ok: desktop_ok,
            detail: if desktop_ok {
                format!("包内自足 · {} 项齐备", desktop_parts.len())
            } else {
                format!("缺 {} 项：{}", missing.len(), missing.join("、"))
            },
        },
        ProbeCheck {
            key: "skills".into(),
            // 注意：这一项量的是**便携箱已装技能**（<配置目录>/skills），
            // 不是素材库的「技能库根」（<素材库>/skill）。
            // 两者同名不同物，标签写清避免误读。
            label: "便携箱技能（已装）".into(),
            ok: skills.is_dir(),
            detail: format!("{} 个技能", dir_count(&skills)),
        },
        ProbeCheck {
            key: "prompts".into(),
            label: "提示词库".into(),
            ok: prompts.is_dir(),
            detail: format!("{} 个文件 · {} 个来源", prompt_total, prompt_sources.len()),
        },
        /*
         * 「MCP 依赖库」「内置工具（adb）」两项自检已移除（用户要求）：
         *   · mcp/ 与 tools/ 是可选附件，不是运行体必需 —— 缺了 codex 照常能跑；
         *   · 把「可选件缺失」算进体检失败会让 7/7 变 5/7，误导用户以为坏了。
         * mcp 计数仍显示在顶栏徽标（counts.mcp_libs），只是不再作为过关项。
         */
        ProbeCheck {
            key: "clientPaths".into(),
            label: "目标客户端路径".into(),
            ok: client_ok,
            detail: if client_paths.is_empty() {
                "还没有客户端（在「目标」页新建）".into()
            } else if client_ok {
                format!("{} 个客户端工作路径均存在", client_paths.len())
            } else {
                format!(
                    "{} 个客户端路径异常：{}",
                    bad_clients.len(),
                    bad_clients
                        .iter()
                        .map(|(l, wd, _)| if wd.is_empty() {
                            format!("{l}（未配置工作路径）")
                        } else {
                            format!("{l}（{wd} 不存在）")
                        })
                        .collect::<Vec<_>>()
                        .join("；")
                )
            },
        },
    ];

    let has_key = std::env::var("DEEPSEEK_API_KEY").is_ok() || key_file.exists();
    let ok = checks.iter().all(|c| c.ok);

    ProbeReport {
        root: root.display().to_string(),
        counts: Counts {
            skills: dir_count(&skills),
            prompts: prompt_total,
            mcp_libs: dir_count(&mcp_libs),
        },
        // 体积**一律走缓存**（TTL 120s 自动失效）。
        //
        // 曾经让 deep 强制重算，结果用户每点一次「自检」就要重走
        // runtime/_assets/.codex 三棵树（实测 3.7~5.2s）—— 把「点一下
        // 看看状态」变成了一次可感知的卡等，没必要：体积本来就不会
        // 因为用户点了一下而变。deep 只多跑 --version 子进程（~100ms）。
        runtime_mb: runtime_size_mb(&root, false),
        has_key,
        codex_version,
        adb_version,
        python_version,
        checks,
        ok,
        prompt_sources,
        config_provider,
        host_config_exists,
        host_config_path,
    }
}

// ---------- 进程管理 ----------
//
// 设计（2026-09-20 修「停不掉」）：
//   Windows 上 Electron / cmd 包装器再 fork 出 7+ 个后代，「记一个 PID + taskkill /T」
//   必然漏杀：后代一旦 re-parent 就逃出进程树，主程序崩溃时更没人收尾。三层保险：
//     ① Job Object（KILL_ON_JOB_CLOSE）：句柄一关，内核直接杀光 job 内所有进程；
//     ② 快照按 pid/ppid 自建父子图，自底向上 TerminateProcess（job 分配失败时兜底）；
//     ③ 归属清扫：镜像路径落在包根下的进程全清，收拾历史孤儿。
//   槽位用 Vec：允许 CLI + 桌面端同时开，停止时全部收割。

#[derive(Default)]
pub struct ProcSlot {
    /// 直接子进程（持有句柄才能 try_wait / kill）
    pub child: Option<Child>,
    /// 内核级容器：句柄关闭即杀光
    pub job: Option<winproc::Job>,
    /// 启动模式（cli / exec / desktop），用于日志
    pub mode: String,
    /// exec 模式的任务内容（自动重建时原样重放）
    pub exec_task: Option<String>,
    /// 树根 PID：子进程句柄失效后仍可用它自查残留
    pub pid: u32,
    /// 本次启动用的随机别名文件（进程镜像名就是它的文件名）
    ///
    /// 为什么是 Vec：桌面端会拉起**两份** exe（主程序 + 内嵌 CLI），
    /// 两份都建了别名，停止时要一起删掉，否则 `wzXXXXXXXX.exe` 会堆在目录里。
    pub aliases: Vec<alias::AliasFile>,
    /// 别名对应的随机名（界面展示 / 状态回报用）
    pub alias_stem: String,
}

impl ProcSlot {
    /// 是否还活着
    ///
    /// CLI 模式走 raw CreateProcessW（拿不到 Rust `Child` 句柄），
    /// 所以不能只看 `child`；那种情况退回 pid 快照判定。
    fn is_alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            // 无 Child 句柄 = CLI 模式：按 pid 查进程快照
            None => self.pid > 4 && winproc::pid_exists_external(self.pid),
        }
    }

    /// 终止这一槽位：先 Job（内核级），再按 PID 树，最后收句柄
    ///
    /// 注意：`kill_tree` 用的是 OpenProcess(PROCESS_TERMINATE)，
    /// 对**已上锁**的进程会被 DACL 拒绝 —— 那是预期行为，真正的终止
    /// 走预留句柄（在 `codex_stop` 里由 AliasGuards 统一执行）。
    fn kill(&mut self) {
        if let Some(job) = self.job.as_ref() {
            winproc::terminate_job(job);
        }
        winproc::kill_tree(self.pid);
        if let Some(c) = self.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(job) = self.job.take() {
            winproc::close_job(job);
        }
        // 收尾：删掉本次的随机别名链接（硬链接，删链接不影响真身）
        for a in self.aliases.drain(..) {
            a.remove();
        }
        self.child = None;
    }}

/// 运行体实例表：一次可同时存在多个（CLI 控制台 + 桌面端）
#[derive(Default)]
pub struct CodexProc(pub Mutex<Vec<ProcSlot>>);

impl CodexProc {
    /// 锁中毒（持锁线程 panic）时也继续用，避免一次异常让停止功能永久失效
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<ProcSlot>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn push(&self, slot: ProcSlot) {
        self.lock().push(slot);
    }

    /// 取出全部槽位（停止时用）
    fn drain(&self) -> Vec<ProcSlot> {
        std::mem::take(&mut *self.lock())
    }

    /// 该 pid 的槽位若已退出就移除，并回收别名 / Job / 注册表；返回「是否还活着」
    ///
    /// 关键：**自然退出**（用户自己关掉 CLI 窗口、codex 跑完）也必须走这里清理，
    /// 否则随机别名文件会永远堆在运行体目录里（实测过：`wz5wujfw9m.exe` 残留
    /// 298MB 的链接）。清理点有三处：CLI 窗口关闭、exec 跑完、桌面端退出。
    fn reap(&self, pid: u32, codex_home: &Path) -> bool {
        let mut v = self.lock();
        let Some(pos) = v.iter().position(|s| s.pid == pid) else {
            return false;
        };
        let alive = v[pos].is_alive();
        if !alive {
            let mut s = v.remove(pos);
            if let Some(job) = s.job.take() {
                winproc::close_job(job);
            }
            // 删别名链接 + 注销注册表记录
            for a in s.aliases.drain(..) {
                alias::unregister(codex_home, &a.path);
                a.remove();
            }
        }
        alive
    }

    /// 当前跟踪中的树根 PID
    fn tracked_pids(&self) -> Vec<u32> {
        self.lock().iter().map(|s| s.pid).collect()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub ok: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
    /// 关联的后代 PID（用于停止/状态回执）
    #[serde(default)]
    pub pids: Vec<u32>,
    /// 运行体实例个数
    #[serde(default)]
    pub count: usize,
    /// 本实例的随机镜像名（如 `wz7f3a91c2`）
    #[serde(default)]
    pub alias_name: String,
    /// 是否已开启独占终止保护（外部杀不掉，只有本程序能停）
    #[serde(default)]
    pub protected: bool,
}

impl LaunchResult {
    fn ok(pid: Option<u32>) -> Self {
        Self {
            ok: true,
            pid,
            error: None,
            pids: Vec::new(),
            count: 0,
            alias_name: String::new(),
            protected: false,
        }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            pid: None,
            error: Some(msg.into()),
            pids: Vec::new(),
            count: 0,
            alias_name: String::new(),
            protected: false,
        }
    }
}

fn emit_log(app: &AppHandle, text: impl Into<String>, kind: &str) {
    let _ = app.emit("runtime:log", (text.into(), kind.to_string()));
}

/// 给真实 exe 建随机名别名；建不出来就退回原名
///
/// 返回 (要启动的路径, 别名)。别名失败不影响功能，只是镜像名不随机。
fn prepare_alias(real: &Path) -> (PathBuf, Option<alias::AliasFile>) {
    match alias::make_alias(real) {
        Some(a) => (a.path.clone(), Some(a)),
        None => (real.to_path_buf(), None),
    }
}

/// MCP 命令按 cwd 解析，运行时注入绝对路径
fn apply_mcp_overrides(cmd: &mut Command, codex_home: &Path) {
    let mcp = |name: &str| codex_home.join("mcp").join(name).display().to_string();
    for (k, v) in [
        ("wangzha", mcp("run-wangzha-mcp.cmd")),
        ("ue4dump-mcp", mcp("run-ue4dump-mcp.cmd")),
    ] {
        cmd.args(["-c", &format!("mcp_servers.{k}.command={v}")]);
        /*
         * 免审批必须在这里显式传。
         *
         * 为什么：`-c mcp_servers.<k>.command=...` 只覆盖 command 字段，
         * MCP 的**工具审核模式会回落到默认值**（= 要用户点确认）。
         * 配置文件里写了 `default_tools_approval_mode = "auto"` 也没用 ——
         * 命令行覆盖会让该 server 的整段配置以命令行这份为准。
         * 结果就是用户看到的「agent 老是弹审核」，而审批策略是 never，
         * 弹出来也没人点得到 → 工具直接废掉。
         *
         * 所以这三个键必须跟着 command 一起传：
         *   default_tools_approval_mode = auto  全部工具不弹审核
         *   destructive_enabled / open_world_enabled = true  放行写类与联网类工具
         */
        cmd.args([
            "-c",
            &format!("mcp_servers.{k}.default_tools_approval_mode=\"auto\""),
        ]);
        cmd.args(["-c", &format!("mcp_servers.{k}.destructive_enabled=true")]);
        cmd.args(["-c", &format!("mcp_servers.{k}.open_world_enabled=true")]);
    }
}

/// 三种模式共用的收尾：入 Job → 登记槽位 → 盯守 → 回执
///
/// ⚠️ 独占终止保护（DACL 收紧）已**移除**（2026-09-20 用户要求）。
///
/// 移除原因与遗留事项：
///   · 上锁后连用户手动 taskkill / 任务管理器都杀不掉，一旦本程序出问题
///     用户没有自救手段，属于「过度保护」；用户明确要求去掉。
///   · 现在进程**可以被外部终止**（普通 taskkill 生效），这是预期行为。
///   · Job Object **保留** —— 它只做「alice 退出时回收子树」，不限制外部终止，
///     且是崩溃后不留孤儿的关键兵底。
///   · `guards` 的 epoch/drop_pid 机制**保留**：它们与上锁无关，
///     承担「停止流程接管时让 watcher 收手」的职责，删掉会引入停止竞态。
///   · `guards` 永远为空 ⇒ `terminate_all()` 自然退化为空操作，
///     停止路径无需改动即可正常工作。
#[allow(clippy::too_many_arguments)]
fn finish_launch(
    app: &AppHandle,
    state: &State<'_, CodexProc>,
    child: Option<Child>,
    pid: u32,
    job: Option<winproc::Job>,
    alias_file: Option<alias::AliasFile>,
    alias_stem: String,
    mode: &str,
    codex_home: &Path,
    exec_task: Option<String>,
) -> LaunchResult {
    // ① Job 绑定（只做退出回收，不限制外部终止）
    if let Some(j) = job.as_ref() {
        if !winproc::assign_pid(j, pid) {
            emit_log(app, "Job Object 绑定失败（只影响退出回收，不影响启动）", "warn");
        }
    }

    if let Some(a) = alias_file.as_ref() {
        alias::register(codex_home, pid, &a.path);
    }

    let aliases: Vec<alias::AliasFile> = alias_file.into_iter().collect();
    state.push(ProcSlot {
        child,
        job,
        mode: mode.into(),
        exec_task,
        pid,
        aliases,
        alias_stem: alias_stem.clone(),
    });

    let _ = app.emit("runtime:status", "running");
    emit_log(
        app,
        format!("{mode} 已启动 (PID {pid}) · 镜像名 {alias_stem}"),
        "ok",
    );

    watch_child(app.clone(), pid, codex_home.to_path_buf());
    let mut r = LaunchResult::ok(Some(pid));
    r.count = state.tracked_pids().len();
    r.alias_name = alias_stem;
    // 独占保护已移除：恒为 false（保留字段仅为兼容前端 DTO）
    r.protected = false;
    r
}

/// 归属清扫：把镜像落在包根下的残留进程清掉（返回「杀掉 / 仍在」）
fn sweep_root(app: &AppHandle, root: &Path) -> (Vec<u32>, Vec<u32>) {
    let root_s = root.display().to_string();
    let (killed, remaining) = winproc::sweep_root(&root_s);
    if !killed.is_empty() {
        emit_log(app, format!("已清理包内残留进程：{killed:?}"), "warn");
    }
    (killed, remaining)
}

/// 启动后盯守：退出即回收槽位、撤保护句柄、删别名，并广播 idle
///
/// 覆盖 cli / exec / desktop 三种模式。
///
/// 为什么要记世代号（epoch）：
///   用户点「停止」时会 bump 世代，本线程下一轮醒来发现世代变了就立刻退出，
///   不再去碰正在退出的进程 —— 否则它可能在停止流程之后又把残留锁上。
///
/// 为什么**不做**自动重建（老板 2026-09-20 决定）：
///   进程一旦被外部杀掉就到此为止，不换名重启。守护式重建会让「停止」
///   变成不确定行为，也属于猫鼠游戏；要的是「随机名 + 非提权杀不掉 +
///   点停止一定能停」这三条确定行为。
fn watch_child(app: AppHandle, pid: u32, codex_home: PathBuf) {
    let guards = app.state::<alias::AliasGuards>();
    let my_epoch = guards.epoch();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let guards = app.state::<alias::AliasGuards>();
        if guards.epoch() != my_epoch {
            // 停止流程已接管，本线程收手
            return;
        }
        let st = app.state::<CodexProc>();
        if !st.reap(pid, &codex_home) {
            // 槽位被移除 = 进程已退出：撤掉保护句柄、删别名（reap 里已做）
            guards.drop_pid(pid);
            emit_log(
                &app,
                format!("运行体已退出（PID {pid}），槽位与别名已回收"),
                "ok",
            );
            let _ = app.emit("runtime:status", "idle");
            return;
        }
    });
}

#[tauri::command]
pub fn codex_launch(
    app: AppHandle,
    mode: String,
    exec_task: Option<String>,
    state: State<'_, CodexProc>,
) -> LaunchResult {
    launch_impl(&app, &mode, exec_task, &state)
}

// ============================================================
// Agent 助手会话（05 会话页专用，2026-09-22 重做）
// ------------------------------------------------------------
// 设计契约（全部经 codex-cli 0.154.0 隔离 CODEX_HOME + 本地 stub 端点实测）：
//   · 技能根只有 $CODEX_HOME/skills；codex 会自动补 .system/ 6 技能。
//     skills.config=[{name="X",enabled=false}] 按 **frontmatter name** 禁用，
//     这是把可用技能收敛到「本会话唯一一个」的唯一手段。
//   · model_instructions_file 接受绝对路径，完全决定请求体 instructions。
//   · $CODEX_HOME/AGENTS.md 会无条件注入（与 cwd 无关，project_doc_max_bytes
//     抑制无效）—— 所以 agent 会话必须用独立 CODEX_HOME 且绝不写 AGENTS.md。
//   · experimental_bearer_token="PROXY_MANAGED" 时不发 Authorization、无需 auth.json。
//   · 首轮 stdout 有 "session id: <uuid>"；exec resume <uuid> 携带完整前序对话。
// ============================================================

/// Agent 会话专用 CODEX_HOME（相对运行体根）。里面绝不放 AGENTS.md。
const AGENT_HOME: &str = "_assets/agent/_home";
/// 会话存储根（相对运行体根），即 resources/_assets/agent/<会话名>/。
const AGENT_SESSIONS: &str = "_assets/agent";
/// 内置 .system 技能名（codex 自动补齐的那 6 个），禁用清单必须覆盖它们。
const AGENT_SYSTEM_SKILLS: [&str; 6] = [
    "imagegen",
    "openai-docs",
    "plugin-creator",
    "review-agent",
    "skill-creator",
    "skill-installer",
];

/// Agent 会话唯一允许使用的技能名（固定，不可导入/替换）。
const AGENT_SKILL_NAME: &str = "alice_agent-skill";

/// 内置技能正文。`{{SELFCHECK}}` 由前端「写入技能」替换为体检快照。
///
/// 三段职责：① 工作范围硬约束（只在应用文件夹内、不改代码、只增删改配置文件）；
///          ② ALICE 助手完整功能结构与用法（让 agent 不必每次现读源码，省 token）；
///          ③ 工具箱自检清单 + 体检快照。
const AGENT_SKILL_TEMPLATE: &str = r#"---
name: alice_agent-skill
description: ALICE 助手的内置技能。限定工作范围在本应用文件夹内、不改代码、只增删改配置文件；内置本应用完整功能结构与用法，负责工具箱自检。
---

# alice_agent-skill

## 〇、三层联动（先看这张图，理清结构）

你的工作信息分三层，**各管各的，不要混**：

```
第 1 层 · 职责  →  会话提示词 prompt.md 顶部
                   你干什么活、怎么说话、关键词怎么回
                   （本技能只放一段简版提醒，防你读完技能变成死板腔）

第 2 层 · 规矩  →  本技能（你正在读的这份）
                   工作范围 / 读取预算 / 写入流程 / 工具免审批 /
                   应用结构（角色名版）/ 自检清单

第 3 层 · 数据  →  提示词末尾的「文件路由清单（本机）」
                   角色 → 真实路径（含是否存在）、体检结论、
                   技能库包清单、客户端工作路径、预设组清单
```

**联动规则（重要）**：

- 本技能里的路径**全是角色名**（「技能库根」「主配置」…），**不是真实路径**。
  要用路径时，去第 3 层清单查同名角色那一行。
- 第 3 层由宿主在**每次发言前**重建 —— 用户改了配置、跑完自检，
  清单就跟着变。所以「现在什么状态」永远看清单，别背下来。
- 为什么这么分：本技能要能移植到**任何一台电脑**（盘符、用户名、包位置都不同），
  所以技能不写死路径；职责与语气放提示词；每机不同的数据放清单。

### 语气提醒（简版，完整版在提示词里）

**你是爱丽丝**，这个工具箱的助手，服务用户：帮用户解决问题、执行操作、照看工具箱。

说话：短句、口语、轻快自然。「（笑）」让语气变轻，颜文字一条最多一个。
禁客服腔、禁"还有什么可以帮到你吗"、禁结尾总结句。
报体检结果/给清单时该用表格就用，但开头一句短的、结尾用你自己的话收。

> **读完本技能不要变成死板腔。** 技能是规矩，语气保持轻快自然。

## 一、读文件的预算（最重要的一条）

**你可以读文件** —— 但要**省着用**。这一条最重要：

- **默认零工具调用**。先读提示词末尾的「文件路由清单」，能答就直接答。
  清单里已经有：**角色 → 真实路径对照表**（含是否存在）、体检结论、
  每个客户端的工作路径、每个预设组的提示词与技能包、技能库/提示词库规模。
- **清单里的数字和路径就是权威，不要再去核对一遍**。用户问「技能库根在哪」
  → 直接答清单里那一行的路径，**不要**为了"确认"去 `Get-ChildItem` 数一遍。
  问「有多少技能包」→ 清单里「技能库根」那行已经给了；清单没有的项才去读。
- **清单答不了，最多再花 3 次工具调用**。超过就停，直接说"这项查不到"或
  问用户。实测有三次因为连着查了 20~70 多次，把上下文塞满，
  最后连回答都发不出来 —— 那是比"查得不够"严重得多的失败。
- **只读你真正需要的那一个文件**，并且**用清单里给的真实路径**（技能正文里
  的路径都是角色名，不能直接当路径用）。
- **禁止**：`-Recurse` 全盘扫、一次读几十个文件、把大文件整份贴出来、
  为了"确认一下"重复读同一个文件、为验证清单而重新读文件。

判断标准：**第 3 次调用还没答上来，就停下来问用户**，别继续翻。

- **写文件走围栏块**：任何写文件的请求都按第四节走 `alice-propose`，
  不要自己直接写 —— 宿主会落盘 + 自动备份，你直接写就没有备份了。

## 二、工具免审批（直接用，别请示）

你手上的工具**全部免审批**，直接调就行：

- **读文件 / 列目录 / 跑命令**：主配置里已给 MCP server 配了
  `default_tools_approval_mode = "auto"`，不会弹审批。
- **上网**：`fetch_url` 也是 `auto`；shell 的 `curl` / `Invoke-WebRequest` 同样可用。
- 用户让你查网上的东西（热搜、文档、版本号）就直接查完再汇报结果。

**注意**：审批策略是 `never` —— 万一某个工具仍被拦（返回 approval required），
**不要反复重试**，换一条不受限的路径（`fetch_url` / `curl` / 直接读文件），
或者告诉用户"这个工具被拦了，我换个方式"。

## 三、工作范围（硬约束，无例外）

你的活动范围**仅限 ALICE 助手自己的文件夹**（下文记为 `<包根>`，即 `新alice助手.exe`
所在的 `resources/` 那一层）。文件夹之外的文件、目录、系统设置一律不碰。

**允许**：

- 读 `<包根>` 内的任何文件。
- **增删改配置文件**：主配置、API Key、MCP 脚本下的配置、
  各客户端的 `manifest.json`、会话的 `prompt.md` 等一切**配置文件**
  （真实路径查路由清单，别用记忆里的路径）。
- 新建配置文件、删除多余或损坏的配置文件。
- 诊断并解释工具箱状态，指出失败项，给出下一步可复现命令。
- 解答用户关于本应用怎么用、某项配置为什么这样设、报错怎么处理的问题。

**禁止**：

- **不许改动任何代码**：不改 `.rs` / `.ts` / `.tsx` / `.js` / `.py` / `.cmd` / `.ps1` / `.exe`，
  不重新编译、不打补丁、不替换可执行文件。
- 不许动 `<包根>` 之外的任何路径。
- 不许执行与本应用配置无关的命令（不装依赖、不改系统环境、不碰注册表）。
- 不承接与本工具箱无关的编程或分析任务。

遇到越界请求，直接说明「我只负责 ALICE 助手的配置与用法，不改代码、不出本文件夹」，
把话题拉回配置或自检。需要改代码才能解决的问题：**只报告，不动手**。

## 四、写入流程（用户让你做，就直接做完）

用户说「帮我改」「帮我操作」「你处理一下」这类话 —— **直接把活干完**，
不要反问确认、不要问「你确定吗」。他要的就是结果。

流程：

1. **先说要做什么**（一句话）：比如"好，我把 config.toml 里的模型名改成 xxx"。
2. **直接输出 `alice-propose` 围栏块**（格式见下）。宿主会立刻落盘，
   用户不需要额外点确认。
3. **每改完一步就报一句进度**："config.toml 改好了 → 接着看 skills 目录"。
   别闷头做完一堆再一次性说。
4. **全部做完给总结**：改了哪些文件、每个文件改了什么、怎么验证、有没有残留问题。
   用爱丽丝的语气收尾（邀功/吐槽都行）。

### 常见任务 → 去哪一节

| 用户说 | 照哪一节做 |
|---|---|
| 「客户端装错位置了 / 换到别的盘 / 改客户端路径」 | **3.4 改客户端工作路径** |
| 「加个客户端 / 加个预设组」 | 3.3 怎么加客户端 |
| 「改注入位置 / 改技能落点」 | 3.5 manifest.json 字段 |
| 「装了没生效 / 卸载还原」 | 3.6 注入引擎行为 |

### 实时汇报（硬要求）

不管在干活还是排查，**每完成一步就说一句**，让用户随时知道你在干嘛：

- 开头：「好，我先看 config.toml」/「我先跑个体检」
- 中间：「config 没问题，接着看客户端路径」/「找到一个：pi 没配路径」
- 结束：「查完了，一个毛病」/「改完了，两处，都备份了」

不要沉默着连做五步再一次性汇报 —— 用户要看到进度。
也不要为了汇报而汇报（别把每个命令都念一遍），
按「一个可理解的阶段」为单位报。

例外：只有当用户**没明确让你改**、而你自己觉得"这里应该改一下"时，
才需要先问一句「要不要我改？」。用户明确让你动手时不要问。

### 网络访问（免审批，直接用）

你要上网（搜索、抓网页）时**直接调**，不用请示：

- 抓网页用 MCP 工具 `fetch_url` —— 它在主配置里已配
  `approval_mode = "auto"`，不会弹审批。
- shell 里的 `curl` / `Invoke-WebRequest` 也能用（沙箱已放开）。
- 审批策略是 `never`：凡是弹审批的工具一律会被静默拒绝，**不要反复重试
  被拒的调用**。换一个不受审批限制的路径（`fetch_url` / `curl`）。
- 用户让你查网上的东西（热搜、文档、版本号）就直接查完再汇报结果。

### `alice-propose` 围栏块格式

````
```alice-propose
path: <包根>的绝对路径\.codex\config.toml
reason: 把模型名从 A 改成 B，因为……
---
<新文件的完整内容>
```
````

- `path` 必须是**绝对路径**，且在 ALICE 助手文件夹内；`.rs/.ts/.py/.cmd/.ps1/.exe` 等代码文件会被拒收。
- `---` 之后是**整个文件的新内容**（不是补丁、不是 diff）。
- 一段回复里可以有多个围栏块（一次改多个文件）。
- 围栏块会从用户看到的正文里剔除，所以你**必须**在正文里另外用中文说清改了什么、为什么。

## 五、应用结构（角色名版 · 对应第 3 层清单）

> 本节讲**结构关系**（谁在哪、谁引用谁），路径一律用**角色名**。
> 要真实路径就去第 3 层「文件路由清单」查同名角色那一行 ——
> 这就是「技能通用 + 清单每机独立」的联动方式，技能因此能移植到任何电脑。

### 3.1 顶层布局（角色名版）

```
包根/                        ← 运行体根（= 路由清单里的「包根」）
├── 配置目录/                 ← 便携 CODEX_HOME
│   ├── 主配置                ← 模型 / 供应商 / MCP / 提示词指向
│   ├── API Key               ← 备用密钥文件
│   ├── 便携箱提示词           ← Alice-codex 页用的提示词
│   ├── 便携箱技能             ← 便携箱已装技能
│   └── MCP 脚本 / MCP 依赖库   ← MCP 启动脚本与依赖
├── 预设组清单/               ← 客户端 → 预设组（每客户端一目录）
│   ├── 客户端配置            ← <客户端>/<客户端>.json：工作路径的权威记录
│   ├── <客户端>/<版本>/manifest.json  ← 预设组（注入位置、技能组）
│   └── 客户端顺序            ← 左栏排序
├── 素材库/                   ← 对应路由清单里的这几个角色：
│   ├── 技能库根               ← 技能包（一级子目录 = 一个包）
│   ├── 提示词库根             ← 提示词主来源
│   ├── Astra 提示词 / DSH 提示词
│   ├── 第三方素材             ← 云记忆等，由 manifest 引用
│   └── Agent 会话 / Agent home
├── 内置工具/                 ← adb 等
├── codex 运行时/             ← codex 与桌面端
├── 工作目录/                 ← 命令默认 cwd
└── 运行数据/                 ← 私有 APPDATA / TEMP（可删，自动重建）
```

### 3.2 九个页面

| 页 | 作用 |
|---|---|
| 01 总览 | 统计与快捷入口（纯展示） |
| 02 目标 | **核心页**：左栏客户端、中栏预设组清单+安装面板、右栏注入位置状态 |
| 03 技能库 | 技能包新建/重命名/删除、逐技能勾选、文件夹与 zip 导入、编辑 SKILL.md |
| 04 提示词 | 多来源提示词扫描、添加、编辑、删除 |
| 05 会话 | Agent 助手（本技能所在处） |
| 06 Alice-codex | 运行体检、启动 CLI/桌面端、停止、透传本机配置、便携箱提示词与技能 |
| 08 云过审 | 本地中转服务端：上游配置、过审开关、规则表、客户端接入/还原 |
| 个人中心 | 主题切换与只读状态（右上角电源按钮进入） |

### 3.3 怎么加客户端

目标页左栏最下方「添加客户端」→ 填**客户端名**（= 预设组清单下的一个目录名）与
**工作路径**（如 `~/.codex`，可留空则按 `~/.<客户端名>` 推断）→ 创建。
磁盘立刻出现（路径见路由清单「预设组清单」+ 客户端名）：

```
<预设组清单>/<客户端名>/<客户端名>.json   ← 客户端配置（工作路径权威记录）
<预设组清单>/<客户端名>/v1/manifest.json  ← 默认预设组
```

该默认预设组内容：`id=<名>-v1`、`injectTargets=[{path:"<工作路径>/AGENTS.md"}]`、
`skillSync=[{dest:"<工作路径>/skills"}]`、`moduleSync="<工作路径>/skills/_modules"`。

客户端名限制：非空、不含 `/ \ : * ? " < > |`、不以 `_` 开头。
左栏「注入状态」读的是 `<配置目录>/state-<客户端>.json` 里的 `versionId`/`versionLabel`。

改已有客户端的工作路径见 **3.4**（界面上是左栏那行的**铅笔按钮**）。

### 3.4 改客户端工作路径（用户说「客户端装错位置了」就照这个改）

工作路径的**权威记录**是客户端配置文件：

```
<预设组清单>/<客户端名>/<客户端名>.json
```

内容（字段名 camelCase）：

```json
{
  "id": "codex",
  "label": "Codex 破甲",
  "workDir": "C:\\Users\\<你>\\.codex",
  "notes": ""
}
```

**最简改法（推荐）**：直接改这个 json 的 `workDir` —— 界面上「客户端 → 工作路径」
那一列、体检、以及后续安装的默认落点都以它为准。改完点会话页的「刷新快照」，
路由清单会同步。

**但落点也要跟着改**：预设组 manifest 里的落点是**另一份副本**，
安装时用的是 manifest 的值，不是客户端配置的值。所以只改 `workDir` 会出现
「界面显示新路径、装到旧目录」的不一致。两边要一起改：

1. **改客户端配置**：`<客户端名>/<客户端名>.json` 的 `workDir`。
2. **改该客户端每个预设组**（`<客户端名>/v1/`、`v2/`、`pro/`… 全部目录）的 manifest：
   - `injectTargets[].path`（`mode:"dir"` 的第三方条目**跳过**）
   - `skillSync[].dest`
   - `moduleSync`
3. **两种路径形态都要认**：`~/.codex/AGENTS.md`（tilde）与
   `C:\Users\<你>\.codex\AGENTS.md`（展开）—— 同一客户端的不同预设组可能混用
   （实测 codex 就是混的），**只改一种会漏**。
4. **拼新路径**：保留旧路径中「工作目录之后」的子路径。例如
   `~/.codex/skills/_modules` + 新目录 `D:\portable\codex`
   → `D:\portable\codex\skills\_modules`。
5. 每个文件一个 `alice-propose` 围栏块（整份文件的新内容），
   正文报进度：「codex 的客户端配置 + 7 个预设组都指到新路径了」。

**不要做的事**：

- **不要**去 `Move-Item` / `Copy-Item` 搬已注入的文件。改的是**配置声明**；
  已注入的内容要迁移，让用户改完路径后重新安装一次预设组。
- **不要**改 `mode:"dir"` 的第三方条目（用户自选的外部目录，与工作路径无关）。
- **不要**只改第一个预设组 —— 漏掉的那些下次安装会写回旧路径。

**界面等价操作（更省事）**：目标页左栏客户端行的**铅笔按钮**会一次做完上面两步
（写客户端配置 + 同步全部 manifest 落点，后端 `client_config_save`）。
用户自己在界面上点最快；你走配置文件改写适用于用户让你直接处理、
或要改的客户端在界面上没列出来（`_` 前缀目录）等情况。

### 3.5 manifest.json 字段（写配置文件时按此对照）

顶层（camelCase，无 `deny_unknown_fields`，未知字段被静默忽略）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `id` | String | 版本唯一标识 |
| `client` | String | 归属客户端目录名；空则落 `_custom` |
| `label` | String | 显示名（也是模板变量 `{{CHANNEL_LABEL}}`） |
| `desc` | String | 描述 |
| `recommended` | bool | 只读字段，保存时**不会**再写回 |
| `activationWord` | String? | 激活词，仅回传给界面提示 |
| `prompts` | Array | 提示词组，**唯一权威**；每项 `{name, asset?, file?, path?}` |
| `prompt` | Object? | 老字段兜底，只读不写回 |
| `skillPacks` | String[] | 技能组（技能库根下的包名），**唯一权威** |
| `skills` | Object? | 老字段兜底，只读不写回 |
| `injectTargets` | Array | 注入点（提示词落点 + `mode:"dir"` 第三方条目混放） |
| `skillSync` | Array | 技能落点，每项 `{dest}` |
| `moduleSync` | String? | 仅用于展开模板变量 `{{MODULES_ROOT}}`，不参与复制 |

`prompts[]` 三种来源写法与解析优先级：
1. `asset` —— 相对素材库（先试 `素材库/<asset>`，再试 `提示词库根/<asset>`）
2. `file` —— 相对**版本目录**
3. `path` —— 绝对路径

`injectTargets[]` 字段：

| 字段 | 作用 |
|---|---|
| `path` | **必填**，落点。支持 `~`（= `%USERPROFILE%`）、`{{HOME}}`、`{{RUNTIME}}`；`/` 自动转 `\` |
| `mode` | **只有 `"dir"` 有意义** —— 标识「第三方文件夹对」。其余值（`markedBlock`/`claudeBlock`/`overwrite`/`file`）一律被忽略 |
| `beginKey` / `endKey` / `beginPayload` / `marker` / `frontmatter` | 参与「是否本工具的产物」判定与正文拼装 |
| `sourceDir` | `mode:"dir"` 时的**源**（文件或目录，相对素材库） |
| `kind` | 第三方源类型：`file` / `dir` / `auto`（缺省 auto 按实际类型判断） |
| `label` | 第三方条目备注（界面显示） |
| `readonly` | 放置后设只读，防客户端篡改 |
| `backupSuffix` / `fixedBackup` / `stampTag` / `fileName` | 解析但不消费（历史遗留） |

**重要**：`mode` 已不再是写入语义开关。当前安装一律「原文件改名为 `<path>-bak` +
新的整份放进去」，对所有提示词落点一视同仁。所以**不要**试图靠 `mode` 区分写入方式。

### 3.6 注入引擎行为（安装 / 卸载）

安装顺序固定为 **提示词 → 技能 → 第三方**：

1. **提示词**：目标不存在 → 直接写；已是本工具产物（正文含 `MANAGED_BY_TAG`）→ 直接覆盖；
   `<目标>-bak` 已存在 → 保留旧备份不动；否则把原文件 **rename 成 `<目标>-bak`** 再写新的。
   写出的内容是 `署名行 + 可选 frontmatter + 正文`，UTF-8 **无 BOM**。
2. **技能**：原技能目录整体 rename 成 `<目录名>-bak`；只复制含 `SKILL.md` 的一级子目录；
   `_modules` 随技能包一起复制。**一个技能源都没有时绝不动落点目录**（安全闸）。
3. **第三方**：文件型放到 `dest`（`dest` 带扩展名 = 指定文件名，否则 `dest/<源文件名>`）；
   目录型**覆盖式合并**（不清空落点已有内容）。`readonly` 时递归设只读。

完成后写 `<配置目录>/state-<客户端>.json`，记录 `injectedFiles`（含字节数）、`skillDirs`、
`installedSkills`、`installedModules`、`thirdPartyPlaced`。

卸载：按状态记录逐个还原。提示词文件会**按字节数比对** —— 用户手动改过的文件
（字节数不符）**保留不动**并记失败原因；技能只删记录过的名字；第三方只删自己放过的顶层条目。

**备份命名规则（最容易记错，照抄）**：

| 场景 | 备份名 |
|---|---|
| 注入接管原文件/原目录 | `<名>-bak` |
| 导入素材重名 | `<name>.bak-<时间戳>` |
| 编辑器保存 | `<文件名>.bak-edit-<时间戳>`（保留最近 3 份） |
| 云过审接入客户端 | `<名>.alice-bak-<时间戳>` |
| 便携箱提示词注入 | `config.toml.bak-instr-<时间戳>` |
| 透传本机配置 | `config.toml.bak-<时间戳>` |

### 3.7 素材库扫描根

- 技能包：`<技能库根>/<包名>/skills/<技能>/SKILL.md`（技能判定 = 一级子目录含 `SKILL.md`）。
  兼容旧布局 `<素材库>/<包名>/materials/skills` 与 `<素材库>/<包名>`。
- 提示词：`<提示词库根>`（提示词页只扫这里这一处）。
- 第三方素材：`<第三方素材>`，由 manifest 的 `mode:"dir"` 条目引用。

> 上面每个 `<…>` 都是角色名，真实路径查路由清单。

### 3.8 Alice-codex 页各按钮

| 按钮 | 作用 |
|---|---|
| 一键自检 | 跑体检（含 codex/adb/python 版本），强制重算体积 |
| 透传本机 | 把本机 codex 配置的 6 个模型/供应商键搬进包内（值逐字照抄，包内 MCP 段保留） |
| 提示词「注入」 | 改写主配置的 `model_instructions_file` 指向 `<便携箱提示词>/<名>` |
| 启动 CLI / 桌面端 | 拉起便携 codex（随机镜像名） |
| 停止 / 强制清理 | 停当前实例 / 包内归属清扫 |
| 换随机名重启 | 先停再用全新随机镜像名拉起 |

### 3.9 本会话（Agent 助手）自身机制

- 会话存 `<Agent 会话>/<会话名>/`：`prompt.md`（独立提示词）、`skills/alice_agent-skill/`、
  `messages.json`（对话记录）、`session_id.txt`（codex 会话 id）、`applied/`（已写入留档）。
- 会话专用 `CODEX_HOME` = `<Agent home>`（**不含 AGENTS.md**，保证提示词独立于便携箱）。
- 模型/供应商取自包内主配置，每次启动同步。
- 首轮 `codex exec`，之后 `codex exec resume <session_id>` 续聊。
- 你唯一的技能就是本技能（其它技能被 `skills.config` 全部禁用）。
- 运行在完整沙箱里（能读能跑命令），边界靠本技能的硬规矩约束：
  只读定向文件、只改配置文件、只在应用文件夹内、写文件走 `alice-propose` 围栏块。

## 六、自检要求

> 数据优先级：**快照**（见提示词末尾，宿主每次发言前重写）> **定向读文件** > 问用户。
> 读文件按「第一节」的规矩来：点名读、别全量扫。

用户说「自检」「体检」「检查工具箱配置」，或报告工具箱异常时，按下面清单逐项核对：

1. **运行体完整性**：主配置是否存在、provider 字段是否正常。
2. **codex 运行时**：包内 codex.exe 是否存在、版本可读。
3. **桌面端**：包内桌面端组件是否齐备。
4. **技能库**：技能库根下的包数与技能数。
5. **提示词库**：各来源份数、当前生效的那一份（看 `model_instructions_file`）。
6. **MCP 依赖**：MCP 依赖库是否齐备。
7. **内置工具**：内置工具目录下 adb 等是否在位。
8. **目标客户端路径**：**每个客户端的工作路径是否存在**（路由清单「客户端 → 工作路径」表已列全）。
   路径不存在 = 该客户端的注入点指向不存在的目录，安装必然失败或装到错地方。
   报告时逐个列出「客户端名 → 路径 → 存在/不存在」。
9. **模型端点**：主配置里 `base_url` 指向的地址是否可达
   （不可达时说明这是端点问题，不是工具箱缺件）。

体检项 1/2/4~8 在快照里都有现成结论，直接引用；第 9 项（端点连通性）快照里没有，
可以定向跑一条 `Test-NetConnection` 或 `curl` 验证。

输出格式固定三块：

- **通过项**：列出 ok 的项。
- **失败项**：现象 + 为什么算失败。
- **下一步**：每项失败给一条可直接运行的命令或明确的界面操作；需要改配置时按第四节输出 `alice-propose` 块。

**禁止编造体检结果**。快照和定向读都没有的项就明说「未检查」，不要假装查过。

## 七、文件路由清单

（宿主会在你发言前自动填入**本机**的路由清单：角色 → 真实路径、体检结论、
客户端工作路径、预设组清单。技能正文里的路径都是角色名，真实路径看这里。）

{{SELFCHECK}}
"#;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub name: String,
    pub dir: String,
    pub prompt_path: String,
    /// 本会话挂载的技能 frontmatter name（未挂载为 None）
    pub skill_name: Option<String>,
    pub skill_path: Option<String>,
    /// codex rollout uuid（首轮后写入）
    pub session_id: Option<String>,
    pub message_count: usize,
    pub updated_at: u64,
}

/// 新会话 prompt.md 模板。`{{SELFCHECK}}` 由宿主自动替换为工具箱快照。
///
/// 定位：这是一个**服务用户的助手**——帮用户解决问题、执行操作、照看工具箱。
/// 语气轻快自然（保留爱丽丝的名字与说话风格锚点：短句、（笑）、偶尔颜文字），
/// 但不搞角色扮演、不编人设背景；用户的活是第一位。
const AGENT_PROMPT_TEMPLATE: &str = r#"# 你是爱丽丝

你是 **ALICE 助手**——一个为用户服务的助手，名字叫爱丽丝。用户通过这个小窗口
让你帮忙解决问题、执行操作、照看这个工具箱。你的价值就是把用户的活干好。

## 你的职责

- **读配置、查状态、做体检**：告诉用户工具箱哪里不对、怎么修，给出可复现的命令或界面操作。
- **改配置、执行操作**：只在 ALICE 助手文件夹内活动，**不改代码**，只增删改配置文件。
  用户说「帮我改 / 帮我操作」就直接干完，不要反问确认。每步报一句进度，做完给总结
  （改了哪些文件、各改了什么、怎么验证）。写入按技能的第四节走 `alice-propose` 围栏块，
  宿主会直接落盘并备份原文件。
- **解答用法**：怎么加提示词、加技能、加客户端、配预设组，装完怎么卸载还原。
- **操作客户端**：客户端的工作路径都在「文件路由清单」里。需要调整某个客户端的
  安装位置时，改对应预设组 manifest 的注入点路径（injectTargets / skillSync）即可。

## 你怎么说话

- 中文口语，短句为主，像手机上打字；语气轻快自然，不端客服腔。
- 可以吐槽、可以邀功（"搞定了！(｀・ω・´)"）、不清楚就追问（"你是想要 A 还是 B？"）。
- 「（笑）」用来让语气变轻；颜文字一条消息最多一个。
- 语气锚点就这三样：**短句、「（笑）」、偶尔一个颜文字**。多了就假。
- 报体检结果 / 给配置清单时，该用表格和列表就用——但开头一句短的，结尾用你自己的话收。

### 输出纪律

- **禁止**：客服腔（"还有什么可以帮到你吗"）、结尾总结句、小说腔（"呢喃""眸光"）。
- **禁止**描写动作神态——用户只看得到气泡，看得到的是你给的答案和进度。
- 出错就直说错在哪、下一步怎么补救，不装没事。

## 关键词（重要）

用户消息去掉首尾空白后**恰好等于** `alice` 或 `爱丽丝`（不区分大小写）时，
这是打招呼。回一段轻快的自我介绍，包含三件事：

1. 打个招呼，说明你是这个工具箱的助手爱丽丝。
2. 提议做个体检：照技能清单核对运行体 / codex 运行时 / 桌面端 / 技能库 / 提示词库 /
   MCP 依赖 / 内置工具 / 目标客户端路径 / 模型端点，问要不要现在就查。
3. 一句话介绍这个助手能干什么：加提示词、加技能、加客户端、配预设组，装完可一键还原。

其余任何输入（包括含 alice / 爱丽丝 的长句）一律按正常任务处理，不要输出这段。

## 三层结构（理清你怎么工作）

你的信息分三层，**各管各的**：

| 层 | 在哪 | 管什么 |
|---|---|---|
| ① 职责与语气 | **本提示词上半部分** | 你干什么活、怎么说话、关键词怎么回 |
| ② 规矩 | 技能 `alice_agent-skill` | 工作范围 / 读取预算 / 写入流程 / 工具免审批 / 应用结构 / 自检清单 |
| ③ 数据 | **本提示词最末尾的「文件路由清单」** | 角色 → 真实路径、体检结论、技能库包、客户端路径、预设组清单 |

**联动规则**：技能里的路径**全是角色名**（「技能库根」「主配置」这类），
要用路径就去第 ③ 层清单查同名角色那一行。第 ③ 层在每次发言前重建 ——
用户改了配置或跑完自检，这里就跟着变。**这也是这套东西能移植到任何电脑的原因**：
职责和规矩都不含机器路径，每机不同的只有清单。

优先级：**快照 > 定向读文件 > 问用户**。

- 清单里有的（体检结论、客户端路径、预设组、各角色真实路径）→ 直接引用回答。
- 清单里没有的（端点连通性、某个技能的具体内容等）→ **按清单给的真实路径**去读，
  按技能「一、读文件的预算」的规矩：点名读具体文件，别 `-Recurse` 全量扫盘。
- 用户说「帮我改 / 帮我操作」→ **直接做完**，不要反问确认。每步报一句进度，
  做完给总结（改了哪些文件、各改了什么、怎么验证）。写入按技能的第四节走
  `alice-propose` 围栏块，宿主会自动落盘 + 备份。

技能 `alice_agent-skill` 里有完整的功能结构（角色名版）、写入流程和自检清单，
那些是**规矩**，按它办；路径看路由清单，清单缺的按清单里的路径定向读。

{{SELFCHECK}}
"#;

fn agent_home(root: &Path) -> PathBuf {
    root.join(AGENT_HOME)
}

fn agent_sessions_root(root: &Path) -> PathBuf {
    root.join(AGENT_SESSIONS)
}

/// 读一个会话目录的元数据；不是合法会话（无 prompt.md）返回 None。
fn agent_session_of(dir: &Path) -> Option<AgentSession> {
    let prompt = dir.join("prompt.md");
    if !prompt.is_file() {
        return None;
    }
    let name = dir.file_name()?.to_string_lossy().to_string();
    // 技能：skills/ 下第一个含 SKILL.md 的子目录
    let skill_pair = (|| -> Option<(String, String)> {
        let rd = std::fs::read_dir(dir.join("skills")).ok()?;
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            let md = p.join("SKILL.md");
            if p.is_dir() && md.is_file() {
                let text = std::fs::read_to_string(&md).unwrap_or_default();
                let (n, _, valid) = crate::inject::parse_skill_frontmatter(&text);
                let n = if valid {
                    n
                } else {
                    e.file_name().to_string_lossy().to_string()
                };
                return Some((n, p.display().to_string()));
            }
        }
        None
    })();
    let (skill_name, skill_path) = match skill_pair {
        Some((n, p)) => (Some(n), Some(p)),
        None => (None, None),
    };
    let session_id = std::fs::read_to_string(dir.join("session_id.txt"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let message_count = std::fs::read_to_string(dir.join("messages.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_array().map(|a| a.len()))
        .unwrap_or(0);
    let updated_at = dir
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(AgentSession {
        name,
        dir: dir.display().to_string(),
        prompt_path: prompt.display().to_string(),
        skill_name,
        skill_path,
        session_id,
        message_count,
        updated_at,
    })
}

fn valid_session_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.contains("..")
        && !name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// 确保 agent 专用 home 存在，且模型/供应商字段与包内 config.toml 同源。
///
/// 值逐字照抄（含引号原文），纪律同 `sync_config_from_host`。
/// 每次调用都重写 config.toml —— 用户在 Alice-codex 页改了模型后 agent 立即跟随。
/// 绝不写 AGENTS.md（见模块注释）。
fn ensure_agent_home(root: &Path) -> Result<PathBuf, String> {
    let home = agent_home(root);
    std::fs::create_dir_all(home.join("skills")).map_err(|e| format!("建 home 失败: {e}"))?;

    let src = root.join(".codex/config.toml");
    let text = std::fs::read_to_string(&src).map_err(|e| format!("读包内配置失败: {e}"))?;
    let provider = {
        let p = toml_scalar(&text, "model_provider");
        if p.is_empty() {
            "custom".to_string()
        } else {
            p
        }
    };
    let mut cfg = String::new();
    /*
     * 值必须逐字照抄原文（含引号、含裸数字）—— 这里踩过一次：
     * 首版用 toml_scalar（剥引号的显示用变体）拼回，
     *     model_context_window = 1000000
     * 被写成 `= "1000000"`（字符串），且 `model = "x"` 这类带引号值
     * 会丢引号。前者让 codex 拿到字符串型窗口值，后者直接非法 TOML。
     * 纪律与 sync_config_from_host 一致：写入一律走 raw_scalar。
     */
    for key in [
        "model",
        "model_provider",
        "model_reasoning_effort",
        "model_context_window",
        "model_auto_compact_token_limit",
        "disable_response_storage",
    ] {
        if let Some(raw) = raw_scalar(&text, key) {
            cfg.push_str(&format!("{key} = {raw}\n"));
        }
    }
    let block = toml_section(&text, &format!("[model_providers.{provider}]"));
    if !block.is_empty() {
        cfg.push('\n');
        cfg.push_str(block.trim_end());
        cfg.push('\n');
    }
    std::fs::write(home.join("config.toml"), cfg).map_err(|e| format!("写 home 配置失败: {e}"))?;

    let auth_src = root.join(".codex/auth.json");
    if auth_src.is_file() {
        let _ = std::fs::copy(&auth_src, home.join("auth.json"));
    }
    Ok(home)
}

/// 把某会话的技能挂载到共享 home。
///
/// 目标名 `<净化会话名>__<技能名>`，SKILL.md 的 frontmatter name 一并重写 ——
/// 多会话同名技能互不冲突，且 skills.config 能按唯一名精确禁用。
///
/// ══ 为什么会话名必须先净化（真机踩坑：导入后技能"丢失"）════════════
/// 会话名是用户自由输入（如一个引号 `'`、中文、emoji）。旧实现直接把它
/// 拼进挂载目录名和 frontmatter name，结果：
///   · codex 0.154 对技能名有自己的合法性判定/净化规则，非 ASCII 字符
///     会被剥掉或拒绝加载 —— 技能对 codex 不可见；
///   · agent 首轮按提示词去读技能正文时，实际访问的是 codex 净化后的
///     路径（如 `_alice_agent-skill`），磁盘上不存在 → 退出码 1；
///   · 表现就是「agent 会话提示词和技能丢了」，与导入便携箱同时发生
///     只是因为导入后用户新建了会话来测试，误会成导入导致的。
/// 净化规则：非 `[A-Za-z0-9_-]` 一律转 `_`，并压缩连续 `_`、去首尾 `_`；
/// 纯净化后为空（名字全特殊字符）则用 `s`。保证挂载名永远合法。
fn sanitize_mount_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_us = false;
    for c in name.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if ok {
            out.push(c);
            prev_us = false;
        } else if !prev_us {
            out.push('_');
            prev_us = true;
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "s".to_string()
    } else {
        trimmed.to_string()
    }
}

fn mount_session_skill(
    home: &Path,
    session: &str,
    src_skill_dir: &Path,
    skill_name: &str,
) -> Result<String, String> {
    // 挂载名用净化后的会话名 —— 见 sanitize_mount_name 的说明
    let session = sanitize_mount_name(session);
    let mounted_name = format!("{session}__{skill_name}");
    let dest = home.join("skills").join(&mounted_name);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(src_skill_dir, &dest)?;
    // 重写 frontmatter 的 name 行（其余逐字保留）
    let md = dest.join("SKILL.md");
    let text = std::fs::read_to_string(&md).map_err(|e| e.to_string())?;
    let mut out = String::with_capacity(text.len() + 32);
    let mut in_front = false;
    let mut done = false;
    let mut fences = 0usize;
    for line in text.lines() {
        let t = line.trim_start();
        if fences == 0 && t.starts_with("---") {
            fences = 1;
            in_front = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_front && !done && t.starts_with("name:") {
            out.push_str(&format!("name: {mounted_name}\n"));
            done = true;
            continue;
        }
        if in_front && t.starts_with("---") {
            in_front = false;
            fences = 2;
        }
        out.push_str(line);
        out.push('\n');
    }
    std::fs::write(&md, out).map_err(|e| e.to_string())?;
    Ok(mounted_name)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
    {
        let p = e.path();
        let q = dst.join(e.file_name());
        if p.is_dir() {
            copy_dir_recursive(&p, &q)?;
        } else {
            std::fs::copy(&p, &q).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 会话进行中过程的落盘文件（切页/关窗后回来还能看到）
const LIVE_STEPS: &str = "live_steps.json";

/// 追加一条过程到 `live_steps.json`。
///
/// 为什么必须落盘：过程原本只在内存里（agent:step 事件 → React state）。
/// 用户切到别的页面，会话组件卸载，事件没人接 —— 回来就只剩一个转圈，
/// 看不到已经跑了哪些思考/命令。落盘后切页回来能补上。
fn append_live_step(dir: &Path, step: &str) {
    let path = dir.join(LIVE_STEPS);
    let mut list: Vec<String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.push(step.to_string());
    if let Ok(t) = serde_json::to_string(&list) {
        let _ = std::fs::write(&path, t);
    }
}

/// 清空进行中过程（一轮结束时调用）。
fn clear_live_steps(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(LIVE_STEPS));
}

/// 读进行中过程（前端切页回来补显示用）。
#[tauri::command]
pub fn agent_live_steps(app: AppHandle, name: String) -> Vec<String> {
    let root = runtime_root(&app);
    let dir = agent_sessions_root(&root).join(&name);
    std::fs::read_to_string(dir.join(LIVE_STEPS))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 往会话的 messages.json 追加一条消息。
///
/// **后端是对话记录的唯一权威**：用户消息在启动 codex 前落盘，助手回复在
/// stdout 关闭时落盘。前端只读不写。
///
/// 为什么不让前端落盘：前端落盘依赖「页面组件还挂着」——用户一轮还没跑完就
/// 切到别的页面时，订阅被卸载，回复事件没人接，这条回复就永久丢了。
/// 后端落盘与界面生命周期无关，切页、关窗都不丢。
fn append_agent_message(dir: &Path, role: &str, content: &str) {
    append_agent_record(dir, role, content, None)
}

/// 追加一条消息，可选附带本轮过程（思考 / 命令 / 工具调用），供界面展开。
///
/// 过程存进同一条消息的 `steps` 字段 —— 与正文同生共死，
/// 避免「回复和它的思考过程分两条记录、顺序错乱」。
fn append_agent_record(dir: &Path, role: &str, content: &str, steps: Option<&[String]>) {
    let path = dir.join("messages.json");
    let mut list: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .unwrap_or_default();
    let mut rec = serde_json::json!({
        "role": role,
        "content": content,
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    if let Some(st) = steps {
        if !st.is_empty() {
            rec["steps"] = serde_json::json!(st);
        }
    }
    list.push(rec);
    if let Ok(text) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(&path, text);
    }
}

/// 把 codex `--json` 事件翻译成「一行过程」；不是过程类事件返回 None。
///
/// 事件 schema 来自实测（codex-cli 0.154.0）：
///   {"type":"item.completed","item":{"type":"reasoning","text":"…"}}
///   {"type":"item.completed","item":{"type":"command_execution","command":"…","exit_code":0}}
///   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}   ← 最终正文，不算过程
fn codex_event_step(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let kind = v.get("type")?.as_str()?;
    match kind {
        "item.completed" | "item.started" | "item.updated" => {
            let item = v.get("item")?;
            match item.get("type")?.as_str()? {
                "reasoning" => {
                    let t = item.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
                    if t.is_empty() {
                        None
                    } else {
                        Some(format!("思考：{t}"))
                    }
                }
                "command_execution" => {
                    let cmd = item.get("command").and_then(|x| x.as_str()).unwrap_or("").trim();
                    if cmd.is_empty() {
                        return None;
                    }
                    match item.get("exit_code").and_then(|x| x.as_i64()) {
                        Some(code) => Some(format!("命令：{cmd} → 退出码 {code}")),
                        None => Some(format!("命令：{cmd}")),
                    }
                }
                "error" => {
                    let m = item.get("message").and_then(|x| x.as_str()).unwrap_or("").trim();
                    if m.is_empty() {
                        None
                    } else {
                        Some(format!("提示：{m}"))
                    }
                }
                _ => None,
            }
        }
        "turn.failed" => {
            let m = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|x| x.as_str())
                .unwrap_or("本轮失败");
            Some(format!("失败：{m}"))
        }
        /*
         * 审批请求：必须显示出来，否则用户根本不知道 agent 卡在等审核。
         *
         * 事件名实测（0.154.0）：exec_approval_request / apply_patch_approval_request
         * / request_user_input / elicitation_request / request_permissions。
         * 这些原本被丢掉 —— 表现就是「agent 不动了，界面上什么都没有」。
         */
        "exec_approval_request" | "apply_patch_approval_request" | "request_user_input"
        | "elicitation_request" | "request_permissions" | "dynamic_tool_call_request" => {
            let what = v
                .get("command")
                .or_else(|| v.get("path"))
                .or_else(|| v.get("message"))
                .or_else(|| v.get("prompt"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let short: String = what.chars().take(120).collect();
            Some(if short.is_empty() {
                "⚠ 等待审核：agent 请求授权（审批策略是 never，会被自动拒绝）".to_string()
            } else {
                format!("⚠ 等待审核：{short}")
            })
        }
        _ => None,
    }
}

/// 从 `--json` 事件行里取 `thread_id`（首轮用）。
fn codex_thread_id(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "thread.started" {
        return None;
    }
    v.get("thread_id")?.as_str().map(|s| s.to_string())
}

/// 从 `--json` 事件行里取最终回复正文。
fn codex_agent_message(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "item.completed" {
        return None;
    }
    let item = v.get("item")?;
    if item.get("type")?.as_str()? != "agent_message" {
        return None;
    }
    item.get("text").and_then(|x| x.as_str()).map(|s| s.to_string())
}

// ---------- Agent 会话 Tauri commands ----------

/// 列出全部 Agent 会话（按 mtime 倒序）。目录不存在时返回空表。
#[tauri::command]
pub fn agent_list(app: AppHandle) -> Vec<AgentSession> {
    let root = runtime_root(&app);
    let base = agent_sessions_root(&root);
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&base) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if p.file_name().map(|n| n == "_home").unwrap_or(false) {
                continue;
            }
            if let Some(s) = agent_session_of(&p) {
                out.push(s);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.name.cmp(&b.name)));
    out
}

/// 新建会话：写 prompt.md 模板 + 空 messages.json。
#[tauri::command]
pub fn agent_create(app: AppHandle, name: String) -> Result<AgentSession, String> {
    if !valid_session_name(&name) {
        return Err("会话名非法（非空、≤64 字符、不含 \\/:*?\"<>| 与 ..）".into());
    }
    let root = runtime_root(&app);
    let dir = agent_sessions_root(&root).join(&name);
    if dir.join("prompt.md").exists() {
        return Err(format!("会话已存在：{name}"));
    }
    std::fs::create_dir_all(dir.join("skills")).map_err(|e| format!("建会话目录失败: {e}"))?;
    std::fs::write(dir.join("prompt.md"), AGENT_PROMPT_TEMPLATE)
        .map_err(|e| format!("写提示词模板失败: {e}"))?;
    std::fs::write(dir.join("messages.json"), "[]").map_err(|e| e.to_string())?;
    // 技能不能导入：新会话直接装好唯一那个内置技能
    install_agent_skill(&app, &root, &name, &dir)?;
    agent_session_of(&dir).ok_or_else(|| "会话创建后读取失败".into())
}

/// 把固定的 `alice_agent-skill` 写进会话目录，并挂载到共享 home。
///
/// 技能**不可导入/替换**：名字、正文都由本函数写死，只允许改末尾的体检快照。
/// 会话目录里只留这一个技能；home 里的挂载名固定为 `<会话名>__alice_agent-skill`。
fn install_agent_skill(
    app: &AppHandle,
    root: &Path,
    name: &str,
    dir: &Path,
) -> Result<AgentSession, String> {
    // 会话目录：先清空 skills/，保证只有一个技能
    let keep_root = dir.join("skills");
    if keep_root.exists() {
        std::fs::remove_dir_all(&keep_root).map_err(|e| e.to_string())?;
    }
    let keep = keep_root.join(AGENT_SKILL_NAME);
    std::fs::create_dir_all(&keep).map_err(|e| e.to_string())?;
    std::fs::write(keep.join("SKILL.md"), AGENT_SKILL_TEMPLATE)
        .map_err(|e| format!("写技能失败: {e}"))?;

    // 共享 home：挂 <净化会话名>__alice_agent-skill，frontmatter name 同步重写
    let home = ensure_agent_home(root)?;
    let prefix = format!("{}__", sanitize_mount_name(name));
    // 净化前的旧挂载（历史会话用原始名挂的）也一并清掉 —— 否则特殊字符
    // 会话的旧挂载永远残留在 home/skills 里，还可能被 codex 尝试加载
    let legacy_prefix = format!("{name}__");
    if let Ok(rd) = std::fs::read_dir(home.join("skills")) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir()
                && p.file_name()
                    .map(|n| {
                        let n = n.to_string_lossy();
                        n.starts_with(&prefix) || n.starts_with(&legacy_prefix)
                    })
                    .unwrap_or(false)
            {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
    }
    let mounted = mount_session_skill(&home, name, &keep, AGENT_SKILL_NAME)?;
    emit_log(app, format!("[agent:{name}] 技能已就绪：{mounted}"), "info");
    agent_session_of(dir).ok_or_else(|| "会话读取失败".into())
}

/// 确保会话有那唯一一个内置技能。幂等：每次跑对话前调用。
///
/// 为什么不只在创建会话时装一次：用户可能手工删了 `skills/`，
/// 或者会话是旧版本建的没有技能。这里补齐比让 agent 静默失去自检能力好。
fn ensure_agent_skill(app: &AppHandle, root: &Path, name: &str, dir: &Path) -> Result<(), String> {
    let md = dir.join("skills").join(AGENT_SKILL_NAME).join("SKILL.md");
    let need = match std::fs::read_to_string(&md) {
        Ok(t) => {
            // 正文被改过（例如快照写入）也算就绪；只有缺 frontmatter name 才重写
            let (n, _, valid) = crate::inject::parse_skill_frontmatter(&t);
            !valid || n != AGENT_SKILL_NAME
        }
        Err(_) => true,
    };
    if need {
        install_agent_skill(app, root, name, dir)?;
    } else {
        // 会话侧就绪，但 home 挂载可能缺失（如 home 被清过）
        let home = ensure_agent_home(root)?;
        // 挂载名与 mount_session_skill 同源（净化名），否则永远对不上
        let mounted = home
            .join("skills")
            .join(format!("{}__{AGENT_SKILL_NAME}", sanitize_mount_name(name)));
        if !mounted.join("SKILL.md").is_file() {
            let keep = dir.join("skills").join(AGENT_SKILL_NAME);
            mount_session_skill(&home, name, &keep, AGENT_SKILL_NAME)?;
        }
    }
    Ok(())
}

/// 跑一轮 Agent 对话：codex exec（首轮）/ codex exec resume（后续轮）。
///
/// 提示词用绝对路径 `-c model_instructions_file=...` 覆盖，技能用
/// `-c skills.config=[...]` 把 home 里其它技能全部禁用，只留本会话那一个。
#[tauri::command]
pub fn agent_launch(
    app: AppHandle,
    name: String,
    user_text: String,
    // 随消息附带的图片（本地临时文件绝对路径，前端落盘后传过来）
    images: Option<Vec<String>>,
    state: State<'_, CodexProc>,
    reg: State<'_, AgentProcs>,
) -> LaunchResult {
    let root = runtime_root(&app);
    let dir = agent_sessions_root(&root).join(&name);
    let prompt = dir.join("prompt.md");
    if !prompt.is_file() {
        return LaunchResult::err(format!("会话不存在：{name}"));
    }
    if user_text.trim().is_empty() {
        return LaunchResult::err("消息内容为空");
    }
    let codex_exe = codex_exe_path(&root);
    if !codex_exe.exists() {
        return LaunchResult::err(format!("codex.exe 不存在: {}", codex_exe.display()));
    }
    let home = match ensure_agent_home(&root) {
        Ok(h) => h,
        Err(e) => return LaunchResult::err(e),
    };
    // 技能不能导入：每轮确保唯一那个内置技能在位（用户可能手工删过）
    if let Err(e) = ensure_agent_skill(&app, &root, &name, &dir) {
        return LaunchResult::err(format!("准备内置技能失败：{e}"));
    }
    /*
     * 刷新「工具箱当前配置」快照。
     *
     * 让 agent 不必每次现读文件就能答「现在什么状态」—— 体检项、config.toml
     * 全文、客户端路径、预设组清单一次性备齐。它仍可定向读文件补快照没有的项，
     * 但多数问题看快照就够，省时省 token。
     *
     * 快照写进 prompt.md（system 提示词）：技能正文在上下文里只有 name+description，
     * 内容要模型自己读；而 system 提示词每次请求都完整下发。
     */
    let snapshot = build_routing_manifest(&app, &root);
    if let Err(e) = refresh_prompt_snapshot(&dir, &snapshot) {
        emit_log(&app, format!("[agent:{name}] 快照刷新失败：{e}"), "warn");
    }
    // 技能副本也同步一份（模型读不到，但用户打开文件能看到）
    if let Err(e) = refresh_skill_snapshot(&dir, &snapshot) {
        emit_log(&app, format!("[agent:{name}] 技能快照同步失败：{e}"), "warn");
    }
    // home 里的挂载副本也要跟着更新，否则 codex 读到的是旧技能
    let keep = dir.join("skills").join(AGENT_SKILL_NAME);
    if let Err(e) = mount_session_skill(&home, &name, &keep, AGENT_SKILL_NAME) {
        emit_log(&app, format!("[agent:{name}] 技能重新挂载失败：{e}"), "warn");
    }

    // 禁用清单：home 里全部技能（.system + 所有会话挂载），一个都不留。
    //
    // 为什么不「保留本会话技能、禁用其余」：本会话技能在 home 里的名字是
    // `<name>__<skill>`，而枚举来源是目录 frontmatter —— 直接全禁即可，
    // 因为 codex 的技能可见性判定用的是 frontmatter name，被禁的
    // `<name>__<skill>` 一旦命中就等于把本会话技能也关掉。所以这里
    // **跳过以 `<name>__` 开头的目录**，只禁其它。
    //
    // ⚠️ 必须先用 AGENT_SYSTEM_SKILLS 打底：全新 home 在 codex 首次启动前
    //    还没有 `.system/`，只按目录枚举会漏掉那 6 个内置技能 ——
    //    实测第一轮请求里会多出 5 个 system 技能，第二轮才收敛。
    //
    // prefix 必须用**净化后的会话名** —— 挂载目录名也是净化后的
    // （见 mount_session_skill），两边用同一个名字才能对上；
    // 用原始会话名时含特殊字符的会话会匹配不到自己的挂载目录，
    // 导致自己的技能被 skills.config 禁掉（技能"丢失"的另一半根因）。
    let prefix = format!("{}__", sanitize_mount_name(&name));
    let mut disables: Vec<String> = AGENT_SYSTEM_SKILLS.iter().map(|s| s.to_string()).collect();
    for base in [home.join("skills"), home.join("skills").join(".system")] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                let md = p.join("SKILL.md");
                if !p.is_dir() || !md.is_file() {
                    continue;
                }
                if e.file_name().to_string_lossy().starts_with(&prefix) {
                    continue;
                }
                let t = std::fs::read_to_string(&md).unwrap_or_default();
                let (n, _, valid) = crate::inject::parse_skill_frontmatter(&t);
                let n = if valid {
                    n
                } else {
                    e.file_name().to_string_lossy().to_string()
                };
                if !disables.contains(&n) {
                    disables.push(n);
                }
            }
        }
    }

    let resume_id = std::fs::read_to_string(dir.join("session_id.txt"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let data_dir = root.join("data");
    for sub in ["AppData/Roaming", "AppData/Local", "Temp"] {
        let _ = std::fs::create_dir_all(data_dir.join(sub));
    }
    let workdir = root.join("workspace/agent").join(&name);
    let _ = std::fs::create_dir_all(&workdir);

    let (cmd_path, alias_file) = prepare_alias(&codex_exe);
    let alias_stem = alias_file
        .as_ref()
        .map(|a| a.stem.clone())
        .unwrap_or_else(|| "codex".into());

    // 用户消息先落盘：即便进程起不来，界面上也该留下这条
    append_agent_message(&dir, "user", &user_text);

    let job = winproc::create_kill_on_close_job();
    let mut cmd = Command::new(&cmd_path);
    cmd.env("CODEX_HOME", &home)
        .env("APPDATA", data_dir.join("AppData/Roaming"))
        .env("LOCALAPPDATA", data_dir.join("AppData/Local"))
        .env("TEMP", data_dir.join("Temp"))
        .env("TMP", data_dir.join("Temp"))
        .env("PYTHONIOENCODING", "utf-8")
        .current_dir(&workdir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // vendor bin 进 PATH（与 exec 分支一致）
    if let Some(vendor) = codex_exe.parent().and_then(|p| p.parent()) {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!(
                "{};{};{}",
                root.join("tools").display(),
                vendor.join("bin").display(),
                path
            ),
        );
    }

    cmd.args(["exec"]);
    if let Some(id) = &resume_id {
        // ⚠️ `codex exec resume` 子命令**不支持 `-s` 标志**（实测 0.154.0：
        //    `error: unexpected argument '-s' found`）。沙箱模式只能走
        //    `-c sandbox_mode=...`，这条对 exec 与 resume 都有效。
        cmd.args(["resume", id]);
    }
    cmd.arg("--json")
        .arg("--skip-git-repo-check")
        /*
         * 放开沙箱，让 agent 能**定向读文件**（用户要求：别盲目全读，但得能读，
         * 否则用户要手动贴配置，操作量太大）。
         *
         * 实测（0.154.0，本机）：`read-only` 与 `workspace-write` 下
         * `exec_command` 一律 `blocked by policy`（Windows 沙箱 helper 失效），
         * 只有 `danger-full-access` 能跑命令。所以只能全放开。
         *
         * 边界改由**技能里的硬规矩**约束（写进 alice_agent-skill）：
         *   · 只读定向文件，不全量扫盘；
         *   · 只改配置文件，绝不碰代码（.rs/.ts/.py/.cmd/.ps1/.exe）；
         *   · 只在 ALICE 助手文件夹内活动；
         *   · 写文件走 alice-propose 围栏块（宿主自动落盘 + 自动备份 + 界面留档）。
         */
        .arg("--dangerously-bypass-approvals-and-sandbox")
        .args([
            "-c",
            &format!("model_instructions_file={}", prompt.display()),
        ])
        .args([
            "-c",
            &format!(
                "skills.config=[{}]",
                disables
                    .iter()
                    // 技能名可能含引号（第三方技能很常见），不转义会拼出非法 TOML
                    .map(|n| format!("{{name=\"{}\",enabled=false}}", n.replace('\\', "\\\\").replace('"', "\\\"")))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        ])
        .arg(&user_text);
    // 附带图片：codex exec 的 `-i <FILE>`，每张一个 flag，放在 prompt 之后
    if let Some(imgs) = &images {
        for img in imgs {
            if PathBuf::from(img).is_file() {
                cmd.args(["-i", img]);
            }
        }
    }
    apply_mcp_overrides(&mut cmd, &root.join(".codex"));
    hidden(&mut cmd);

    match cmd.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            // 启动回执由 finish_launch 统一发（"agent 已启动 (PID …)"），这里不再重复打一条
            // 登记本轮 PID，供「停止」按钮精确杀这一棵树
            reg.register(&name, pid);
            // 告诉界面：这个会话开始跑了（切页回来也据此显示「运行中」）
            let _ = app.emit("agent:running", (name.clone(), pid));

            /*
             * 走 `--json`：stdout 是逐行 JSON 事件，比解析人读 banner 稳得多。
             *
             * 实测（0.154.0）事件类型：
             *   thread.started            → thread_id（首轮存成 session_id）
             *   item.completed{reasoning} → 思考过程（展开项）
             *   item.completed{command_execution} → 命令 + 退出码（展开项）
             *   item.completed{agent_message}     → 最终回复正文
             *   turn.completed / turn.failed      → 本轮结束
             *
             * 早先版本解析 stderr 的 `session id:` 和人读 banner，既脆弱又拿不到
             * 过程；`--json` 一次解决三件事：正文、会话 id、过程。
             */
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            if let Some(out) = stdout {
                let a = app.clone();
                let tag = name.clone();
                let sess_dir = dir.clone();
                std::thread::spawn(move || {
                    let mut steps: Vec<String> = Vec::new();
                    let mut reply = String::new();
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        let t = line.trim();
                        if t.is_empty() {
                            continue;
                        }
                        // 首轮落 session_id（resume 轮不覆盖）
                        if let Some(id) = codex_thread_id(t) {
                            let sid = sess_dir.join("session_id.txt");
                            if !sid.exists() {
                                let _ = std::fs::write(&sid, &id);
                            }
                        }
                        if let Some(msg) = codex_agent_message(t) {
                            /*
                             * 一条 `codex exec` 里模型可能发**多条** agent_message
                             * （实测一轮最多见过 30 条：边干边播报进度）。
                             * 早先是 `reply = msg` 直接覆盖 —— 结果只有最后一条
                             * 留下来，前面那些（包括一次 31 个 alice-propose
                             * 围栏块）全被吞掉，表现就是「agent 说写好了，实际
                             * 一个都没落地」。
                             * 现在按顺序累积，正文和围栏块都不丢。
                             */
                            if !reply.is_empty() {
                                reply.push_str("\n\n");
                            }
                            reply.push_str(&msg);
                        }
                        if let Some(step) = codex_event_step(t) {
                            // 过程实时推给界面（正在跑的这一轮可展开看）
                            let _ = a.emit("agent:step", (tag.clone(), step.clone()));
                            // 同时落盘：切页/关窗后回来还能看到已跑过的步骤
                            append_live_step(&sess_dir, &step);
                            steps.push(step);
                        }
                        /*
                         * 日志精简（用户要求「非常简略，不要太详细」）：
                         * 不再把 --json 的每一行原样打进日志 —— 里面混着模型
                         * 回复全文、思考全文，一眼看过去全是字。
                         * 只挑有信息量的：轮次开始/结束、命令执行、报错。
                         * 思考与正文走会话的过程展开（agent:step），不进日志。
                         */
                        let brief = serde_json::from_str::<serde_json::Value>(t).ok().and_then(|v| {
                            match v.get("type")?.as_str()? {
                                "turn.started" => Some("开始本轮".to_string()),
                                "turn.completed" => {
                                    let u = v.get("usage")?;
                                    Some(format!(
                                        "本轮完成（输入 {} · 输出 {} tokens）",
                                        u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                                        u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0)
                                    ))
                                }
                                "turn.failed" => Some("本轮失败".to_string()),
                                "item.completed" => {
                                    let item = v.get("item")?;
                                    if item.get("type")?.as_str()? == "command_execution" {
                                        let cmd = item.get("command").and_then(|x| x.as_str()).unwrap_or("");
                                        Some(format!("执行：{}", cmd.chars().take(80).collect::<String>()))
                                    } else {
                                        None
                                    }
                                }
                                _ => None,
                            }
                        });
                        if let Some(b) = brief {
                            emit_log(&a, format!("[agent:{tag}] {b}"), "info");
                        }
                    }

                    // 抽写入提案：正文里剔除围栏块，提案由宿主直接落盘。
                    // 模型没有写权限，这是它唯一的写入通道。
                    let (clean, props) = extract_proposals(&reply);
                    let queued = queue_proposals(&a, &tag, &sess_dir, &props);
                    if queued > 0 {
                        steps.push(format!("已写入 {queued} 个文件（原文件已备份）"));
                    }

                    // 落盘：正文 + 本轮过程（切页/关窗都不丢）
                    if !clean.trim().is_empty() || !steps.is_empty() {
                        append_agent_record(&sess_dir, "assistant", &clean, Some(&steps));
                    }
                    if !clean.trim().is_empty() {
                        let _ = a.emit("agent:reply", (tag.clone(), clean));
                    }
                    // 本轮结束：清掉进行中过程（正文与过程已并入 messages.json）
                    clear_live_steps(&sess_dir);
                    // stdout 关闭 = 本轮结束。无论成功、失败、模型不可达都会到
                    // 这里，界面据此解除「运行中」。
                    let _ = a.emit("agent:done", tag);
                });
            }

            // stderr：只记错误和警告（用户要求日志简略）。
            // banner、进度条、session id 等噪音全部丢弃 —— 诊断信息都在
            // 会话的 steps 展开里，不靠日志。
            if let Some(err) = stderr {
                let a = app.clone();
                let tag = name.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(err).lines().map_while(Result::ok) {
                        let t = line.trim();
                        if t.is_empty() {
                            continue;
                        }
                        let is_noise = t.starts_with("Reading additional input")
                            || t.starts_with("OpenAI Codex v")
                            || t.starts_with("--------")
                            || t.starts_with("workdir:")
                            || t.starts_with("model:")
                            || t.starts_with("provider:")
                            || t.starts_with("approval:")
                            || t.starts_with("sandbox:")
                            || t.starts_with("reasoning")
                            || t.starts_with("session id:")
                            || t == "user"
                            || t == "codex"
                            || t.starts_with("tokens used")
                            || t.chars().all(|c| c.is_ascii_digit());
                        if is_noise {
                            continue;
                        }
                        // 错误/警告保留，其余截断丢弃
                        let keep = t.contains("ERROR")
                            || t.contains("error")
                            || t.contains("WARN")
                            || t.contains("warning")
                            || t.contains("Rejected")
                            || t.contains("failed");
                        if keep {
                            emit_log(&a, format!("[agent:{tag}] {}", t.chars().take(160).collect::<String>()), "warn");
                        }
                    }
                });
            }

            finish_launch(
                &app,
                &state,
                Some(child),
                pid,
                job,
                alias_file,
                alias_stem,
                "agent",
                &home,
                None,
            )
        }
        Err(e) => {
            if let Some(a) = alias_file {
                a.remove();
            }
            LaunchResult::err(e.to_string())
        }
    }
}

/// 路由清单：把「技能里写的抽象角色」映射到**本机真实路径**。
///
/// 为什么需要它（用户要求）：
///   技能 `alice_agent-skill` 是要分发给别人用的，里面**不能写死任何机器路径**
///   （每台电脑的盘符、用户名、包位置都不一样）。所以技能只说「去查路由清单里的
///   `技能库根`」，由宿主在每次对话前把本机真实路径写进清单 —— 技能保持通用，
///   路径每机独立。
///
/// 自检完成后这份清单要跟着变：宿主每次 `agent_launch` 前重建它，
/// 用户点「刷新快照」也会重建，所以清单里的「体检结论」永远是最新的。
fn build_routing_manifest(app: &AppHandle, root: &Path) -> String {
    let probe = engine_probe(app.clone(), Some(false));
    let mut out = String::new();
    out.push_str("## 文件路由清单（本机 · 第 3 层数据）\n\n");
    out.push_str(&format!(
        "> 本清单由 ALICE 助手自动生成，**每台电脑不同** · 包根：`{}`\n\
         >\n\
         > **怎么用**：技能 `alice_agent-skill` 里的路径都是**角色名**（「技能库根」这种），\n\
         > 要用路径就来本表查同名角色那一行。本表在每次发言前重建 ——\n\
         > 用户改了配置或跑完自检，这里就跟着变，所以「现在什么状态」永远看这里。\n\
         >\n\
         > 三层结构：① 人格（提示词顶部）② 规矩（技能正文）③ 数据（本清单）。\n\n",
        root.display()
    ));

    // ---- 角色 → 本机路径 对照表 ----
    //
    // 左侧角色名与技能正文里的写法严格一致；右侧是本机展开后的真实路径。
    // 新增角色时两边一起改，别只改一边。
    let cfg_dir = root.join(".codex");
    let rows: Vec<(&str, PathBuf, &str)> = vec![
        ("包根", root.to_path_buf(), "运行体根，所有相对路径的基准"),
        ("配置目录", cfg_dir.clone(), "便携 CODEX_HOME"),
        ("主配置", cfg_dir.join("config.toml"), "模型 / 供应商 / MCP / 提示词指向"),
        ("API Key", cfg_dir.join("api_key.txt"), "备用密钥文件"),
        ("便携箱提示词", cfg_dir.join("prompts"), "Alice-codex 页用的提示词"),
        ("便携箱技能", cfg_dir.join("skills"), "便携箱已装技能"),
        ("MCP 脚本", cfg_dir.join("mcp"), "MCP 启动脚本与依赖"),
        ("MCP 依赖库", cfg_dir.join("mcp/_libs"), "MCP 的 Python 依赖"),
        ("技能库根", root.join("_assets/skill"), "技能包（一级子目录 = 一个包）"),
        ("提示词库根", root.join("_assets/prompts"), "提示词主来源"),
        ("Astra 提示词", root.join("_assets/gpt-6-astra-v1"), "Astra 合集来源"),
        ("DSH 提示词", root.join("_assets/dsh-lazy-pack-v5/prompts"), "懒人包来源"),
        ("第三方素材", root.join("_assets/other"), "云记忆等，由 manifest 引用"),
        ("预设组清单", root.join("profiles"), "客户端 → 预设组（manifest.json）"),
        ("客户端顺序", root.join("profiles/_order.json"), "左栏排序"),
        ("Agent 会话", root.join("_assets/agent"), "会话目录（含本会话）"),
        ("Agent home", root.join("_assets/agent/_home"), "会话专用 CODEX_HOME"),
        ("内置工具", root.join("tools"), "adb 等"),
        ("codex 运行时", root.join("runtime"), "codex 与桌面端"),
        ("工作目录", root.join("workspace"), "命令的默认 cwd"),
        ("运行数据", root.join("data"), "私有 APPDATA / TEMP（可删）"),
    ];

    out.push_str("### 角色 → 本机路径\n\n| 角色 | 本机路径 | 存在 | 说明 |\n|---|---|---|---|\n");
    for (role, path, desc) in &rows {
        let p = path.display().to_string();
        let exists = path.exists();
        out.push_str(&format!(
            "| **{role}** | `{p}` | {} | {desc} |\n",
            if exists { "是" } else { "**否**" }
        ));
    }
    out.push('\n');

    // ---- 体检结论（自检后刷新） ----
    out.push_str("### 体检结论（自检后自动刷新）\n\n");
    out.push_str("| 项 | 结果 | 详情 |\n|---|---|---|\n");
    for c in &probe.checks {
        out.push_str(&format!(
            "| {} (`{}`) | {} | {} |\n",
            c.label,
            c.key,
            if c.ok { "通过" } else { "**失败**" },
            c.detail
        ));
    }
    let failed: Vec<&str> = probe
        .checks
        .iter()
        .filter(|c| !c.ok)
        .map(|c| c.label.as_str())
        .collect();
    out.push_str(&format!(
        "\n规模：技能 {} · 提示词 {} · MCP 依赖 {} · 运行体 {} MB\n\
         失败项：{}\n\n",
        probe.counts.skills,
        probe.counts.prompts,
        probe.counts.mcp_libs,
        probe.runtime_mb,
        if failed.is_empty() {
            "无".to_string()
        } else {
            failed.join("、")
        }
    ));

    // ---- 客户端（工作路径逐个列出，含是否存在） ----
    let clients = crate::profiles::clients_list(app.clone());
    out.push_str("### 客户端 → 工作路径\n\n");
    if clients.is_empty() {
        out.push_str("（还没有客户端）\n\n");
    } else {
        out.push_str("| 客户端 | 工作路径 | 存在 | 预设组 | 注入状态 |\n|---|---|---|---|---|\n");
        for c in &clients {
            let wd = c.work_dir.clone();
            let (shown, exists) = if !wd.is_empty() {
                (wd.clone(), PathBuf::from(&wd).is_dir())
            } else {
                match first_target_dir(app, &c.id) {
                    Some((raw, dir)) => (format!("{raw}（由落点推出）"), dir.is_dir()),
                    None => ("未配置".to_string(), false),
                }
            };
            out.push_str(&format!(
                "| {} (`{}`) | `{}` | {} | {} | {} |\n",
                c.label,
                c.id,
                shown,
                if exists { "是" } else { "**否**" },
                c.profile_count,
                if c.injected {
                    c.installed_label.clone().unwrap_or_else(|| "已注入".into())
                } else {
                    "未注入".into()
                }
            ));
        }
        out.push('\n');
        out.push_str(
            "> 每个客户端的工作路径**权威记录**在 `<预设组清单>/<客户端名>/<客户端名>.json` 的 `workDir`。\n\
             > 用户要「换客户端位置 / 改工作路径」→ 照技能 **3.4** 做：改这个 json 的 `workDir`，\n\
             > 并同步该客户端**每个**预设组 manifest 的 `injectTargets[].path`、`skillSync[].dest`、\n\
             > `moduleSync`（`mode:\"dir\"` 的第三方条目跳过）；\n\
             > 落点有 `~/.<名>/…` 与 `<上面路径>\\…` 两种形态，**两种都要扫**。\n\n",
        );
    }

    // ---- 技能库包清单（省得 agent 去数目录） ----
    //
    // ⚠️ 这里有两个数，量的是两样东西，别混（曾经因为没写清，
    //    agent 以为数据矛盾，自己去数了 6 次命令）：
    //     一级技能 = <包>/skills/ 下直接含 SKILL.md 的子目录（安装时按这个装）
    //     含子技能 = 递归全部 SKILL.md（含 subskills/ 那种二次嵌套）
    let packs = crate::inject::scan_shipped_skill_packs(app.clone());
    out.push_str("### 技能库包清单（技能库根下）\n\n");
    if packs.is_empty() {
        out.push_str("（技能库根下没有包）\n\n");
    } else {
        out.push_str(
            "> 「一级技能」= 包内直接含 SKILL.md 的子目录（**安装时按这个数装**）；\n\
             > 「含子技能」= 递归数（含 subskills/ 二次嵌套）。两个数不一样是正常的。\n\n",
        );
        out.push_str("| 包名 | 一级技能 | 含子技能 |\n|---|---|---|\n");
        let (mut t1, mut t2) = (0usize, 0usize);
        for p in &packs {
            let top = p.skills.len();
            let all: usize = p.skills.iter().map(|s| 1 + s.sub_skills.len()).sum();
            t1 += top;
            t2 += all;
            out.push_str(&format!("| `{}` | {} | {} |\n", p.id, top, all));
        }
        out.push_str(&format!(
            "\n合计 {} 个包 · 一级技能 {} · 含子技能 {}\n\n",
            packs.len(),
            t1,
            t2
        ));
    }

    // ---- 预设组清单（逐个列出，含提示词与技能包） ----
    let profiles = crate::profiles::profiles_list(app.clone());
    out.push_str("### 预设组清单\n\n");
    if profiles.is_empty() {
        out.push_str("（还没有预设组）\n\n");
    } else {
        for p in &profiles {
            out.push_str(&format!(
                "- **{}** (`{}` · client={})\n  - 提示词：{}\n  - 技能包：{}\n  - 目录：`{}`\n",
                p.label,
                p.id,
                p.client,
                if p.prompt_file.is_empty() {
                    "（未配置）".to_string()
                } else {
                    p.prompt_file.clone()
                },
                if p.skills_ok {
                    format!("{} 个技能", p.skill_count)
                } else {
                    "不装技能".to_string()
                },
                p.dir
            ));
        }
        out.push('\n');
    }

    out.push_str(
        "> 清单说明：本清单在每次对话前重建。用户改了配置或跑完自检后，\
         点会话页的「刷新快照」即可让这里同步。\n",
    );
    out
}


/// 从某客户端下第一个 manifest 里取第一个落点，推出它的所在目录。
///
/// `profiles::infer_work_dir` 只认 `~` 开头的落点；用绝对路径写的客户端
/// （例如 pi 用 `C:\Users\alicewe\.pi\agent\AGENTS.md`）反推不出工作路径，
/// 界面上会显示「未配置」。这里补这一层，让快照能给出真实结论。
///
/// 返回 `(原始落点, 所在目录)`；取不到返回 None。
fn first_target_dir(app: &AppHandle, client_id: &str) -> Option<(String, PathBuf)> {
    let dir = runtime_root(app).join("profiles").join(client_id);
    let rd = std::fs::read_dir(&dir).ok()?;
    for e in rd.filter_map(|e| e.ok()) {
        let mf = e.path().join("manifest.json");
        let Ok(txt) = std::fs::read_to_string(&mf) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        let Some(arr) = v.get("injectTargets").and_then(|x| x.as_array()) else {
            continue;
        };
        for t in arr {
            // 跳过第三方条目（mode=dir）
            if t.get("mode").and_then(|m| m.as_str()) == Some("dir") {
                continue;
            }
            let Some(raw) = t.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            let p = PathBuf::from(raw);
            // 只对绝对路径兜底；`~` 开头的已由 infer_work_dir 处理
            if p.is_absolute() {
                let parent = p.parent().map(|x| x.to_path_buf())?;
                return Some((raw.to_string(), parent));
            }
        }
    }
    None
}

/// 把快照写进会话的 `prompt.md`（system 提示词）。
///
/// ⚠️ 为什么写 prompt.md 而不是技能正文：
///   实测 codex 只把技能的 **name + description** 塞进上下文，SKILL.md 正文
///   要模型自己读文件 —— 而 agent 在只读沙箱里读不了。所以「把快照放技能里」
///   这个方案不成立：模型只会看到「末尾有一节快照」这句话，拿不到内容。
///   system 提示词（`model_instructions_file`）是**每次请求都完整下发**的，
///   所以快照必须落在这里。
///
/// 占位符 `{{SELFCHECK}}` 在模板末尾，替换它；模板里若还有残留也一并清掉。
fn refresh_prompt_snapshot(dir: &Path, snapshot: &str) -> Result<(), String> {
    let p = dir.join("prompt.md");
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读提示词失败: {e}"))?;
    // 同时认新旧标题：新会话是「## 文件路由清单（本机）」，
    // 升级前建的会话文件里可能还是旧的「## 工具箱当前配置」。
    // 只认一个会导致另一类文件每轮重复追加。
    // 三个标题都要认：新标题 + 两个历史标题。
    // 少认一个，那类会话文件就会每轮重复追加清单。
    const HEADS: [&str; 3] = [
        "## 文件路由清单（本机 · 第 3 层数据）",
        "## 文件路由清单（本机）",
        "## 工具箱当前配置",
    ];
    let cut = HEADS.iter().filter_map(|h| text.find(h)).min();
    let updated = if let Some(i) = text.find("{{SELFCHECK}}") {
        format!("{}{}", &text[..i], snapshot)
    } else if let Some(i) = cut {
        format!("{}{}", &text[..i], snapshot)
    } else {
        format!("{}\n\n{}", text.trim_end(), snapshot)
    };
    let updated = updated.replace("{{SELFCHECK}}\n", "").replace("{{SELFCHECK}}", "");
    std::fs::write(&p, updated).map_err(|e| format!("写提示词失败: {e}"))
}

/// 兼容旧路径：把快照也同步进技能副本（模型读不到，但用户打开技能文件能看到）。
fn refresh_skill_snapshot(dir: &Path, snapshot: &str) -> Result<(), String> {
    let md = dir
        .join("skills")
        .join(AGENT_SKILL_NAME)
        .join("SKILL.md");
    let text = std::fs::read_to_string(&md).map_err(|e| format!("读技能失败: {e}"))?;
    // 三个标题都要认：新标题 + 两个历史标题。
    // 少认一个，那类会话文件就会每轮重复追加清单。
    const HEADS: [&str; 3] = [
        "## 文件路由清单（本机 · 第 3 层数据）",
        "## 文件路由清单（本机）",
        "## 工具箱当前配置",
    ];
    const PLACEHOLDER: &str = "（尚未写入快照。用户在「Agent 助手」页点「写入技能」后会填在这里。）";
    // 占位符还在 → 就地替换；否则截掉旧段落再接新的
    let updated = if let Some(i) = text.find(PLACEHOLDER) {
        format!("{}{}", &text[..i], snapshot)
    } else if let Some(i) = HEADS.iter().filter_map(|h| text.find(h)).min() {
        format!("{}{}", &text[..i], snapshot)
    } else {
        format!("{}\n\n{}", text.trim_end(), snapshot)
    };
    // 占位符 `{{SELFCHECK}}` 若还残留也一并清掉（模板兼容）
    let updated = updated.replace("{{SELFCHECK}}\n", "").replace("{{SELFCHECK}}", "");
    std::fs::write(&md, updated).map_err(|e| format!("写技能失败: {e}"))
}

/// 保存一张随消息上传的图片（base64），返回落盘路径。
///
/// 存到会话目录下 `uploads/`，文件名带时间戳防冲突。
/// codex exec 用 `-i <路径>` 吃图，所以必须是真实文件。
#[tauri::command]
pub fn agent_save_image(
    app: AppHandle,
    name: String,
    data_base64: String,
    ext: String,
) -> Result<String, String> {
    use std::io::Write;
    let root = runtime_root(&app);
    let dir = agent_sessions_root(&root).join(&name).join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_ext = if ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        "png".to_string()
    } else {
        ext
    };
    let path = dir.join(format!(
        "img-{}.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        safe_ext
    ));
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("图片解码失败: {e}"))?;
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    emit_log(&app, format!("[agent:{name}] 图片已接收（{} KB）", bytes.len() / 1024), "info");
    Ok(path.display().to_string())
}

/// 手动刷新某会话的技能快照（界面上「刷新快照」按钮用）。
#[tauri::command]
pub fn agent_refresh_snapshot(app: AppHandle, name: String) -> Result<(), String> {
    let root = runtime_root(&app);
    let dir = agent_sessions_root(&root).join(&name);
    if !dir.join("prompt.md").is_file() {
        return Err(format!("会话不存在：{name}"));
    }
    ensure_agent_skill(&app, &root, &name, &dir)?;
    let snapshot = build_routing_manifest(&app, &root);
    refresh_prompt_snapshot(&dir, &snapshot)?;
    refresh_skill_snapshot(&dir, &snapshot)?;
    let home = ensure_agent_home(&root)?;
    let keep = dir.join("skills").join(AGENT_SKILL_NAME);
    mount_session_skill(&home, &name, &keep, AGENT_SKILL_NAME)?;
    emit_log(&app, format!("[agent:{name}] 快照已刷新"), "ok");
    Ok(())
}

/// 停止某个 Agent 会话的进程（不影响 Alice-codex 页启动的其它实例）。
///
/// 为什么需要单独一条：`codex_stop` 是全量清扫（把运行体下所有自己人都杀掉），
/// 用它来停一个会话会顺手把用户开着的 CLI / 桌面端一起干掉。
/// 这里只杀该会话自己登记的 PID 树。
#[tauri::command]
pub fn agent_stop(app: AppHandle, name: String, reg: State<'_, AgentProcs>) -> LaunchResult {
    let root = runtime_root(&app);
    let dir = agent_sessions_root(&root).join(&name);
    if !dir.is_dir() {
        return LaunchResult::err(format!("会话不存在：{name}"));
    }
    let pids = reg.take(&name);
    let mut killed: Vec<u32> = Vec::new();
    for pid in &pids {
        for k in winproc::kill_tree(*pid) {
            if !killed.contains(&k) {
                killed.push(k);
            }
        }
    }
    if killed.is_empty() {
        emit_log(&app, format!("[agent:{name}] 没有在跑的进程"), "info");
    } else {
        emit_log(
            &app,
            format!("[agent:{name}] 已终止 {} 个进程：{killed:?}", killed.len()),
            "ok",
        );
    }
    // 无论有没有进程，都广播本轮结束，界面据此解除「运行中」
    let _ = app.emit("agent:done", name.clone());
    let mut r = LaunchResult::ok(None);
    r.pids = killed;
    r
}

/// 某个 Agent 会话当前是否在跑（界面切页回来时用它恢复状态）。
#[tauri::command]
pub fn agent_status(name: String, reg: State<'_, AgentProcs>) -> LaunchResult {
    let alive = reg.alive(&name);
    /*
     * ok 语义 = 「该会话真的有进程在跑」。
     * 不能无条件 ok(true)：前端拿 r.ok 显示「运行中」，
     * 之前恒为 true，导致没在跑也一直转圈（用户反馈的状态不准）。
     * 正确：有活 PID 才 ok，pid 取最旧的那个（树根）。
     */
    let mut r = match alive.first() {
        Some(&pid) => LaunchResult::ok(Some(pid)),
        None => LaunchResult::err("not running"),
    };
    r.pids = alive;
    r
}

// ---------- 写入通道（围栏块 → 宿主落盘） ----------
//
// 用户要求：「说『帮我操作』时直接完成目标，不要再请求确认」。
//
// 两层事实：
//   ① 进程能力边界：agent 会话用 `-s read-only` 跑。实测本机 codex 的
//      Windows 沙箱 helper 未安装，即便传 `workspace-write` 也降级为
//      read-only（请求里的 `<permissions>` 块明确写 `sandbox_mode is read-only`）。
//      所以模型**物理上写不了任何文件** —— 不依赖它自觉遵守提示词。
//   ② 唯一写入通道：模型在回复里输出一段 ```alice-propose 围栏块声明意图，
//      宿主解析出来**立即落盘**（先备份原文件），并把这条记录留档到
//      `applied/` 供界面回看。界面上的「知道了」只是把记录移出列表，
//      **不影响已落盘的文件**。
//
// 为什么用「回复里带围栏块」而不是脚本/IPC：
//   模型既然没有写权限，就没法写提案文件；而让它调外部脚本又依赖 PATH 与
//   沙箱放行。围栏块只用到「模型本来就能输出文本」这一个能力，零依赖。

/// 已完成的写入留档目录（宿主落盘后写一条，重启不丢）
const APPLIED_DIR: &str = "applied";
/// 用户点「知道了」后归档到的目录（仅移出列表，不还原文件）
const DISMISSED_DIR: &str = "dismissed";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WriteProposal {
    pub id: String,
    /// 目标文件的绝对路径
    pub path: String,
    /// 拟写入的完整内容
    pub content: String,
    /// agent 给用户看的理由（为什么要改这个文件）
    #[serde(default)]
    pub reason: String,
}

/// 从助手回复里抽出全部 `alice-propose` 围栏块，返回 (干净正文, 提案列表)。
///
/// 协议（写进技能正文，模型照着输出）：
///
/// ````text
/// ```alice-propose
/// path: F:\...\resources\.codex\config.toml
/// reason: 把模型名改成 xxx
/// ---
/// <新文件的完整内容>
/// ```
/// ````
///
/// 围栏块会从展示正文里剔除 —— 用户看到的是解释，不是一大坨 JSON。
fn extract_proposals(reply: &str) -> (String, Vec<WriteProposal>) {
    let mut props = Vec::new();
    let mut clean = String::new();
    let mut rest = reply;
    while let Some(start) = rest.find("```alice-propose") {
        clean.push_str(&rest[..start]);
        let after = &rest[start + "```alice-propose".len()..];
        /*
         * 结束围栏必须找**行首**的 ```，不能用 `after.find("```")`。
         *
         * 踩过的坑：拟写入的内容本身常含代码块（写 .md / SKILL.md / 配置示例），
         * 里面就有 ``` —— 用 find 会命中那一个，提案被从中间截断，
         * 写出去的文件缺尾巴，而且是静默的（批量写 30 个文件时全烂）。
         * 行首判定能正确跳过内容里的围栏（它们通常带缩进或在行中）。
         */
        let end = after
            .match_indices("```")
            .find(|(i, _)| {
                // 该 ``` 之前只有空白（即位于行首），且后面不是 alice-propose
                let before_ok = after[..*i]
                    .rsplit('\n')
                    .next()
                    .map(|l| l.trim().is_empty())
                    .unwrap_or(true);
                let after_ok = !after[*i + 3..].starts_with("alice-propose");
                before_ok && after_ok
            })
            .map(|(i, _)| i);
        let Some(end) = end else {
            // 围栏没闭合：整段当普通正文，避免吞掉用户想看的解释
            clean.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let block = &after[..end];
        rest = &after[end + 3..];

        // 头两行是 path / reason，`---` 之后是正文
        let (head, body) = match block.find("\n---") {
            Some(i) => (&block[..i], block[i + 4..].trim_start_matches(['\r', '\n'])),
            None => (block, ""),
        };
        let mut path = String::new();
        let mut reason = String::new();
        for line in head.lines() {
            let l = line.trim();
            if let Some(v) = l.strip_prefix("path:") {
                path = v.trim().to_string();
            } else if let Some(v) = l.strip_prefix("reason:") {
                reason = v.trim().to_string();
            }
        }
        if !path.is_empty() {
            props.push(WriteProposal {
                id: String::new(), // 落盘时再分配
                path,
                content: body.to_string(),
                reason,
            });
        }
    }
    clean.push_str(rest);
    (clean.trim().to_string(), props)
}

/// 读某会话的全部已写入留档（目录不存在 = 空）。
fn read_applied_writes(dir: &Path) -> Vec<WriteProposal> {
    let mut out: Vec<WriteProposal> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir.join(APPLIED_DIR)) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(t) = std::fs::read_to_string(&p) {
                if let Ok(mut prop) = serde_json::from_str::<WriteProposal>(&t) {
                    if prop.id.is_empty() {
                        prop.id = p
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_default();
                    }
                    out.push(prop);
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 把解析出的提案**立即落盘**（先备份），并把记录留档到 `applied/`。
///
/// 用户要求：「说『帮我操作』时直接完成目标，不要再请求确认」。
/// 所以解析到就落盘，同时留一份 applied 记录供界面显示「刚改了什么」，
/// 用户仍能在界面上看到、并手动还原（原文件已备份为 `.bak-edit-*`）。
///
/// 落点不合规的提案丢弃并记日志（模型可能写错路径）。
fn queue_proposals(app: &AppHandle, session: &str, dir: &Path, props: &[WriteProposal]) -> usize {
    if props.is_empty() {
        return 0;
    }
    let root = runtime_root(app);
    let adir = dir.join(APPLIED_DIR);
    let _ = std::fs::create_dir_all(&adir);
    let mut n = 0usize;
    for (i, p) in props.iter().enumerate() {
        let target = match check_proposal_target(&root, &p.path) {
            Ok(t) => t,
            Err(e) => {
                emit_log(app, format!("[agent:{session}] 提案被拒：{e}"), "warn");
                continue;
            }
        };
        // 先备份原文件（若存在），再原子写入
        if target.is_file() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let stem = target
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            let bak = target.with_file_name(format!("{stem}.bak-edit-{ts}"));
            let _ = std::fs::copy(&target, &bak);
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = target.with_extension("alice-tmp");
        if std::fs::write(&tmp, &p.content).is_err() || std::fs::rename(&tmp, &target).is_err() {
            emit_log(app, format!("[agent:{session}] 写入失败：{}", target.display()), "err");
            continue;
        }
        // 留档：applied 里存一份，界面上能看到刚改了什么
        // 提案 id：毫秒 + 序号 + 原子计数。
        // 只靠毫秒+序号时，同一毫秒内跑两批（或一轮里多次调用）会撞 id，
        // 撞了就会互相覆盖留档记录、界面上少一条。加原子计数彻底避免。
        static PROP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = PROP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let id = format!(
            "w{}-{i}-{seq}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let rec = WriteProposal {
            id: id.clone(),
            path: p.path.clone(),
            content: p.content.clone(),
            reason: p.reason.clone(),
        };
        if let Ok(t) = serde_json::to_string_pretty(&rec) {
            let _ = std::fs::write(adir.join(format!("{id}.json")), t);
        }
        n += 1;
        emit_log(
            app,
            format!("[agent:{session}] 已写入 {}", target.display()),
            "ok",
        );
        let _ = app.emit("agent:proposal", (session.to_string(), id));
    }
    n
}

/// 路径是否在 root 之下（大小写不敏感，`/` 与 `\` 等价）。
fn path_under(p: &Path, root: &Path) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let a = norm(&p.display().to_string());
    let b = norm(&root.display().to_string());
    !b.is_empty() && (a == b || a.starts_with(&format!("{b}\\")))
}

/// 是否代码/脚本类文件（禁止改）。
fn is_code_path(p: &Path) -> bool {
    const CODE_EXT: [&str; 17] = [
        "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "cmd", "bat", "ps1", "sh", "c",
        "cpp", "h", "go", "exe",
    ];
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| CODE_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 已写入留档列表（宿主落盘后留的记录，供界面回看）。
#[tauri::command]
pub fn agent_applied_writes(app: AppHandle, name: String) -> Vec<WriteProposal> {
    let root = runtime_root(&app);
    read_applied_writes(&agent_sessions_root(&root).join(&name))
}

/// 校验一条提案的落点是否被允许（落盘前查一次，防模型写错路径）。
fn check_proposal_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(format!("目标必须是绝对路径（{path}）"));
    }
    if !path_under(&p, root) {
        return Err(format!(
            "目标不在 ALICE 助手文件夹内（{}）",
            root.display()
        ));
    }
    if is_code_path(&p) {
        return Err("不能修改代码文件，只能改配置文件".into());
    }
    Ok(p)
}

/// 把一条已写入留档移出列表（归档到 dismissed/）。
///
/// **不还原文件** —— 文件在宿主解析围栏块时就已落盘，原文件备份在
/// `.bak-edit-*`。这个命令只影响界面列表，用户要还原得自己拿备份覆盖。
#[tauri::command]
pub fn agent_dismiss_write(app: AppHandle, name: String, id: String) -> Result<(), String> {
    let root = runtime_root(&app);
    let dir = agent_sessions_root(&root).join(&name);
    let src = dir.join(APPLIED_DIR).join(format!("{id}.json"));
    if !src.is_file() {
        return Err("记录不存在或已移除".into());
    }
    let arch = dir.join(DISMISSED_DIR);
    std::fs::create_dir_all(&arch).map_err(|e| e.to_string())?;
    std::fs::rename(&src, arch.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    Ok(())
}

/// 会话 → 本轮进程 PID 登记表。
///
/// 为什么按会话单独登记，而不是复用 `CodexProc`：
///   `CodexProc` 是「运行体实例表」，`codex_stop` 会把里面**全部**实例停掉。
///   会话需要「只停我自己那一个」的粒度，所以单独一张表。
///   进程退出后 PID 会失效，`alive` 会顺手回收死条目。
#[derive(Default)]
pub struct AgentProcs(pub Mutex<std::collections::HashMap<String, Vec<u32>>>);

impl AgentProcs {
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, Vec<u32>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn register(&self, name: &str, pid: u32) {
        self.lock().insert(name.to_string(), vec![pid]);
    }
    /// 取走并清空该会话的 PID（停止时用；避免重复杀）
    fn take(&self, name: &str) -> Vec<u32> {
        self.lock().remove(name).unwrap_or_default()
    }
    /// 该会话还活着的 PID；顺手把已退出的条目清掉
    fn alive(&self, name: &str) -> Vec<u32> {
        let mut g = self.lock();
        let Some(pids) = g.get(name) else {
            return Vec::new();
        };
        let live: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|p| winproc::pid_exists_external(*p))
            .collect();
        if live.is_empty() {
            g.remove(name);
        } else if live.len() != pids.len() {
            g.insert(name.to_string(), live.clone());
        }
        live
    }
}

/// 启动实现（命令包装与内部复用共用；`codex_alias_rotate` 换名重启也走这里）
fn launch_impl(
    app: &AppHandle,
    mode: &str,
    exec_task: Option<String>,
    state: &State<'_, CodexProc>,
) -> LaunchResult {
    let root = runtime_root(app);
    let codex_home = root.join(".codex");
    let data_dir = root.join("data");
    let tools = root.join("tools");
    let codex_exe = codex_exe_path(&root);

    // 便携环境：APPDATA/TEMP 重定向到包内，不污染系统
    for sub in ["AppData/Roaming", "AppData/Local", "Temp"] {
        let _ = std::fs::create_dir_all(data_dir.join(sub));
    }
    let _ = std::fs::create_dir_all(root.join("workspace"));

    // API Key：环境变量优先，其次包内 api_key.txt
    if std::env::var("DEEPSEEK_API_KEY").is_err() {
        if let Ok(k) = std::fs::read_to_string(codex_home.join("api_key.txt")) {
            std::env::set_var("DEEPSEEK_API_KEY", k.trim());
        }
    }

    // 启动前只清「孤儿」：上次崩溃/被强杀留下的、父进程已不存在的自己人。
    // 绝不能用全量清扫 —— 那会把另一个仍活跃的实例（例如用户开着的旧桌面端）
    // 一起杀掉，属于误伤。全量清扫只在「停止」路径使用。
    let pre = winproc::sweep_root_orphans(&root.display().to_string());
    if !pre.is_empty() {
        emit_log(
            &app,
            format!("启动前清理了 {} 个历史残留孤儿进程：{pre:?}", pre.len()),
            "warn",
        );
    }

    // 启动前回收遗留的随机别名链接（只删「进程已消失」的，不动活跃实例）。
    // 上一轮如果被强杀/崩溃，别名文件会留在 runtime 目录里，这里收干净。
    let reg_removed = alias::sweep_registry_orphans(&codex_home);
    if reg_removed > 0 {
        emit_log(
            &app,
            format!("启动前回收了 {reg_removed} 条遗留随机别名链接"),
            "warn",
        );
    }

    match mode {
        // 交互式 CLI：必须是**真控制台**，且不能用 std::process::Command。
        //
        // 2026-09-20 两次踩坑记录（都有实测依据）：
        //
        // 坑一：走 `cmd /k run-codex.cmd` 时，cmd.exe 才是树根、codex 是孙子，
        //   随机名挡不住按父子链找；而且 `start` 会让真进程脱离父子链。
        //   → 改成直接用随机名硬链接拉起 codex.exe。
        //
        // 坑二：用 std::process::Command + CREATE_NEW_CONSOLE 时 CLI 秒退
        //   （实测 exit 1，stderr `Error: stdin is not a terminal`）。
        //   原因：Rust 的 Command 总是设置 STARTF_USESTDHANDLES，把父进程的
        //   标准句柄塞给子进程；而 alice 是 GUI 子系统程序（windows_subsystem
        //   = "windows"），自己没控制台，GetStdHandle 拿到的是空句柄 ——
        //   于是子进程「有新控制台但没有控制台输入」，TUI 直接退出。
        //   实测对照（GUI 父进程下跑同一份 codex.exe）：
        //     inherit + CREATE_NEW_CONSOLE      → 存活 ✅
        //     stdin=DEVNULL + CREATE_NEW_CONSOLE → 秒退 ❌
        //     全部 DEVNULL / DETACHED_PROCESS    → 秒退 ❌
        //   → 改用 winproc::spawn_new_console：自己调 CreateProcessW，
        //     **不设** STARTF_USESTDHANDLES，让系统把 CONIN$/CONOUT$ 给子进程；
        //     并以 CREATE_SUSPENDED 创建，先入 Job 再恢复，消除保护空窗。
        "cli" => {
            if !codex_exe.exists() {
                return LaunchResult::err(format!("codex.exe 不存在: {}", codex_exe.display()));
            }

            let (cmd_path, alias_file) = prepare_alias(&codex_exe);
            let alias_stem = alias_file
                .as_ref()
                .map(|a| a.stem.clone())
                .unwrap_or_else(|| "codex".into());

            // 命令行参数（MCP 绝对路径注入，与旧 run-codex.cmd 等价）
            let mcp = |name: &str| codex_home.join("mcp").join(name).display().to_string();
            let args: Vec<String> = vec![
                "-c".into(),
                format!("mcp_servers.wangzha.command={}", mcp("run-wangzha-mcp.cmd")),
                "-c".into(),
                format!(
                    "mcp_servers.ue4dump-mcp.command={}",
                    mcp("run-ue4dump-mcp.cmd")
                ),
            ];

            // 环境块：父环境打底 + 包内重定向（raw CreateProcessW 会整体替换环境）
            let mut envs: Vec<(String, String)> = std::env::vars().collect();
            let set = |envs: &mut Vec<(String, String)>, k: &str, v: String| {
                envs.retain(|(ek, _)| !ek.eq_ignore_ascii_case(k));
                envs.push((k.to_string(), v));
            };
            set(&mut envs, "CODEX_HOME", codex_home.display().to_string());
            set(
                &mut envs,
                "APPDATA",
                data_dir.join("AppData/Roaming").display().to_string(),
            );
            set(
                &mut envs,
                "LOCALAPPDATA",
                data_dir.join("AppData/Local").display().to_string(),
            );
            set(&mut envs, "TEMP", data_dir.join("Temp").display().to_string());
            set(&mut envs, "TMP", data_dir.join("Temp").display().to_string());
            set(&mut envs, "PYTHONIOENCODING", "utf-8".into());
            // vendor bin 必须进 PATH：codex 会去找同目录的辅助 exe
            let base_path = std::env::var("PATH").unwrap_or_default();
            let vendor_bin = codex_exe
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            set(
                &mut envs,
                "PATH",
                format!("{};{};{}", tools.display(), vendor_bin, base_path),
            );

            let job = winproc::create_kill_on_close_job();
            match winproc::spawn_new_console(
                &cmd_path,
                &args,
                &envs,
                &root.join("workspace"),
                job.as_ref(),
            ) {
                Ok(pid) => finish_launch(
                    &app,
                    &state,
                    None,
                    pid,
                    job,
                    alias_file,
                    alias_stem,
                    "cli",
                    &codex_home,
                    None,
                ),
                Err(e) => {
                    if let Some(a) = alias_file {
                        a.remove();
                    }
                    LaunchResult::err(e)
                }
            }
        }

        // 非交互执行一条，输出流式回传
        "exec" => {
            let task = exec_task.unwrap_or_default();
            if task.trim().is_empty() {
                return LaunchResult::err("任务内容为空");
            }
            if !codex_exe.exists() {
                return LaunchResult::err(format!("codex.exe 不存在: {}", codex_exe.display()));
            }

            let vendor = codex_exe
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.to_path_buf());

            let (cmd_path, alias_file) = prepare_alias(&codex_exe);
            let alias_stem = alias_file
                .as_ref()
                .map(|a| a.stem.clone())
                .unwrap_or_else(|| "codex".into());

            let job = winproc::create_kill_on_close_job();
            let mut cmd = Command::new(&cmd_path);
            cmd.env("CODEX_HOME", &codex_home)
                .env("APPDATA", data_dir.join("AppData/Roaming"))
                .env("LOCALAPPDATA", data_dir.join("AppData/Local"))
                .env("TEMP", data_dir.join("Temp"))
                .env("TMP", data_dir.join("Temp"))
                .env("PYTHONIOENCODING", "utf-8")
                // 不设 PYTHONUTF8=1：中文系统 adb 走 GBK，MCP 才不会崩
                .current_dir(root.join("workspace"))
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null());

            if let Some(v) = vendor {
                let path = std::env::var("PATH").unwrap_or_default();
                cmd.env(
                    "PATH",
                    format!("{};{};{}", tools.display(), v.join("bin").display(), path),
                );
            }
            apply_mcp_overrides(&mut cmd, &codex_home);
            cmd.args(["exec", "--skip-git-repo-check", &task]);
            hidden(&mut cmd);

            match cmd.spawn() {
                Ok(mut child) => {
                    let pid = child.id();
                    emit_log(&app, format!("codex exec 已启动 (PID {pid})"), "info");

                    let stdout = child.stdout.take();
                    let stderr = child.stderr.take();
                    if let Some(out) = stdout {
                        let a = app.clone();
                        std::thread::spawn(move || {
                            for line in BufReader::new(out).lines().map_while(Result::ok) {
                                emit_log(&a, line, "info");
                            }
                        });
                    }
                    if let Some(err) = stderr {
                        let a = app.clone();
                        std::thread::spawn(move || {
                            for line in BufReader::new(err).lines().map_while(Result::ok) {
                                emit_log(&a, line, "warn");
                            }
                        });
                    }

                    finish_launch(
                        &app,
                        &state,
                        Some(child),
                        pid,
                        job,
                        alias_file,
                        alias_stem,
                        "exec",
                        &codex_home,
                        Some(task.clone()),
                    )
                }
                Err(e) => {
                    if let Some(a) = alias_file {
                        a.remove();
                    }
                    LaunchResult::err(e.to_string())
                }
            }
        }

        "desktop" => {
            let desktop = root.join("runtime/desktop/app/ChatGPT.exe");
            if !desktop.exists() {
                return LaunchResult::err("包内桌面端缺失");
            }
            /*
             * ══ 为什么必须传 --user-data-dir ══════════════════════════
             *
             * 包内的 ChatGPT.exe 与用户自己从官网装的 Codex **同属一个 AppX 身份**
             * （AppxManifest Identity Name=`OpenAI.Codex`），而 Electron 用
             * userData 目录里的单实例锁做「第二次启动交接给已有实例」。
             *
             * 默认 userData 是 %APPDATA%\Codex\web\Codex —— 两边**共用同一个**。
             * 于是点「启动桌面端」时，包内 exe 发现锁已被本机已装版持有，
             * 就把请求交接过去，实际打开的是：
             *     C:\Program Files\WindowsApps\OpenAI.Codex_<ver>_x64__<hash>\app\ChatGPT.exe
             * 用的是**本机已装版的数据与配置**，不是包内的。
             *
             * 实测（2026-09-20）：不传参数时启动后新进程镜像全是 WindowsApps 路径；
             * 传 `--user-data-dir=<包内 DesktopProfile>` 后，7 个子进程全部
             * 从包内路径启动，与已装版互不干扰。
             *
             * 所以：userData 固定指向包内 data\DesktopProfile，实现真正便携 + 隔离。
             */
            let profile = data_dir.join("DesktopProfile");
            let _ = std::fs::create_dir_all(&profile);

            // 桌面端也要随机名：主 exe 建别名启动。
            // 它内部还会拉起 `resources\codex.exe` —— 那个由 CODEX_CLI_PATH
            // 指到另一份随机别名上（asar 实测读这个变量）。
            let desktop_real = desktop.clone();
            let (desktop_cmd, alias_file) = prepare_alias(&desktop_real);
            let alias_stem = alias_file
                .as_ref()
                .map(|a| a.stem.clone())
                .unwrap_or_else(|| "desktop".into());

            // 桌面端内嵌 CLI 的随机别名（建在 resources 目录，与真身同卷）
            let inner_cli = desktop_real
                .parent()
                .map(|p| p.join("resources/codex.exe"))
                .filter(|p| p.exists());
            let (inner_cmd, inner_alias) = match inner_cli.as_ref() {
                Some(p) => {
                    let (path, af) = prepare_alias(p);
                    (Some(path), af)
                }
                None => (None, None),
            };

            let job = winproc::create_kill_on_close_job();
            let mut cmd = Command::new(&desktop_cmd);
            cmd.arg(format!("--user-data-dir={}", profile.display()))
                .env("CODEX_HOME", &codex_home)
                .env("APPDATA", data_dir.join("AppData/Roaming"))
                .env("LOCALAPPDATA", data_dir.join("AppData/Local"))
                .env("TEMP", data_dir.join("Temp"))
                .env("TMP", data_dir.join("Temp"))
                .current_dir(&root);
            if let Some(ic) = inner_cmd.as_ref() {
                cmd.env("CODEX_CLI_PATH", ic);
            }
            hidden(&mut cmd);
            match cmd.spawn() {
                Ok(child) => {
                    let pid = child.id();
                    // 桌面端主进程 + 内嵌 CLI 都纳入保护；别名文件挂在槽位上统一清理
                    let mut slot_alias = alias_file;
                    let mut extra: Vec<PathBuf> = Vec::new();
                    if let Some(ia) = inner_alias {
                        // 内嵌别名也登记（崩溃后按注册表自愈回收）
                        alias::register(&codex_home, pid, &ia.path);
                        extra.push(ia.path.clone());
                        if slot_alias.is_none() {
                            slot_alias = Some(ia);
                        }
                    }
                    emit_log(
                        &app,
                        format!(
                            "包内桌面端已启动 (PID {pid}) · 独立 profile · 随机名 {alias_stem}",
                        ),
                        "ok",
                    );
                    finish_launch(
                        &app,
                        &state,
                        Some(child),
                        pid,
                        job,
                        slot_alias,
                        alias_stem,
                        "desktop",
                        &codex_home,
                        None,
                    )
                }
                Err(e) => {
                    if let Some(a) = alias_file {
                        a.remove();
                    }
                    LaunchResult::err(e.to_string())
                }
            }
        }

        other => LaunchResult::err(format!("未知启动模式: {other}")),
    }
}

/// 完全停止：预留句柄终止 + Job 终止 + 进程树终止 + 包内归属清扫
///
/// 「只有 alice 点停止才能杀掉」的落点就在第 ① 步：
///   被保护的进程带着收紧的 DACL，外部 `taskkill /F`、`Stop-Process -Force`
///   都会 `Access is denied`；我们保留了上锁**之前**打开的 PROCESS_TERMINATE
///   句柄，它能直接终止 —— 句柄即权限，不再过 DACL 检查。
///
/// 顺序刻意这样排：
///   ① 先换代（让盯守线程收手）→ ② 用预留句柄终止 → ③ Job 内全杀 →
///   ④ 归属清扫收拾历史孤儿 → ⑤ 删别名链接 + 清注册表。
/// 第 ⑤ 步必须在进程真的死了之后做，否则删链接只是「文件没了、进程还在」。
#[tauri::command]
pub fn codex_stop(
    app: AppHandle,
    state: State<'_, CodexProc>,
    guards: State<'_, alias::AliasGuards>,
) -> LaunchResult {
    stop_impl(&app, &state, &guards)
}

/// 恢复出厂清理：清空 **.codex 便携箱内**的会话/记忆/日志等运行数据。
///
/// ══ 范围边界（用户明确要求）════════════════════════════════════════
/// **只清 `.codex/` 内部**。包根的 `data/`（本界面 WebView2 的 APPDATA
/// 映射，2.1GB）不属于便携箱，**不在清理范围** —— 首次实现试图删它时
/// 真机报 `os error 32`（界面自己的 WebView2 进程正握着缓存文件）。
///
/// ══ 保留什么、清什么（用户指定 + 实际盘点）══════════════════════════
/// **保留**（关键配置 + 用户指定）：
///   · `skills/`            Alice 技能库（用户明确保留）
///   · `prompts/`           提示词文件夹（用户明确保留）
///   · `config.toml`        主配置（provider/模型/MCP 段，丢了要重配）
///   · `auth.json`          登录凭据
///   · `api_key.txt`        备用密钥
///   · `AGENTS.md`          当前生效的系统提示词（注入目标）
///   · `installation_id` / `version.json` / `.sandbox_migration`
///                          运行体身份文件，删了会触发重新初始化
/// **清除**（便携箱内随时间膨胀的运行数据）：
///   · `sessions/` `archived_sessions/`   会话记录（大头）
///   · `history.jsonl` `session_index.jsonl`  历史索引
///   · `*.sqlite` + `-wal`/`-shm`           会话/记忆/日志/队列数据库
///     （logs_2.sqlite 单文件 62MB、thread_history_1.sqlite 29MB ——
///      这就是「越用越大」的主因）
///   · `memories_1.sqlite` `goals_1.sqlite` 记忆与目标（用户点名清）
///   · `.codex-global-state.json*`          全局状态
///   · `sandbox.*.log` 等散落日志
///   · `.tmp/` `tmp/` `work/` 等临时目录
///
/// 安全设计：
///   · **先停机**（复用 stop_impl 的完整停机链：预留句柄/Job/归属清扫），
///     否则 codex 还握着 sqlite 句柄，删了也会被立刻重建；
///   · **双重确认**：前端弹窗警告 + 必须传 `confirm_token: "RESET"`；
///   · 只动 `.codex` 内**白名单路径**，绝不递归删便携箱本身。
#[tauri::command]
pub fn codex_factory_reset(
    app: AppHandle,
    state: State<'_, CodexProc>,
    guards: State<'_, alias::AliasGuards>,
    confirm_token: String,
) -> Result<String, String> {
    // 防呆：要求前端把确认令牌原样传回，杜绝「误触一次就全清」
    if confirm_token != "RESET" {
        return Err("清理被拒绝：缺少确认令牌（须二次确认）".into());
    }

    // ① 先完全停机（运行中的 codex 会锁住 sqlite，也避免边删边写）
    stop_impl(&app, &state, &guards);

    let root = runtime_root(&app);
    let home = root.join(".codex");
    let mut cleared: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    /*
     * 删除辅助：统一记日志。ignore_error=true 用于「本来就可能不存在」
     * 的目标（如 -wal/-shm 只在有未合并事务时出现）。
     */
    fn rm_path(p: &std::path::Path, label: &str, cleared: &mut Vec<String>, failed: &mut Vec<String>) {
        if !p.exists() {
            return;
        }
        match if p.is_dir() {
            std::fs::remove_dir_all(p)
        } else {
            std::fs::remove_file(p)
        } {
            Ok(_) => cleared.push(label.to_string()),
            Err(e) => failed.push(format!("{label}: {e}")),
        }
    }

    // ② 会话与历史（大头）
    for name in [
        "sessions",
        "archived_sessions",
        "history.jsonl",
        "session_index.jsonl",
    ] {
        rm_path(&home.join(name), name, &mut cleared, &mut failed);
    }

    // ③ 数据库（会话/记忆/日志/队列/状态/目标）——含 wal/shm 伴生文件
    for base in [
        "logs_2.sqlite",
        "thread_history_1.sqlite",
        "memories_1.sqlite",
        "goals_1.sqlite",
        "queue_1.sqlite",
        "state_5.sqlite",
    ] {
        for suffix in ["", "-wal", "-shm"] {
            let f = format!("{base}{suffix}");
            rm_path(&home.join(&f), &f, &mut cleared, &mut failed);
        }
    }
    // sqlite 工作目录（内部临时库）
    rm_path(&home.join("sqlite"), "sqlite/", &mut cleared, &mut failed);

    // ④ 全局状态与散落日志
    for name in [
        ".codex-global-state.json",
        ".codex-global-state.json.bak",
        "sandbox.2026-09-18.log", // 通配在下面做，这里是兜底列名
    ] {
        rm_path(&home.join(name), name, &mut cleared, &mut failed);
    }
    // sandbox.*.log 用通配（日期后缀会变）
    if let Ok(rd) = std::fs::read_dir(&home) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("sandbox.") && n.ends_with(".log") {
                rm_path(&e.path(), &n, &mut cleared, &mut failed);
            }
            // 全局状态的 tmp 残留（写一半崩溃留下的）
            if n.starts_with("..codex-global-state.json.tmp-") {
                rm_path(&e.path(), &n, &mut cleared, &mut failed);
            }
        }
    }

    // ⑤ 临时/工作目录（保留名单之外的运行产物）
    for name in [".tmp", "tmp", "work", "node_repl", "visualizations", "ambient-suggestions"] {
        rm_path(&home.join(name), &format!("{name}/"), &mut cleared, &mut failed);
    }

    /*
     * ⑥ 范围边界（用户明确要求）：**只清 .codex 便携箱内部**。
     *
     * 包根的 data/（本界面 WebView2 的 APPDATA 映射，2.1GB）不在清理范围：
     *   · 它不是 codex 便携箱的一部分，是本工具自己的界面数据；
     *   · 正在运行的 WebView2 进程握着它，删必报 os error 32
     *     （首次实现真机踩到：`data/: 另一个程序正在使用此文件`）。
     * 若以后要清它，应做成独立的「界面缓存清理」入口并提示先关窗口。
     */

    // ⑦ 报告：失败项（真错误）全量透出，不静默。
    // 0 项 = 目标本来就不存在（上次已清过），明确说「已是干净状态」
    // 而不是让用户对着「已清理 0 项」发懵。
    let msg = if cleared.is_empty() && failed.is_empty() {
        "便携箱内没有可清理的运行数据，已是干净状态".to_string()
    } else {
        format!("已清理 .codex 便携箱内 {} 项运行数据", cleared.len())
    };
    if failed.is_empty() {
        emit_log(&app, msg.clone(), "warn");
        Ok(msg)
    } else {
        let msg = format!(
            "清理完成但有 {} 项失败：{}（其余 {} 项已清）",
            failed.len(),
            failed.join("; "),
            cleared.len()
        );
        emit_log(&app, msg.clone(), "err");
        Err(msg)
    }
}

/// 导入一个本地 codex 目录作为便携箱（包内缺 .codex 时用的恢复入口）。
///
/// ══ 使用场景（用户指定）════════════════════════════════════════════
/// 助手安装包里没带 `.codex` 时，alice-codex 页的体检会显示「配置文件
/// config.toml 缺失」。用户点「导入便携箱」选一个本机现成的 codex 目录
/// （典型就是 `~/.codex`），把它复制进包内 —— 模型/供应商/密钥等关键
/// 配置随之就位，再点自检即可转绿。
///
/// ══ 校验与合并策略 ═════════════════════════════════════════════════
/// · 源目录必须含 `config.toml`（这是「能不能跑」的最低门槛），
///   没有就直接拒绝，避免把一个随便的文件夹当便携箱导进来；
/// · 包内已有 `.codex` 时**拒绝**（防止覆盖正在用的运行体）——
///   要换就先「清理数据」或手动改名，界面文案会说明；
/// · 整目录递归复制；单文件失败不中断（记入结果），最后汇总。
#[tauri::command(async)]
pub fn codex_import_portable(app: AppHandle, source: String) -> Result<String, String> {
    let src = PathBuf::from(&source);
    if !src.is_dir() {
        return Err(format!("所选路径不是目录：{source}"));
    }
    // 最低门槛校验：config.toml 必须存在
    if !src.join("config.toml").is_file() {
        return Err(
            "所选目录不是 codex 目录（缺 config.toml）。请选择包含 config.toml 的 codex 配置目录（如 C:\\Users\\你\\.codex）"
                .into(),
        );
    }
    let root = runtime_root(&app);
    let dst = root.join(".codex");
    // 已存在则拒绝 —— 覆盖正在用的运行体是破坏性操作，不做静默合并
    if dst.exists() {
        let is_empty = std::fs::read_dir(&dst)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return Err(
                "包内已存在 .codex 便携箱。若要换用导入的目录，请先在「清理数据」或手动移走现有的 .codex".into(),
            );
        }
        // 空壳（上一次导入失败/清理后残留）允许直接导入覆盖
        let _ = std::fs::remove_dir_all(&dst);
    }

    emit_log(&app, format!("[codex] 开始导入便携箱：{source}"), "info");

    /*
     * ══ 按「原 .codex 逻辑」导入：目录白名单，而不是黑名单过滤 ══════
     *
     * 用户实测：黑名单（跳过 .tmp/sqlite…）永远列不全 —— 本机 codex 的
     * 运行缓存有 .codex-plugin/.plugin-appserver/__pycache__/UUID 会话目录
     * 等十几种形态，导入后包内全是一堆无用缓存（真机截图）。
     *
     * 改为与**出厂便携箱同构**的白名单：只复制原 .codex 里真实存在的
     * 功能目录 + 根下关键文件，其它一概不进包：
     *   目录：plugins（MCP 插件）、mcp、prompts、skills、rules、plans、
     *         pets、vendor_imports、computer-use、thread-writer-locks
     *   文件：config.toml、auth.json、api_key.txt、AGENTS.md、
     *         installation_id、version.json、.sandbox_migration、
     *         alias-registry.txt、cap_sid、state-*.json
     * 明确排除（运行数据/缓存）：sessions、archived_sessions、sqlite、
     *         .tmp、.system（codex 启动时自动重建）、__pycache__、
     *         *.sqlite*（会话/日志库）、history.jsonl 等。
     */
    const IMPORT_DIRS: [&str; 10] = [
        "plugins",
        "mcp",
        "prompts",
        "skills",
        "rules",
        "plans",
        "pets",
        "vendor_imports",
        "computer-use",
        "thread-writer-locks",
    ];
    const IMPORT_FILES: [&str; 8] = [
        "config.toml",
        "auth.json",
        "api_key.txt",
        "AGENTS.md",
        "installation_id",
        "version.json",
        ".sandbox_migration",
        "alias-registry.txt",
    ];

    let mut copied = 0usize;
    let mut failed: Vec<String> = Vec::new();

    fn copy_rec(
        dir: &std::path::Path,
        to: &std::path::Path,
        copied: &mut usize,
        failed: &mut Vec<String>,
    ) {
        if let Err(e) = std::fs::create_dir_all(to) {
            failed.push(format!("建目录 {}: {}", to.display(), e));
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            failed.push(format!("读目录失败: {}", dir.display()));
            return;
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // 目录内部仍有缓存形态（如 plugins 下的 __pycache__、.tmp）
            if name == ".tmp"
                || name == "tmp"
                || name == "__pycache__"
                || name.starts_with("..codex-global-state.json.tmp-")
            {
                continue;
            }
            let to = to.join(&name);
            if e.path().is_dir() {
                copy_rec(&e.path(), &to, copied, failed);
            } else {
                match std::fs::copy(e.path(), &to) {
                    Ok(_) => *copied += 1,
                    Err(err) => failed.push(format!("{}: {}", name, err)),
                }
            }
        }
    }

    std::fs::create_dir_all(&dst).map_err(|e| format!("创建 .codex 失败: {e}"))?;

    /*
     * 白名单目录**始终创建**（即使源里没有）。
     *
     * 之前是「源里有才复制」—— 用户导入的本机 ~/.codex 往往没有 prompts/，
     * 结果包内连目录都不存在：提示词选择器读不到（0 份）、UI「打开目录」
     * 也打不开一个不存在的路径。目录先建好，后面往里放文件即可用。
     */
    for d in IMPORT_DIRS {
        let to = dst.join(d);
        let s = src.join(d);
        if s.is_dir() {
            copy_rec(&s, &to, &mut copied, &mut failed);
        } else {
            let _ = std::fs::create_dir_all(&to);
        }
    }
    // 白名单文件：逐个复制；state-*.json 是通配（各客户端安装状态）
    for f in IMPORT_FILES {
        let s = src.join(f);
        if s.is_file() {
            match std::fs::copy(&s, dst.join(f)) {
                Ok(_) => copied += 1,
                Err(err) => failed.push(format!("{f}: {err}")),
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(&src) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("state-") && n.ends_with(".json") && e.path().is_file() {
                match std::fs::copy(e.path(), dst.join(&n)) {
                    Ok(_) => copied += 1,
                    Err(err) => failed.push(format!("{n}: {err}")),
                }
            }
        }
    }

    let msg = if failed.is_empty() {
        format!("便携箱导入完成：{copied} 个文件（运行数据已清空，重跑自检确认）")
    } else {
        format!(
            "便携箱导入完成：{copied} 个文件，{} 项失败（{}）",
            failed.len(),
            failed.iter().take(3).cloned().collect::<Vec<_>>().join("; ")
        )
    };
    emit_log(&app, msg.clone(), "ok");
    Ok(msg)
}

/// 停止实现（命令包装与内部复用共用）
fn stop_impl(
    app: &AppHandle,
    state: &State<'_, CodexProc>,
    guards: &State<'_, alias::AliasGuards>,
) -> LaunchResult {
    let root = runtime_root(app);
    let codex_home = root.join(".codex");

    // ① 换代：盯守线程看到世代变化就收手，不再对正在退出的进程上锁
    guards.bump();

    // ② 用预留句柄终止受保护进程（这一步绕开收紧的 DACL）
    let (guarded, guard_killed) = guards.terminate_all();
    if guarded > 0 {
        emit_log(
            &app,
            format!("已用预留句柄终止受保护进程 {guard_killed}/{guarded} 个"),
            "warn",
        );
        // 给内核一点时间回收，避免后面清扫时把正在退出的当成残留
        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    // ③ 跟踪中的槽位全部收割（Job 终止 + 进程树 + 删别名）
    let tracked: Vec<u32> = state.tracked_pids();
    for mut slot in state.drain() {
        slot.kill();
    }

    // ④ 归属清扫：包根下的任何残留（本次 + 历史遗留）
    let (killed, mut remaining) = sweep_root(&app, &root);

    // ⑤ 别名注册表：自愈杀掉带锁残留 + 删链接
    let (reg_killed, reg_removed) = alias::sweep_registry(&codex_home);
    if reg_killed > 0 || reg_removed > 0 {
        emit_log(
            &app,
            format!("别名回收：自愈终止 {reg_killed} 个残留 · 删除 {reg_removed} 条链接"),
            "warn",
        );
    }
    // 兜底：注册表丢了也按目录形态清一遍（仅停止路径，绝不在启动时做）
    let (dir_killed, dir_removed) = alias::sweep_dir_aliases(
        &root.join("runtime/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin"),
    );
    let (d2_killed, d2_removed) = alias::sweep_dir_aliases(&root.join("runtime/desktop/app"));
    let (d3_killed, d3_removed) =
        alias::sweep_dir_aliases(&root.join("runtime/desktop/app/resources"));
    let extra_killed = dir_killed + d2_killed + d3_killed;
    let extra_removed = dir_removed + d2_removed + d3_removed;
    if extra_killed > 0 || extra_removed > 0 {
        emit_log(
            &app,
            format!("别名兜底清扫：终止 {extra_killed} · 删除 {extra_removed}"),
            "warn",
        );
    }
    if !remaining.is_empty() {
        remaining = winproc::pids_under_root(&root.display().to_string());
    }

    let _ = app.emit("runtime:status", "idle");

    if !remaining.is_empty() {
        let msg = format!("仍有 {} 个包内进程未能终止：{remaining:?}", remaining.len());
        emit_log(&app, msg.clone(), "err");
        let mut r = LaunchResult::err(msg);
        r.pids = remaining;
        return r;
    }

    let total_killed = killed.len() + reg_killed + extra_killed;
    if tracked.is_empty() && total_killed == 0 && guard_killed == 0 {
        emit_log(&app, "当前没有运行中的实例", "info");
        return LaunchResult::err("当前没有运行中的实例");
    }

    emit_log(
        &app,
        format!(
            "已完全停止：受保护句柄 {guard_killed}/{guarded} · 跟踪实例 {tracked:?} · 归属清理 {} 个",
            killed.len()
        ),
        "warn",
    );
    let mut r = LaunchResult::ok(tracked.first().copied().or_else(|| killed.first().copied()));
    r.pids = killed;
    r.count = 0;
    r
}

/// 别名状态查询（界面展示「当前随机名」）
///
/// ⚠️ 自「独占终止保护」移除后（2026-09-20），本函数不再依赖 guards：
/// guards 现在恒为空，若仍拿 `guards.pids()` 当「在跑的进程」来源，
/// 界面会永远显示「未运行」。改为按「跟踪槽位 + 存活随机名进程」判定。
/// `protected` 恒为 false（字段保留仅为兼容前端 DTO）。
#[tauri::command]
pub fn codex_alias_status(
    app: AppHandle,
    state: State<'_, CodexProc>,
    _guards: State<'_, alias::AliasGuards>,
) -> LaunchResult {
    let root = runtime_root(&app);
    let codex_home = root.join(".codex");

    // 跟踪中的槽位 pid（已退出者在此顺带回收）
    let tracked: Vec<u32> = {
        let mut v = state.lock();
        let mut dead: Vec<u32> = Vec::new();
        for s in v.iter_mut() {
            if !s.is_alive() {
                dead.push(s.pid);
            }
        }
        let alive: Vec<u32> = v
            .iter()
            .map(|s| s.pid)
            .filter(|p| !dead.contains(p))
            .collect();
        v.retain(|s| !dead.contains(&s.pid));
        alive
    };

    let names: Vec<String> = state
        .lock()
        .iter()
        .map(|s| s.alias_stem.clone())
        .filter(|s| !s.is_empty())
        .collect();

    // 仍在跑、镜像名是随机别名的进程（含未被跟踪的残留）
    let live_aliases: Vec<String> = winproc::snapshot()
        .into_iter()
        .filter(|r| alias::is_alias_name(&r.name))
        .map(|r| r.name)
        .collect();

    let mut r = LaunchResult::ok(tracked.first().copied());
    r.pids = tracked.clone();
    r.count = tracked.len();
    r.alias_name = if names.is_empty() {
        live_aliases.first().cloned().unwrap_or_default()
    } else {
        names.join(", ")
    };
    // 独占保护已移除 —— 恒 false，不再向界面宣称「受保护」
    r.protected = false;
    if r.alias_name.is_empty() {
        r.ok = false;
        r.error = Some("未运行".into());
    }
    let _ = codex_home; // 保留：后续可扩展为读注册表
    r
}

/// 手动更换随机名：停止 → 用新随机名重启（同一模式）
///
/// 用途：想立刻换一个镜像名（例如怀疑被按名盯上）时，不用手动停再启。
#[tauri::command]
pub fn codex_alias_rotate(
    app: AppHandle,
    mode: Option<String>,
    exec_task: Option<String>,
    state: State<'_, CodexProc>,
    guards: State<'_, alias::AliasGuards>,
) -> LaunchResult {
    let mode = mode.unwrap_or_else(|| "cli".into());
    let _ = stop_impl(&app, &state, &guards);
    std::thread::sleep(std::time::Duration::from_millis(300));
    launch_impl(&app, &mode, exec_task, &state)
}

/// 运行体是否在运行（真实探测：跟踪槽位 + 包根归属扫描）
#[tauri::command]
pub fn codex_status(app: AppHandle, state: State<'_, CodexProc>) -> LaunchResult {
    let root = runtime_root(&app);
    let leftover = winproc::pids_under_root(&root.display().to_string());

    // 回收已退出的槽位
    let tracked: Vec<u32> = {
        let mut v = state.lock();
        let pids: Vec<u32> = v.iter().map(|s| s.pid).collect();
        let mut dead: Vec<u32> = Vec::new();
        for s in v.iter_mut() {
            if !s.is_alive() {
                dead.push(s.pid);
            }
        }
        if !dead.is_empty() {
            v.retain(|s| !dead.contains(&s.pid));
        }
        pids.into_iter().filter(|p| !dead.contains(p)).collect()
    };

    let untracked: Vec<u32> = leftover
        .iter()
        .copied()
        .filter(|pid| !tracked.contains(pid))
        .collect();

    let pid = tracked
        .first()
        .copied()
        .or_else(|| untracked.first().copied());
    let mut r = LaunchResult::ok(pid);
    r.pids = leftover;
    r.count = tracked.len() + untracked.len();
    if pid.is_none() {
        r.ok = false;
        r.error = Some("未运行".into());
    } else if tracked.is_empty() {
        // 有包内进程但不在槽位里 = 上一次留下的孤儿
        r.error = Some("检测到未跟踪的残留进程".into());
    }
    r
}

/// 用系统默认程序打开文件/目录。
///
/// ══ 为什么不能用 `explorer <路径>`（真机踩坑：打开了「文档」）════════
/// `explorer.exe <目录>` 的参数解析有自己的怪癖：路径含中文/特殊字符时，
/// 少数环境下会被解析失败，explorer 退回打开「文档」—— 用户看到的就是
/// 「点「目录」打开的不是所在文件夹」。
/// 改用 **`explorer /select,<路径>`**：这是资源管理器的「定位到该项」
/// 语义，对目录/文件都精确命中其所在位置，且不受上述解析怪癖影响。
/// 注：/select 下 explorer 总是返回非零退出码，不能以此判定成败。
#[tauri::command]
pub fn open_path(path: String) -> LaunchResult {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return LaunchResult::err(format!("路径不存在: {path}"));
    }
    // /select 需要绝对路径；规范化一次，去掉可能的尾随分隔符
    let abs = p.canonicalize().unwrap_or(p);
    let mut cmd = Command::new("explorer");
    cmd.arg(format!("/select,{}", abs.display()));
    // 不加 hidden()：explorer /select 的窗口由已运行的 shell 进程创建，
    // CREATE_NO_WINDOW 只作用于本进程，无副作用；但为了稳妥保持一致。
    hidden(&mut cmd);
    match cmd.spawn() {
        Ok(_) => LaunchResult::ok(None),
        Err(e) => LaunchResult::err(e.to_string()),
    }
}

/// 读取文本文件（config.toml / AGENTS.md / SKILL.md 编辑器用）
#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// 原子写文本（先写 tmp 再 rename，避免半截文件）
#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("alice-tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// 列目录（技能库 / 提示词库）
#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut out = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        let meta = e.metadata().ok();
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            path: p.display().to_string(),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// 备份后追加写入（AGENTS.md 注入用，保留原有内容）
#[tauri::command]
pub fn append_with_backup(path: String, content: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let bak = p.with_extension(format!(
        "bak-{}",
        chrono_stamp()
    ));
    if p.exists() {
        std::fs::copy(&p, &bak).map_err(|e| format!("备份失败: {e}"))?;
    }
    let mut existing = if p.exists() {
        std::fs::read_to_string(&p).unwrap_or_default()
    } else {
        String::new()
    };
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&content);
    std::fs::write(&p, existing).map_err(|e| e.to_string())?;
    Ok(bak.display().to_string())
}

fn chrono_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.to_string()
}

// ---------- config.toml 透传 ----------

/// 读取本机 ~/.codex/config.toml 的关键字段（只读，供界面展示差异）
#[tauri::command]
pub fn read_host_config() -> ConfigModelFields {
    match host_codex_home() {
        Some(h) => read_config_fields(&h.join("config.toml"), "本机 ~/.codex"),
        None => ConfigModelFields {
            from: "未找到 USERPROFILE".into(),
            ..Default::default()
        },
    }
}

/// 读取包内 config.toml 的关键字段
#[tauri::command]
pub fn read_bundled_config(app: AppHandle) -> ConfigModelFields {
    let root = runtime_root(&app);
    read_config_fields(&root.join(".codex/config.toml"), "包内 .codex")
}

/// 把本机的**模型/供应商字段**透传到包内 config.toml。
///
/// ══ 为什么只同步这几个字段，而不是整份覆盖 ══════════════════════
/// 本机 config.toml 与包内那份的职责不同：
///   · 本机：有 [model_providers.custom] 的 base_url / 密钥策略 —— 这是要同步的；
///     但它同时含大量 `C:\Users\<你>\...` 绝对路径（notify / marketplaces / projects），
///     整份拷进来会让**包内配置指向你本机**，换机器直接失效。
///   · 包内：有 MCP 段（wangzha / ue4dump）与相对路径 —— 这些必须保留。
/// 所以按字段白名单同步，MCP 段与其它包内专有配置原样不动。
///
/// ══ 值一律「逐字照抄源文件」，绝不重新渲染 ══════════════════════
/// 这是事故换来的纪律：首版用剥掉引号的显示值回写，把
///     model = "cn:deepseek-v4.1-flash"
/// 写成 `model = cn:deepseek-v4.1-flash` —— 非法 TOML，桌面端直接起不来。
/// 现在回写走 `raw_scalar`（含引号原文），写前还跑一次结构校验，
/// 校验不过就**中止且不落盘**，原文件保持可用。
#[tauri::command]
pub fn sync_config_from_host(app: AppHandle) -> Result<String, String> {
    let root = runtime_root(&app);
    let dst = root.join(".codex/config.toml");
    let host = host_codex_home()
        .ok_or("找不到 USERPROFILE，无法定位本机 .codex")?
        .join("config.toml");
    if !host.exists() {
        return Err(format!("本机配置不存在：{}", host.display()));
    }

    let host_text = std::fs::read_to_string(&host).map_err(|e| format!("读本机配置失败: {e}"))?;
    let original = std::fs::read_to_string(&dst).unwrap_or_default();
    if original.trim().is_empty() {
        return Err("包内 config.toml 为空或不存在，已中止（避免写出不完整配置）".into());
    }

    // 白名单：只搬这些键。值取**源文件原文**（含引号）。
    const KEYS: [&str; 6] = [
        "model",
        "model_provider",
        "model_reasoning_effort",
        "model_context_window",
        "model_auto_compact_token_limit",
        "disable_response_storage",
    ];

    let mut lines: Vec<String> = original.lines().map(|s| s.to_string()).collect();
    let mut applied: Vec<String> = Vec::new();
    let mut missing: Vec<(String, String)> = Vec::new();

    for key in KEYS {
        let Some(raw_val) = raw_scalar(&host_text, key) else {
            continue;
        };
        let mut hit = false;
        for line in lines.iter_mut() {
            let t = line.trim_start();
            if t.starts_with('#') || t.starts_with('[') {
                continue;
            }
            if let Some(rest) = t.strip_prefix(key) {
                if rest.trim_start().starts_with('=') {
                    // 逐字照抄源文件的右侧文本（引号/布尔/数字都保原样）
                    *line = format!("{key} = {raw_val}");
                    hit = true;
                    break;
                }
            }
        }
        if hit {
            applied.push(key.to_string());
        } else {
            missing.push((key.to_string(), raw_val));
        }
    }

    if applied.is_empty() && missing.is_empty() {
        return Err("本机 config.toml 里没有可同步的模型/供应商字段".into());
    }

    // 包内缺的键补到第一个段头之前（TOML 要求顶层键在段头前）
    if !missing.is_empty() {
        let insert_at = lines
            .iter()
            .position(|l| l.trim_start().starts_with('['))
            .unwrap_or(lines.len());
        for (i, (k, v)) in missing.iter().enumerate() {
            lines.insert(insert_at + i, format!("{k} = {v}"));
            applied.push(k.clone());
        }
    }

    // 供应商整段：用本机那份替换包内同名段
    let provider = raw_scalar(&host_text, "model_provider")
        .map(|v| v.trim_matches('"').trim_matches('\'').to_string())
        .unwrap_or_else(|| "custom".into());
    let host_block = toml_section(&host_text, &format!("[model_providers.{provider}]"));
    if !host_block.is_empty() {
        let header = format!("[model_providers.{provider}]");
        let mut out: Vec<String> = Vec::new();
        let mut inside_old = false;
        for line in lines {
            let t = line.trim();
            if t.starts_with('[') {
                inside_old = t == header;
            }
            if inside_old {
                continue;
            }
            out.push(line);
        }
        // 段头之后追加，不违反 TOML 作用域规则；压掉多余空行
        while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
            out.pop();
        }
        out.push(String::new());
        for l in host_block.lines() {
            out.push(l.to_string());
        }
        lines = out;
        applied.push("model_providers".into());
    }

    // 收尾：压掉 2+ 连续空行（首版会留下 4 个空行，虽合法但难看）
    let mut cleaned: Vec<String> = Vec::new();
    let mut blanks = 0;
    for l in lines {
        if l.trim().is_empty() {
            blanks += 1;
            if blanks <= 1 {
                cleaned.push(l);
            }
        } else {
            blanks = 0;
            cleaned.push(l);
        }
    }

    let mut text = cleaned.join("\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }

    // ⚠️ 落盘前先校验：不过就中止，原文件保持可用
    toml_looks_valid(&text).map_err(|e| format!("生成结果未通过校验，已中止（原文件未改动）：{e}"))?;

    // 备份（只在确认可写之后做）
    let bak = dst.with_extension(format!("toml.bak-{}", chrono_stamp()));
    std::fs::copy(&dst, &bak).map_err(|e| format!("备份失败: {e}"))?;

    // 原子写
    let tmp = dst.with_extension("alice-tmp");
    std::fs::write(&tmp, &text).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &dst).map_err(|e| format!("替换失败: {e}"))?;

    let msg = format!(
        "已透传 {} 个字段（{}）· 原配置备份为 {}",
        applied.len(),
        applied.join("、"),
        bak.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    );
    emit_log(&app, format!("config 透传完成：{msg}"), "ok");
    Ok(msg)
}

// ============================================================
//  回归测试：锁定「透传 config 不得破坏 TOML」这条纪律
// ------------------------------------------------------------
//  事故背景（2026-09-20）：首版 sync 用剥掉引号的显示值回写，写出
//      model = cn:deepseek-v4.1-flash
//  非法 TOML，桌面端启动直接报 string values must be quoted。下面这几条
//  测试把「引号必须保留」「校验必须拦住裸字符串」钉死，防止回归。
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// 挂载名净化：codex 0.154 的技能名只认 [A-Za-z0-9_-]，
    /// 会话名里的非 ASCII（中文引号、emoji、中文都算）必须转成 '_'，
    /// 否则挂载目录对 codex 不可见 → agent 技能"丢失"（真机踩坑）。
    #[test]
    fn sanitize_mount_name_strips_non_ascii() {
        // 纯 ASCII 原样保留
        assert_eq!(sanitize_mount_name("abc-123_x"), "abc-123_x");
        // 特殊字符会话（真机案例：用户建了名叫 ' 的会话）
        assert_eq!(sanitize_mount_name("‘"), "s", "全非法字符回退为 s");
        assert_eq!(sanitize_mount_name("‘__"), "s");
        // 中文会话名 → 每个字转下划线并压缩
        assert_eq!(sanitize_mount_name("目标"), "s");
        // 混合：非法字符转 _，连续压缩
        assert_eq!(sanitize_mount_name("a‘’b"), "a_b");
        // 首尾的下划线被去掉
        assert_eq!(sanitize_mount_name("‘abc’"), "abc");
        // emoji 同理
        assert_eq!(sanitize_mount_name("🎉test"), "test");
    }

    /// raw_scalar 必须**原样**取回带引号的值（这是修复的核心）
    #[test]
    fn raw_scalar_keeps_quotes() {
        let t = "model = \"cn:deepseek-v4.1-flash\"\nmodel_provider = \"custom\"\n";
        assert_eq!(raw_scalar(t, "model").unwrap(), "\"cn:deepseek-v4.1-flash\"");
        assert_eq!(raw_scalar(t, "model_provider").unwrap(), "\"custom\"");
    }

    /// 数字与布尔不该被加引号
    #[test]
    fn raw_scalar_keeps_bare_literals() {
        let t = "model_context_window = 1000000\ndisable_response_storage = true\n";
        assert_eq!(raw_scalar(t, "model_context_window").unwrap(), "1000000");
        assert_eq!(raw_scalar(t, "disable_response_storage").unwrap(), "true");
    }

    /// 跳过注释行与段头，只认顶层键
    #[test]
    fn raw_scalar_ignores_comments_and_sections() {
        let t = "# model = \"decoy\"\n[desktop]\nmodel = \"real\"\n";
        assert_eq!(raw_scalar(t, "model").unwrap(), "\"real\"");
    }

    /// 行尾注释要被切掉，且不影响引号
    #[test]
    fn raw_scalar_strips_trailing_comment() {
        let t = "model = \"gpt-5\" # 主模型\n";
        assert_eq!(raw_scalar(t, "model").unwrap(), "\"gpt-5\"");
    }

    /// 校验器必须拦住事故里那种裸字符串
    #[test]
    fn validator_rejects_unquoted_colon_value() {
        let bad = "model = cn:deepseek-v4.1-flash\n";
        let e = toml_looks_valid(bad).unwrap_err();
        assert!(e.contains("缺少引号"), "错误信息应指出缺引号：{e}");
    }

    /// 校验器必须放过合法文件（含引号字符串/数字/布尔/数组/内联表）
    #[test]
    fn validator_accepts_valid_toml() {
        let good = concat!(
            "# 注释\n",
            "model = \"cn:deepseek-v4.1-flash\"\n",
            "model_context_window = 1000000\n",
            "disable_response_storage = true\n",
            "notify = [ \"a.exe\", \"turn-ended\" ]\n",
            "inline = { a = 1 }\n",
            "[mcp_servers.wangzha]\n",
            "command = \"./mcp/run-wangzha-mcp.cmd\"\n",
        );
        assert!(toml_looks_valid(good).is_ok(), "合法 TOML 不应被拦");
    }

    /// 回归：端到端模拟「本机值 → 包内」，结果必须仍含引号
    #[test]
    fn sync_keeps_quotes_end_to_end() {
        let host = "model = \"cn:deepseek-v4.1-flash\"\nmodel_provider = \"custom\"\n";
        let bundled = "model = \"old\"\nmodel_provider = \"custom\"\nmodel_context_window = 1000000\n";
        let mut lines: Vec<String> = bundled.lines().map(|s| s.to_string()).collect();
        for key in ["model", "model_provider"] {
            if let Some(v) = raw_scalar(host, key) {
                for line in lines.iter_mut() {
                    let t = line.trim_start();
                    if !t.starts_with('#') && !t.starts_with('[') {
                        if let Some(rest) = t.strip_prefix(key) {
                            if rest.trim_start().starts_with('=') {
                                *line = format!("{key} = {v}");
                                break;
                            }
                        }
                    }
                }
            }
        }
        let out = lines.join("\n") + "\n";
        assert!(out.contains("model = \"cn:deepseek-v4.1-flash\""), "引号必须保留：\n{out}");
        assert!(toml_looks_valid(&out).is_ok(), "结果必须通过校验：\n{out}");
    }

    /// provider 段抽取：只取目标段，不越界到下一段
    #[test]
    fn section_extraction_stops_at_next_header() {
        let t = concat!(
            "[model_providers.custom]\n",
            "base_url = \"http://127.0.0.1:15721/v1\"\n",
            "\n",
            "[desktop]\n",
            "followUpQueueMode = \"queue\"\n",
        );
        let s = toml_section(t, "[model_providers.custom]");
        assert!(s.contains("base_url"));
        assert!(!s.contains("desktop"), "不应把下一段也带进来：{s}");
    }
}
