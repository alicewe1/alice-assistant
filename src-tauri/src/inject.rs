// 提示词注入引擎 — 对齐旧版 install*.ps1 的真实行为
//
// 全部语义来自对 6 个安装脚本的逐行精读，非推测。关键差异（必须按客户端区分）：
//
// ┌────────┬──────────────────────────────────┬──────────────┬─────────────┐
// │ 客户端 │ 标记                             │ 写入语义     │ 固定备份    │
// ├────────┼──────────────────────────────────┼──────────────┼─────────────┤
// │ Codex  │ <!-- 寒霜破甲注入开始 …结束 -->   │ 标记块替换   │ AGENTS.md.bak-inject │
// │ ZCode  │ 同 Codex                         │ 标记块替换   │ 同          │
// │ Claude │ <!-- HANSHUANG-INJECT:BEGIN prompt=<f> --> / :END │ 四分支 │ managed-prompts/CLAUDE.md.bak │
// │ Cursor │ <!-- HANSHUANG-CURSOR-INJECT --> │ 整份覆盖     │ target.bak（仅撞名） │
// │ DSH    │ <!-- HANSHUANG-INJECT:BEGIN --> / :END │ 标记块替换 │ AGENTS.md.bak-inject │
// │ WB     │ 标记块替换                       │ 标记块替换   │ MEMORY.md.bak-inject │
// └────────┴──────────────────────────────────┴──────────────┴─────────────┘
//
// 其它对齐点：
//   • 技能只复制含 SKILL.md 的目录；增量判定用 SKILL.md 的 size + mtime（容差 2 秒）
//   • 模块库 codex-skills/_modules → <skills_target>/_modules 或 ~/.l-skill/modules
//   • 时间戳备份保留最近 3 份；固定名备份=唯一原件，永不清理
//   • 模板 {{CHANNEL}}/{{CHANNEL_LABEL}}/{{SKILLS_ROOT}}/{{MODULES_ROOT}} 注入时展开，反斜杠转正斜杠
//   • 头部元数据行剥离（<!-- L-SKILL-VERSION|CONTRACT|SKILLS-ROOT… 开头的行）
//   • 渲染残留 {{...}} 直接报错（Assert-HsRendered）
//   • UTF-8 无 BOM；正文用 LF，块边界用 CRLF
//   • 状态文件记录 installedSkills，卸载只删「上次清单 ∩ 随包技能库」里的技能

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use crate::runtime::runtime_root;

const KEEP_BACKUPS: usize = 3;

// ============================================================
// 数据模型（与前端 inject-spec.ts 一一对应）
// ============================================================

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceSpec {
    pub name: String,
    #[serde(default)]
    pub desc: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VersionSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub desc: String,
    pub file: String,
    #[serde(default)]
    pub choices: Vec<ChoiceSpec>,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub skill_packs: Vec<String>,
    #[serde(default)]
    pub extra_files: Vec<String>,
    /// 技能源目录绝对路径（manifest 驱动时由 profiles.rs 填入，优先于 skill_packs 猜测）
    #[serde(default)]
    pub skill_source: Option<String>,
}

/// 供 profiles.rs / import_skill.rs 复用：递归统计文件数
pub use self::helpers::count_files as count_files_pub;
pub use self::helpers::copy_dir as copy_dir_pub;
pub use self::helpers::read_text as read_text_pub;
pub use self::helpers::write_utf8_no_bom as write_utf8_no_bom_pub;
/// 供 import_skill.rs 复用：解析 SKILL.md frontmatter
pub use parse_skill_frontmatter as parse_skill_frontmatter_pub;

mod helpers {
    use std::path::Path;

    pub fn count_files(dir: &Path) -> usize {
        let mut n = 0;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() {
                    n += count_files(&p);
                } else {
                    n += 1;
                }
            }
        }
        n
    }

    pub fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(src)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
        {
            let p = e.path();
            let target = dest.join(e.file_name());
            if p.is_dir() {
                copy_dir(&p, &target)?;
            } else {
                std::fs::copy(&p, &target).map_err(|e| format!("{}: {e}", p.display()))?;
            }
        }
        Ok(())
    }

    pub fn read_text(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    pub fn write_utf8_no_bom(path: &Path, text: &str) -> Result<(), String> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// 写入语义
///
/// 历史遗留：早先每个注入点用不同写入语义（块内替换 / Claude 四分支 / 整份覆盖）。
/// 现在安装一律「原文件改名 -bak + 新的整份放进去」，写入路径不再读这个字段；
/// 保留它只为兼容旧 manifest 与旧状态文件的解析，缺省即 MarkedBlock。
#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum WriteMode {
    /// 标记块替换（Codex/ZCode/DSH/WB）：块存在则只换块内，否则追加
    #[default]
    MarkedBlock,
    /// Claude 四分支：有块→换块内；空/纯提示词→整份；无标记但是提示词→挪走留证+写新块；用户内容→首次备份+追加
    ClaudeBlock,
    /// 整份覆盖（Cursor 的 .mdc）
    Overwrite,
    /// 第三方文件夹对（sourceDir → path）。
    ///
    /// 它不是提示词落点，引擎也不会按这个模式写文件；但 manifest 里确实存在
    /// 带 `mode:"dir"` 的条目，而前端会把整个 injectTargets 原样回传给
    /// inject_status / version_bundle。枚举里少了这个变体时，反序列化会直接
    /// 报 `unknown variant 'dir'`，整个命令失败 —— 表现为「注入位置一直读取中」、
    /// 「版本内容空白」。所以必须显式接受它。
    Dir,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InjectTarget {
    pub path: String,
    /// 缺省即 MarkedBlock：前端从 manifest 直接回传的落点不带这个字段
    #[serde(default)]
    pub mode: WriteMode,
    /// 块开始**关键串**（稳定，用于定位）。写入时包成 `<!-- key payload -->`
    #[serde(default = "default_begin_key")]
    pub begin_key: String,
    /// 追加在 key 之后、`-->` 之前的载荷（如 ` prompt=x.md`、` pack=dsh-lazy-pack-v5`）
    #[serde(default)]
    pub begin_payload: Option<String>,
    #[serde(default = "default_end_key")]
    pub end_key: String,
    /// Cursor 的 .mdc 需要 YAML frontmatter
    #[serde(default)]
    pub frontmatter: Option<String>,
    /// overwrite 模式用的纯净标记（用于识别与卸载）
    #[serde(default)]
    pub marker: Option<String>,
    /// 固定备份后缀（各客户端不同：.bak-inject / .bak）
    #[serde(default)]
    pub backup_suffix: Option<String>,
    /// 固定备份的完整路径（Claude 放在 managed-prompts/ 下）
    #[serde(default)]
    pub fixed_backup: Option<String>,
    /// 时间戳备份的标签（backup / inject）
    #[serde(default)]
    pub stamp_tag: Option<String>,
}

fn default_begin_key() -> String {
    "寒霜破甲注入开始".into()
}
fn default_end_key() -> String {
    "寒霜破甲注入结束".into()
}

impl InjectTarget {
    /// 写入用的完整开始标记
    pub fn begin_marker(&self) -> String {
        format!(
            "<!-- {}{} -->",
            self.begin_key,
            self.begin_payload.clone().unwrap_or_default()
        )
    }
    /// 写入用的完整结束标记
    pub fn end_marker(&self) -> String {
        format!("<!-- {} -->", self.end_key)
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillSync {
    pub dest: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClientSpec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub legacy_script: String,
    pub versions: Vec<VersionSpec>,
    pub inject_targets: Vec<InjectTarget>,
    #[serde(default)]
    pub skill_sync: Vec<SkillSync>,
    /// 模块库同步目标（~/.l-skill/modules 等）
    #[serde(default)]
    pub module_sync: Option<String>,
    /// 状态文件路径（各客户端不同）
    #[serde(default)]
    pub state_path: Option<String>,
    /// 状态文件里的字段名（Cursor 是 writtenPaths，其它是 installedSkills）
    #[serde(default)]
    pub state_style: Option<String>,
    /// 第三方文件夹对（源目录 → 注入目录）：dir 型注入目标由 profiles.rs 摘出来放这里，
    /// 避免与 prompt 注入目标混在一起被当成的提示词落点。
    #[serde(default)]
    pub third_party: Vec<ThirdPartyPair>,
}

/// 第三方条目：把 source（文件或目录）放到 dest。
///
/// 用途：客户端自己的云记忆 / 记忆档案 / 外部资源。
/// 用户在 `_assets/other/` 里自建目录放这些文件，预设组按「第三方文件」引用它，
/// 安装时整份放到客户端读取的位置。
///
/// 三个可选行为：
///   `kind`     —— "file" | "dir" | "auto"（缺省 auto，按源的实际类型判断）
///   `label`    —— 用户自己写的备注（界面显示用，不参与复制）
///   `readonly` —— 复制完成后把落点文件设为只读，防止客户端篡改云记忆
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyPair {
    pub source: String,
    pub dest: String,
    /// 源类型：file / dir / auto（缺省 auto）
    #[serde(default)]
    pub kind: Option<String>,
    /// 用户备注（界面显示）
    #[serde(default)]
    pub label: Option<String>,
    /// 落盘后设为只读
    #[serde(default)]
    pub readonly: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    pub version_id: Option<String>,
    pub version_label: Option<String>,
    pub installed_skills: Vec<String>,
    pub installed_modules: usize,
    pub installed_at: Option<u64>,
    pub backups: Vec<(String, String)>,
    /// 本次注入写出的文件清单（路径 + 写入时的字节数）。
    ///
    /// 卸载时用它判定「当前文件还是不是我们写的那份」：
    /// 字节数一致 → 没人动过，删掉并把 `<路径>-bak` 改回原名；
    /// 字节数不同 → 用户改过，保留不动，避免毁掉用户内容。
    #[serde(default)]
    pub injected_files: Vec<InjectedFile>,
    /// 本次注入接管过的技能目录（原目录已改名为 `<目录>-bak`）
    #[serde(default)]
    pub skill_dirs: Vec<String>,
    /// 本次放置过的第三方条目（落点 + 是否设了只读），卸载时据此清理并清掉只读
    #[serde(default)]
    pub third_party_placed: Vec<PlacedThirdParty>,
}

/// 已放置的第三方条目
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlacedThirdParty {
    /// 实际落点（文件型是文件全路径，目录型是目录）
    pub path: String,
    pub is_file: bool,
    pub readonly: bool,
    /// **本次实际写进去的顶层条目名**（目录型才有）。
    ///
    /// 为什么记这个而不是整个 path：第三方落点常常和技能落点是同一个目录
    /// （例如都指向 ~/.codex/skills）。卸载时如果按 path 直接 remove_dir_all，
    /// 会把技能那一步要清理的东西一起端掉 —— 顺序上无论谁先谁后都出错。
    /// 只删「自己放进去的那几个条目」，两个步骤就互不干扰了。
    #[serde(default)]
    pub entries: Vec<String>,
}

/// 一次注入写出的文件记录
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InjectedFile {
    pub path: String,
    pub size: u64,
}

/// 原文件改名后缀：`AGENTS.md` → `AGENTS.md-bak`
pub const BAK_SUFFIX: &str = "-bak";

// ============================================================
// 路径与 IO
// ============================================================

pub fn home_dir() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

pub fn expand_path(app: &AppHandle, raw: &str) -> PathBuf {
    let home = home_dir();
    let root = runtime_root(app);
    let s = raw
        .replace("{{HOME}}", &home)
        .replace("{{RUNTIME}}", &root.display().to_string());
    let s = if let Some(rest) = s.strip_prefix('~') {
        format!("{home}{rest}")
    } else {
        s
    };
    PathBuf::from(s.replace('/', "\\"))
}

/// 第三方**源**路径解析：在 expand_path 基础上多一层 `_assets/` 兜底。
///
/// 用户在预设组里写第三方源时，习惯写成相对 `_assets/` 的路径
/// （如 `other/memory/MEMORY.md`），这样换机器/换盘符都不用改配置。
/// 绝对路径与 `~` 开头的写法照旧走 expand_path。
pub fn expand_asset_path(app: &AppHandle, raw: &str) -> PathBuf {
    let direct = expand_path(app, raw);
    if direct.is_absolute() {
        return direct;
    }
    // 相对路径：先按 _assets/ 解析，命中就用它；否则退回原样（让调用方报错）
    let under_assets = runtime_root(app).join("_assets").join(&direct);
    if under_assets.exists() {
        return under_assets;
    }
    direct
}

fn state_path_for(app: &AppHandle, spec: &ClientSpec) -> PathBuf {
    match &spec.state_path {
        Some(p) => expand_path(app, p),
        None => runtime_root(app).join(format!(".codex/state-{}.json", spec.id)),
    }
}

pub fn read_state(app: &AppHandle, spec: &ClientSpec) -> InstallState {
    std::fs::read_to_string(state_path_for(app, spec))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(app: &AppHandle, spec: &ClientSpec, st: &InstallState) -> Result<(), String> {
    let p = state_path_for(app, spec);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let js = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, js).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// UTF-8 无 BOM 写入（旧版显式 UTF8Encoding($false)）
fn write_utf8_no_bom(path: &Path, text: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (now / 86400) as i64;
    let secs = now % 86400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 时间戳备份保留最近 N 份；固定名备份永不清理
fn prune_backups(dir: &Path, stem: &str) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let re = Regex::new(r"\d{8}-\d{6}").ok();
    let mut stamped: Vec<(String, PathBuf)> = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(stem) {
            continue;
        }
        if re.as_ref().map(|r| r.is_match(&name)).unwrap_or(false) {
            stamped.push((name, e.path()));
        }
    }
    if stamped.len() <= KEEP_BACKUPS {
        return;
    }
    stamped.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in stamped.iter().skip(KEEP_BACKUPS) {
        let _ = std::fs::remove_file(p);
    }
}

/// 固定名备份：已存在则复用（唯一原件，绝不覆盖成已注入版本）
fn backup_fixed(path: &Path, suffix: &str) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bak = PathBuf::from(format!("{}{}", path.display(), suffix));
    if bak.exists() {
        return Ok(Some(bak));
    }
    if let Some(d) = bak.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::copy(path, &bak).map_err(|e| format!("备份失败: {e}"))?;
    Ok(Some(bak))
}

/// 时间戳备份（保留 3 份）
fn backup_stamped(path: &Path, tag: &str) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let stem = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let bak = path.with_file_name(format!("{stem}.{tag}-{}", stamp()));
    std::fs::copy(path, &bak).map_err(|e| format!("备份失败: {e}"))?;
    if let Some(dir) = path.parent() {
        prune_backups(dir, &stem);
    }
    Ok(Some(bak))
}

// ============================================================
// 块定位（按「关键串」容错匹配，兼容旧版可变载荷）
// ============================================================

/// 在 text 中定位标记块，返回 (块起点, 块终点)。
///
/// 关键：用**关键串**做子串匹配，而不是用完整标记做字面匹配。
/// 旧版写的块载荷可变（`BEGIN` / `BEGIN prompt=x.md` / `BEGIN pack=dsh-lazy-pack-v5`），
/// 若按完整标记匹配，就认不出老版本写的块，会导致重复叠加而不是替换。
fn find_block(text: &str, begin_key: &str, end_key: &str) -> Option<(usize, usize)> {
    // 找到含关键串的整行注释：<!-- … begin_key … -->
    let b_start = text.find(begin_key)?;
    // 回溯到该行注释的 `<!--`
    let line_start = text[..b_start].rfind("<!--")?;
    // 前推到该注释的 `-->`
    let b_end = text[b_start..].find("-->")? + b_start + 3;
    // 结束标记同理
    let e_key_at = text[b_end..].find(end_key)? + b_end;
    let e_line_start = text[..e_key_at].rfind("<!--")?;
    let e_end = text[e_key_at..].find("-->")? + e_key_at + 3;
    let _ = e_line_start;
    Some((line_start, e_end))
}

/// 标记块写入：有块→只换块内（保留用户内容）；无块→追加
pub fn apply_block(existing: &str, begin_key: &str, end_key: &str, begin: &str, end: &str, body: &str) -> (String, bool) {
    let block = format!("{begin}\n{}\n{end}", body.trim_end());
    if let Some((s, e)) = find_block(existing, begin_key, end_key) {
        let mut out = String::new();
        out.push_str(&existing[..s]);
        out.push_str(&block);
        out.push_str(&existing[e..]);
        return (out, true); // updated
    }
    let mut out = existing.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\r\n\r\n");
    }
    out.push_str(&block);
    out.push_str("\r\n");
    (out, false) // appended
}

/// 移除标记块（保留块外用户内容）
pub fn strip_block(existing: &str, begin_key: &str, end_key: &str) -> String {
    match find_block(existing, begin_key, end_key) {
        Some((s, e)) => {
            let mut out = String::new();
            out.push_str(existing[..s].trim_end());
            out.push_str(&existing[e..]);
            out.trim().to_string()
        }
        None => existing.to_string(),
    }
}

/// 注入产物的指纹（不写进客户端文件，只用于内部比对）。
///
/// 用来回答「这个文件是不是我们上次写的」：
///   · 安装时 —— 是就直接覆盖，不必再备份；
///   · 卸载时 —— 配合字节数比对，确认没被用户改过才敢删。
pub const MANAGED_BY_TAG: &str = "<!-- managed by alicewe -->";

/// 每个客户端注入文件的第一行署名（用户要求：alicewe，不带寒霜/版本信息）。
///
/// 写成 HTML 注释：codex/workbuddy/cursor 这类读 Markdown/规则文件的客户端
/// 会把它当注释忽略，不会污染正文；但文件里又有迹可循，方便辨认来源。
fn managed_header(channel: &str) -> String {
    let _ = channel; // 署名不带客户端/版本信息，参数保留以便日后按客户端定制
    format!("{}\n", MANAGED_BY_TAG)
}

/// 判定文本是否为「注入产物」（用于识别老版覆盖式残渣）
/// 特征串取自旧版 Test-InjectionArtifact
pub fn is_injection_artifact(text: &str) -> bool {
    const MARKS: &[&str] = &[
        "HANSHUANG-INJECT",
        "拒绝话术全清单",
        "激活词",
        "SES-OS",
        "样例 A：给另一 AI",
        "CTF Lab",
        "破甲助手",
        MANAGED_BY_TAG,
    ];
    MARKS.iter().any(|m| text.contains(m))
}

// ============================================================
// 模板渲染 + 头部元数据剥离
// ============================================================

pub fn expand_template(text: &str, channel: &str, label: &str, skills_root: &str, modules_root: &str) -> String {
    text.replace("{{CHANNEL_LABEL}}", label)
        .replace("{{CHANNEL}}", channel)
        .replace("{{SKILLS_ROOT}}", &skills_root.replace('\\', "/"))
        .replace("{{MODULES_ROOT}}", &modules_root.replace('\\', "/"))
        .replace("{{HOME}}", &home_dir().replace('\\', "/"))
}

/// 剥离头部元数据行（旧版 ConvertTo-HsPromptBody）
/// 删掉以这些前缀开头的行；MANAGED-PERSONA 与握手块保留
pub fn strip_metadata(text: &str) -> String {
    const PREFIXES: &[&str] = &[
        "<!-- L-SKILL-VERSION",
        "<!-- L-SKILL-V5-SEAL",
        "<!-- CHANNEL-LABEL",
        "<!-- CONTRACT",
        "<!-- SKILLS-ROOT",
        "<!-- MODULES-ROOT",
        "<!-- MANAGED-BY",
    ];
    text.lines()
        .filter(|l| {
            let t = l.trim_start();
            !PREFIXES.iter().any(|p| t.starts_with(p))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 渲染残留检查（旧版 Assert-HsRendered）
pub fn has_unrendered(text: &str) -> Option<String> {
    Regex::new(r"\{\{[A-Z_]+\}\}")
        .ok()?
        .find(text)
        .map(|m| m.as_str().to_string())
}

// ============================================================
// 技能同步（含增量判定）
// ============================================================

/// SKILL.md 的 size + mtime 是否一致（容差 2 秒，对齐旧版 Test-SkillCurrent）
fn skill_current(src: &Path, dest: &Path) -> bool {
    let s = src.join("SKILL.md");
    let d = dest.join("SKILL.md");
    let (Ok(sm), Ok(dm)) = (s.metadata(), d.metadata()) else {
        return false;
    };
    if sm.len() != dm.len() {
        return false;
    }
    let st = sm.modified().ok();
    let dt = dm.modified().ok();
    match (st, dt) {
        (Some(a), Some(b)) => {
            let diff = if a > b { a.duration_since(b) } else { b.duration_since(a) };
            diff.map(|d| d.as_secs() <= 2).unwrap_or(false)
        }
        _ => false,
    }
}

/// 只同步含 SKILL.md 的目录；已是最新则跳过。
/// 返回 `(已安装技能名单, 跳过数, 是否复制了 _modules)`。
///
/// 第三个返回值是给卸载用的：`_modules` 不是「含 SKILL.md 的技能」，
/// 所以它进不了技能名单；卸载时若不知道「这次装过它」，就会永远残留在
/// 用户的 skills 目录里（原目录本来没有这个东西）。
///
/// `pack_id`：当前这个源属于哪个技能包（用于查 `source_map`）。
/// `source_map`：技能名 → 指定只从哪个包取（重名技能的用户选择）。
///   装到别的包时，若该技能在表里被指定给了别人，就跳过 ——
///   否则两个包的同名技能都会装进去，后者覆盖前者，用户的选择失效。
fn sync_skills(
    src: &Path,
    dest_root: &Path,
    only: Option<&[String]>,
    pack_id: &str,
    source_map: Option<&std::collections::HashMap<String, String>>,
) -> Result<(Vec<String>, usize, bool), String> {
    let rd = std::fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let mut done = Vec::new();
    let mut skipped = 0;
    let mut copied_modules = false;
    std::fs::create_dir_all(dest_root).map_err(|e| e.to_string())?;
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();

        // `_modules` 是模块库，本来就在技能包里（skills/_modules）。
        // 它跟着技能包一起复制过去即可 —— 不需要用户在预设组里
        // 单独配一个「模块库注入位置」：那本来就是同一个目录，
        // 多配一处只会让两边不一致。
        if name == "_modules" {
            let dest = dest_root.join("_modules");
            let _ = std::fs::remove_dir_all(&dest);
            copy_dir(&p, &dest)?;
            copied_modules = true;
            continue;
        }

        if !p.join("SKILL.md").exists() {
            continue;
        }
        // 勾选筛选：Some 名单 = 只装名单内的技能。
        // 注意空名单也要真的装 0 个 —— 之前写成 `!list.is_empty() && …`，
        // 结果「全部取消勾选」会被当成「全装」，与界面语义相反。
        if let Some(list) = only {
            if !list.iter().any(|n| n == &name) {
                continue;
            }
        }
        // 重名来源筛选：这个名字被用户指定从别的包取 → 本包这份不装
        if let Some(map) = source_map {
            if let Some(want) = map.get(&name) {
                if !want.is_empty() && want != pack_id {
                    continue;
                }
            }
        }
        let dest = dest_root.join(&name);
        if skill_current(&p, &dest) {
            skipped += 1;
            done.push(name);
            continue;
        }
        let _ = std::fs::remove_dir_all(&dest);
        copy_dir(&p, &dest)?;
        done.push(name);
    }
    Ok((done, skipped, copied_modules))
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src).map_err(|e| e.to_string())?.filter_map(|e| e.ok()) {
        let p = e.path();
        let target = dest.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &target)?;
        } else {
            std::fs::copy(&p, &target).map_err(|e| format!("{}: {e}", p.display()))?;
        }
    }
    Ok(())
}

/// 把 `src` 目录里的所有条目搬进 `dst`（dst 不存在则创建）。返回搬动的条目数。
///
/// 为什么需要「搬内容」而不是 rename 整个目录：客户端（DSH Desktop / Codex 等）
/// 常常正把 `~/.dsh/skills` 当工作目录或持有句柄，此时 `rename(dir, dir-bak)`
/// 会直接返回 os error 5（拒绝访问）—— 实测就是这样。
/// 但目录**里面**的条目可以自由移动/删除，所以退回「建 bak + 逐条搬进去」，
/// 效果与整体改名完全一致，用户的原始内容一样完整保留。
fn move_contents(src: &Path, dst: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("{}: {e}", dst.display()))?;
    let mut n = 0usize;
    for e in std::fs::read_dir(src)
        .map_err(|e| format!("{}: {e}", src.display()))?
        .filter_map(|e| e.ok())
    {
        let from = e.path();
        let to = dst.join(e.file_name());
        // 同名条目：以 bak 里已有的为准，避免覆盖掉更早的原始备份
        if to.exists() {
            if from.is_dir() {
                n += move_contents(&from, &to)?;
                let _ = std::fs::remove_dir_all(&from);
            } else {
                let _ = std::fs::remove_file(&from);
            }
            continue;
        }
        match std::fs::rename(&from, &to) {
            Ok(()) => n += 1,
            Err(_) => {
                // 跨卷或个别条目被占用 → 退回复制再删
                if from.is_dir() {
                    copy_dir(&from, &to)?;
                    let _ = std::fs::remove_dir_all(&from);
                } else {
                    std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
                    let _ = std::fs::remove_file(&from);
                }
                n += 1;
            }
        }
    }
    Ok(n)
}

/// 技能落点准备：把已存在的技能目录整体挪成 `<dest>-bak`，再把新的放进去。
///
/// 用户要求：「原注入目录 skill 需要改名为 skill-bak 文件夹，再把新的放进去」。
/// 这样客户端读到的一定是本次注入的干净技能集，不会被历史残留干扰 ——
/// 之前直接在原目录上做增量同步，目录里堆着上百个旧技能时新技能会被淹没/漏装。
///
/// 备份策略（不丢数据）：
///   · `<dest>-bak` 不存在 → 把现有 dest 挪成 `<dest>-bak`，原始内容永久保留
///   · `<dest>-bak` 已存在 → 原始备份已在，直接清空 dest（备份不被覆盖）
///
/// 实现上先试整体 rename；被客户端占用而失败时退回「建 bak + 逐条搬内容」，
/// 两条路径对用户是同一个结果。
fn prepare_skill_dest(dest: &Path, steps: &mut Vec<String>) -> Result<(), String> {
    if !dest.is_dir() {
        return Ok(());
    }
    let name = dest
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "skills".into());
    let bak = dest.with_file_name(format!("{name}-bak"));

    // 空目录不用备份，直接留用
    let empty = std::fs::read_dir(dest)
        .map(|mut rd| rd.next().is_none())
        .unwrap_or(true);
    if empty {
        return Ok(());
    }

    if bak.exists() {
        // 原始备份已在 → 清空 dest 重建（不覆盖更早的备份）
        std::fs::remove_dir_all(dest).or_else(|_| {
            // 目录本身删不掉时，逐个删里面的条目
            for e in std::fs::read_dir(dest)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
            {
                let p = e.path();
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(&p);
                } else {
                    let _ = std::fs::remove_file(&p);
                }
            }
            Ok::<(), String>(())
        })?;
        steps.push(format!(
            "已清空 {} 准备放入新技能（原始备份在 {}）",
            dest.display(),
            bak.display()
        ));
    } else {
        // 先试整体改名（最快、最干净）
        match std::fs::rename(dest, &bak) {
            Ok(()) => steps.push(format!("原技能目录已改名为 {}", bak.display())),
            Err(_) => {
                // 客户端占用导致改名失败 → 建 bak 并把内容搬进去。
                // 目录本身保持原位（它被占用，删不掉也不能改名）。
                let n = move_contents(dest, &bak)
                    .map_err(|e| format!("备份 {} 内容到 {} 失败：{e}", dest.display(), bak.display()))?;
                steps.push(format!(
                    "原技能目录内容已移入 {}（{} 项 · 目录被客户端占用，无法整体改名）",
                    bak.display(),
                    n
                ));
            }
        }
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// 第三方文件夹复制：**合并**进目标目录（不清空用户已有内容），返回写入项数。
///
/// 与 copy_dir 的区别：copy_dir 用于技能同步（目标先 remove_dir_all 再整份重建，
/// 保证技能目录纯净）；第三方目录是用户的目录，绝不能清空 —— 只做覆盖式合并。
fn copy_dir_merge(src: &Path, dest: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut n = 0usize;
    for e in std::fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))?.filter_map(|e| e.ok()) {
        let p = e.path();
        let target = dest.join(e.file_name());
        if p.is_dir() {
            n += copy_dir_merge(&p, &target)?;
        } else {
            if let Some(d) = target.parent() {
                std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&p, &target).map_err(|e| format!("{}: {e}", p.display()))?;
            n += 1;
        }
    }
    Ok(n)
}

/// 放一个文件到 dest，返回一句结果描述。
///
/// dest 的语义按情况解释：
///   · dest 已是目录（或源文件名想保留）→ 放到 `dest/<源文件名>`
///   · dest 带扩展名（形如 `.../MEMORY.md`）→ 直接就是目标文件路径
///   · 其它（无扩展名的裸路径）→ 当作目录，放 `dest/<源文件名>`
///
/// 这样用户在界面里既能写「放到这个目录」，也能写「就叫这个文件名」。
fn place_one_file(src: &Path, dest: &Path, readonly: bool) -> Result<String, String> {
    let file_name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| format!("源不是文件：{}", src.display()))?;

    // 决定最终目标文件路径
    let target = if dest.is_dir() {
        dest.join(&file_name)
    } else if dest.extension().is_some() {
        // 带扩展名 → 用户明确指定了目标文件名
        dest.to_path_buf()
    } else {
        dest.join(&file_name)
    };

    if let Some(d) = target.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
    }

    // 目标已存在：先清掉只读属性，否则覆盖会失败
    if target.exists() {
        let _ = set_readonly(&target, false);
        // 若是目录占着这个位置，先挪开
        if target.is_dir() {
            let bak = PathBuf::from(format!("{}{}", target.display(), BAK_SUFFIX));
            std::fs::rename(&target, &bak)
                .map_err(|e| format!("{} → {} 失败：{e}", target.display(), bak.display()))?;
        }
    }

    std::fs::copy(src, &target).map_err(|e| format!("{} → {}: {e}", src.display(), target.display()))?;

    if readonly {
        set_readonly(&target, true)?;
        Ok(format!("{} 字节 · 已设只读", std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0)))
    } else {
        Ok(format!("{} 字节", std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0)))
    }
}

/// 设置/清除只读属性。
///
/// Windows 上用 FILE_ATTRIBUTE_READONLY；其它平台用权限位去掉写位。
fn set_readonly(p: &Path, on: bool) -> Result<(), String> {
    let md = std::fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let mut perm = md.permissions();
    #[cfg(windows)]
    {
        // std 在 Windows 上把 readonly 映射到 FILE_ATTRIBUTE_READONLY
        perm.set_readonly(on);
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = perm.mode();
        perm.set_mode(if on { mode & !0o222 } else { mode | 0o644 });
    }
    std::fs::set_permissions(p, perm).map_err(|e| format!("{}: {e}", p.display()))
}

/// 递归设置只读，返回处理的文件数。目录本身不改（否则无法往里写新文件）。
fn set_readonly_tree(root: &Path, on: bool) -> Result<usize, String> {
    let mut n = 0usize;
    if !root.is_dir() {
        return Ok(0);
    }
    for e in std::fs::read_dir(root).map_err(|e| format!("{}: {e}", root.display()))?.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.is_dir() {
            n += set_readonly_tree(&p, on)?;
        } else {
            set_readonly(&p, on)?;
            n += 1;
        }
    }
    Ok(n)
}

// ============================================================
// 提示词源解析
// ============================================================

/// 解析提示词文件的真实路径。
///
/// 按「先直接后兜底」的顺序找，关键是第 1 条：`_assets/<file>` —— 这样
/// `dsh-lazy-pack-v5/prompts/cold-coffee.md` 这类带子目录的相对路径也能命中。
/// 早先这里只硬编码了 4 个目录（_assets/prompts、.codex/prompts、
/// _assets/gpt-6-astra-v1、_assets/dsh-lazy-pack-v5/prompts），
/// 于是「提示词组」里选了别的目录下的提示词就会报「找不到提示词文件」。
pub fn resolve_prompt(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let root = runtime_root(app);
    let f = file.trim();
    let cands = [
        // 1) 相对 _assets/ 的完整路径（含子目录），覆盖绝大多数情况
        root.join("_assets").join(f),
        // 2) 相对运行体根的绝对式写法
        root.join(f),
        // 3) 只给了文件名 → 到几个常见提示词目录里找
        root.join("_assets/prompts").join(f),
        root.join(".codex/prompts").join(f),
        // 4) 历史位置兜底
        root.join("_assets/gpt-6-astra-v1").join(f),
        root.join("_assets/dsh-lazy-pack-v5/prompts").join(f),
    ];
    for c in cands {
        if c.exists() {
            return Ok(c);
        }
    }
    // 5) 还找不到：在 _assets 的**子目录**里按文件名做一次有界搜索
    //    （容忍提示词放在 prompts/ 以外的子目录）。
    //
    //    刻意从子目录开始搜、不搜 _assets 根目录：根目录下的同名文件
    //    会让「用户已删掉 prompts/xxx.md」被一个根目录同名文件顶替，
    //    界面报「存在」而实际装的是另一个文件 —— 属于静默装错内容。
    if let Some(hit) = find_in_subdirs_by_name(&root.join("_assets"), f, 0) {
        return Ok(hit);
    }
    Err(format!("找不到提示词文件: {file}"))
}

/// 只在**子目录**里按文件名找（不匹配 dir 自身的直接子文件）。
/// 深度受限，避免用户把提示词库指到巨型目录时扫爆。
fn find_in_subdirs_by_name(dir: &Path, needle: &str, depth: usize) -> Option<PathBuf> {
    if depth > 5 || !dir.is_dir() {
        return None;
    }
    let base = needle.rsplit(['/', '\\']).next().unwrap_or(needle);
    let mut subs: Vec<PathBuf> = Vec::new();
    for e in std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.is_dir() {
            subs.push(p);
        }
    }
    subs.sort();
    for d in subs {
        // 先看这一层子目录里的文件
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_file() && e.file_name().to_string_lossy().eq_ignore_ascii_case(base) {
                    return Some(p);
                }
            }
        }
        // 再往下钻
        if let Some(hit) = find_in_subdirs_by_name(&d, needle, depth + 1) {
            return Some(hit);
        }
    }
    None
}

/// 按「相对路径后缀」或「文件名」在目录树里找文件（深度受限，避免扫爆）。
/// used 于提示词解析兜底：用户把 .md 放在任意子目录也能被找到。
fn find_file_by_name(dir: &Path, needle: &str, depth: usize) -> Option<PathBuf> {
    if depth > 5 || !dir.is_dir() {
        return None;
    }
    let base = needle.rsplit(['/', '\\']).next().unwrap_or(needle);
    let mut subdirs: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                subdirs.push(p);
            } else if e.file_name().to_string_lossy().eq_ignore_ascii_case(base) {
                return Some(p);
            }
        }
    }
    subdirs.sort();
    for d in subdirs {
        if let Some(hit) = find_file_by_name(&d, needle, depth + 1) {
            return Some(hit);
        }
    }
    None
}

pub fn resolve_skill_pack(app: &AppHandle, pack: &str) -> Option<PathBuf> {
    // 统一走新结构解析（含旧结构兼容）
    shipped_skill_pack_root(app, pack)
}

// ============================================================
// Tauri commands
// ============================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    /// prompt | skills | thirdParty | modules
    pub kind: String,
    pub path: String,
    pub exists: bool,
    pub injected: bool,
    pub block_len: usize,
    pub file_len: usize,
    pub backup: Option<String>,
    /// 目录型落点里的条目数（技能数 / 第三方顶层条目数 / 模块 md 数）
    pub item_count: usize,
    /// 目录型落点的标签（技能包名 / 第三方源目录）
    pub label: Option<String>,
    /// 该落点是否真的落盘成功（目录型看条目数，文件型看注入标记）
    pub ok: bool,
}

/// 统计目录里的条目（技能=含 SKILL.md 的子目录；模块=顶层 .md）
fn count_dir_entries(p: &Path, only_skill_dirs: bool) -> usize {
    let Ok(rd) = std::fs::read_dir(p) else {
        return 0;
    };
    rd.filter_map(|e| e.ok())
        .filter(|e| {
            let path = e.path();
            if only_skill_dirs {
                path.is_dir() && path.join("SKILL.md").exists()
            } else {
                true
            }
        })
        .count()
}

/// 注入点状态。
///
/// 早先这里只回 inject_targets，于是「技能落点」和「第三方文件夹落点」在界面上
/// 根本不出现 —— 用户看到的就是「注入位置没有显示技能和第三方的」。
/// 现在四类落点都回，并各自给出真实的存在性/条目数，供界面显示真实成败。
#[tauri::command]
pub fn inject_status(app: AppHandle, client: ClientSpec) -> Vec<TargetStatus> {
    let mut out: Vec<TargetStatus> = Vec::new();
    /*
     * 注入状态的唯一依据是**安装状态记录**，不是「文件/目录存在」。
     *
     * 早先技能和第三方的 ok 都写成「目录里有东西就算注入」——
     * 那是错的：用户的 skills 目录里本来就有自己建的技能，卸载之后
     * 那些东西还在，于是界面永远显示「已装技能 / 已放置」，标签一直是绿的。
     * 用户反馈的「卸载后还是亮的」就是这个。
     *
     * 现在改成：只有本次安装真的放进去过（状态清单里有记录）才算已注入。
     * 提示词那条不受影响 —— 它靠正文里的产物标记判定，卸载时文件被删/还原，
     * 标记自然消失。
     */
    let st = read_state(&app, &client);
    let installed_skills: std::collections::HashSet<&str> =
        st.installed_skills.iter().map(|s| s.as_str()).collect();
    // 第三方：把状态里记的落点路径收成集合，逐个比对
    let placed_paths: std::collections::HashSet<String> = st
        .third_party_placed
        .iter()
        .map(|p| p.path.clone())
        .collect();
    // 技能落点：本次接管过的目录（卸载会清空）
    let skill_dirs: std::collections::HashSet<String> =
        st.skill_dirs.iter().map(|s| s.clone()).collect();

    for t in client.inject_targets.iter().filter(|t| t.mode != WriteMode::Dir) {
        let p = expand_path(&app, &t.path);
        let txt = read_text(&p);
        // 统一「整份接管」后，判定注入是否生效只看产物标记
        let injected = txt.contains(MANAGED_BY_TAG);
        let bak = PathBuf::from(format!("{}{BAK_SUFFIX}", p.display()));
        out.push(TargetStatus {
            kind: "prompt".into(),
            path: p.display().to_string(),
            exists: p.exists(),
            injected,
            block_len: txt.len(),
            file_len: txt.len(),
            backup: if bak.exists() {
                Some(bak.display().to_string())
            } else {
                None
            },
            item_count: 0,
            label: None,
            ok: injected,
        });
    }

    // 技能落点：只有「本次接管过这个目录、且清单里有已装技能」才算已注入
    for s in &client.skill_sync {
        let p = expand_path(&app, &s.dest);
        let n = count_dir_entries(&p, true);
        // 原目录被改名成的 <dest>-bak，界面里显示出来，用户才知道原始技能去哪了
        let name = p
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|| "skills".into());
        let bak = p.with_file_name(format!("{name}-bak"));
        // 本次真的往这个落点装过技能吗？
        let took_over = skill_dirs.contains(&p.display().to_string());
        let has_installed = !installed_skills.is_empty();
        let injected = took_over && has_installed;
        out.push(TargetStatus {
            kind: "skills".into(),
            path: p.display().to_string(),
            exists: p.is_dir(),
            injected,
            block_len: 0,
            file_len: 0,
            backup: if bak.is_dir() {
                Some(bak.display().to_string())
            } else {
                None
            },
            item_count: n,
            label: None,
            ok: injected,
        });
    }

    // 第三方条目：文件型看该文件是否存在，目录型看目录里有没有东西。
    // 标签优先用用户备注（label），没有才退回源路径。
    for tp in &client.third_party {
        let dest = expand_path(&app, &tp.dest);
        let src = expand_asset_path(&app, &tp.source);
        let is_file = match tp.kind.as_deref() {
            Some("file") => true,
            Some("dir") => false,
            _ => src.is_file(),
        };
        // 文件型的实际落点：dest 带扩展名就是它本身，否则是 dest/<源文件名>
        let p = if is_file {
            if dest.extension().is_some() {
                dest.clone()
            } else {
                dest.join(src.file_name().unwrap_or_default())
            }
        } else {
            dest.clone()
        };
        let (exists, n) = if is_file {
            (p.is_file(), usize::from(p.is_file()))
        } else {
            (p.is_dir(), count_dir_entries(&p, false))
        };
        // 同上：只有状态记录里记过这个落点，才算「本次注入的」
        let injected = placed_paths.contains(&p.display().to_string());
        out.push(TargetStatus {
            kind: "thirdParty".into(),
            path: p.display().to_string(),
            exists,
            injected,
            block_len: 0,
            file_len: if is_file {
                std::fs::metadata(&p).map(|m| m.len() as usize).unwrap_or(0)
            } else {
                0
            },
            backup: None,
            item_count: n,
            // 备注没填就给空串，界面拿它当「没有备注」处理
            label: Some(tp.label.clone().unwrap_or_default()),
            ok: injected,
        });
    }

    // 模块库不再作为独立落点显示。
    //
    // 理由：`_modules` 本来就在技能包里（`skills/_modules`），
    // 现在由 sync_skills 跟着技能包一起复制过去 —— 它就是技能目录里的
    // 一个子目录，不是单独的注入位置。以前把它单列出来，用户会以为
    // 需要另外配一个路径，反而容易配成两个不一致的地方。

    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub ok: bool,
    pub steps: Vec<String>,
    pub skills_installed: Vec<String>,
    pub skills_skipped: usize,
    pub error: Option<String>,
}

/// 安装：注入提示词 + 同步技能
/// `skill_filter`：只安装名单内的技能；None = 全部，Some(空) = 一个都不装
/// （界面「全不选」靠 Some(vec![]) 表达，不能被当成 None）
///
/// 进度上报：每完成一个阶段就 emit `inject:progress` 事件给界面，
/// 界面上的进度窗口逐项点亮、逐项写结果。
///
/// **必须是 async**：同步 command 跑在主线程上，会把 React 的渲染一起卡住 ——
/// 弹窗挂载不上、事件也没人收，用户看到的就是「点了安装但不出进度」。
/// 标 async 后 Tauri 把它丢到独立线程，主线程照常渲染，事件才能实时送达。
#[tauri::command(async)]
pub fn inject_install(
    app: AppHandle,
    client: ClientSpec,
    version: VersionSpec,
    choice_file: Option<String>,
    with_skills: bool,
    skill_filter: Option<Vec<String>>,
    // 重名技能的来源选择：技能名 → 只从这个包取。
    //
    // 为什么需要它：`skill_filter` 只给了「装哪些名字」，而重名技能
    // （如 A 包和 B 包都有 `l-reverse`）在多个包里都存在 —— 后端逐个包
    // 遍历时会把两份都装进去，后者覆盖前者，用户在界面上选的来源等于没用。
    // 有了这张表，装到某个包时就能跳过「已被指定从别处取」的同名技能。
    skill_source_map: Option<std::collections::HashMap<String, String>>,
) -> InstallReport {
    // 阶段上报：把「事件名 + 说明」发给界面。失败也不打断安装本身。
    macro_rules! progress {
        ($key:expr, $label:expr, $ok:expr) => {{
            let _ = app.emit(
                "inject:progress",
                serde_json::json!({
                    "phase": "install",
                    "key": $key,
                    "label": $label,
                    "ok": $ok,
                }),
            );
        }};
    }

    // ---- 先上报「计划」：界面据此把所有行一次性画出来（含待办态）----
    //
    // 为什么必须先发计划：安装命令是同步的，跑完才返回；如果界面只靠
    // 逐条事件来"长出"列表，事件早在弹窗挂载前就发完了 —— 弹窗一打开
    // 就是空的（实测就是这样）。先发一份完整清单，弹窗无论何时挂载
    // 都能照着画；后续的逐项事件只负责把对应行点亮。
    {
        let mut plan: Vec<serde_json::Value> = Vec::new();
        plan.push(serde_json::json!({
            "key": "prompt",
            "label": "读取提示词",
        }));
        for t in client.inject_targets.iter().filter(|t| t.mode != WriteMode::Dir) {
            plan.push(serde_json::json!({
                "key": format!("target:{}", t.path),
                "label": format!("提示词 → {}", t.path),
            }));
        }
        for tp in &client.third_party {
            let who = tp
                .label
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("第三方");
            plan.push(serde_json::json!({
                "key": format!("third:{}", tp.dest),
                "label": format!("第三方「{who}」→ {}", tp.dest),
            }));
        }
        if with_skills {
            for pack in &version.skill_packs {
                plan.push(serde_json::json!({
                    "key": format!("skill:{}", pack),
                    "label": format!("技能包 {pack}"),
                }));
            }
            // 不再有「模块库同步」这一项：`_modules` 是技能包里的子目录，
            // 随技能包一起复制，不是独立步骤。
        }
        let _ = app.emit(
            "inject:plan",
            serde_json::json!({ "phase": "install", "items": plan }),
        );
    }

    let mut steps = Vec::new();
    let mut backups: Vec<(String, String)> = Vec::new();

    // 1) 提示词源
    // 界面文案用「读取提示词」而不是「解析提示词」——后者是内部说法，
    // 用户看到不知道在干什么；这一步实际就是「找到并读出提示词文件」。
    progress!("prompt", "读取提示词", true);
    let file = choice_file.clone().unwrap_or_else(|| version.file.clone());
    let src = match resolve_prompt(&app, &file) {
        Ok(p) => p,
        Err(e) => {
            progress!("prompt", "读取提示词", false);
            return report_err(steps, e);
        }
    };
    let raw = match std::fs::read_to_string(&src) {
        Ok(t) => t,
        Err(e) => return report_err(steps, format!("读取失败: {e}")),
    };
    steps.push(format!("提示词源 {}（{} 字节）", src.display(), raw.len()));

    // 2) 渲染 + 剥离元数据
    let skills_root = client
        .skill_sync
        .first()
        .map(|s| expand_path(&app, &s.dest).display().to_string())
        .unwrap_or_default();
    let modules_root = client
        .module_sync
        .as_ref()
        .map(|m| expand_path(&app, m).display().to_string())
        .unwrap_or_default();
    let stripped = strip_metadata(&raw);
    let body = expand_template(&stripped, &client.id, &client.name, &skills_root, &modules_root);
    if let Some(left) = has_unrendered(&body) {
        return report_err(steps, format!("模板渲染残留未展开变量：{left}"));
    }
    steps.push(format!("渲染完成（{} 字节 · 元数据行已剥离）", body.len()));

    // 3) 写各注入目标
    //
    // 统一策略（用户指定）：「原文件改名 -bak，新的放进去」。
    //   · 目标已存在且还是上次注入的那份 → 直接覆盖，原文件早在 -bak 里
    //   · 目标已存在且是用户自己的内容   → 改名成 `<目标>-bak`，再写新的
    //   · 目标不存在                     → 直接写
    // 不再区分 markedBlock / claudeBlock / overwrite 三套分支 ——
    // 那套「块内替换 / 四分支」逻辑会把提示词和用户内容混在同一个文件里，
    // 卸载时无法干净还原，现在一律整份接管。
    let mut injected_files: Vec<InjectedFile> = Vec::new();
    // 只写提示词落点。dir 型是第三方文件夹对，绝不能把提示词正文写进去。
    for t in client.inject_targets.iter().filter(|t| t.mode != WriteMode::Dir) {
        let target = expand_path(&app, &t.path);
        let existing = read_text(&target);
        let bak = PathBuf::from(format!("{}{}", target.display(), BAK_SUFFIX));

        // 目标存在时决定要不要先改名备份
        if target.exists() && !existing.trim().is_empty() {
            // 判「是不是我们上次写的」：文件里带我们写进去的标记串
            let ours = t
                .marker
                .as_ref()
                .map(|m| existing.contains(m))
                .unwrap_or(false)
                || existing.contains(&t.begin_key)
                || existing.contains(MANAGED_BY_TAG);
            if ours {
                steps.push(format!("目标已是注入内容，直接覆盖：{}", target.display()));
            } else if bak.exists() {
                // 原始备份已在，别再覆盖它（备份只留最初那一份）
                steps.push(format!(
                    "原文件已存在备份，保留之：{}",
                    bak.display()
                ));
            } else {
                if let Some(d) = target.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                match std::fs::rename(&target, &bak) {
                    Ok(()) => {
                        backups.push((target.display().to_string(), bak.display().to_string()));
                        steps.push(format!("原文件已改名为 {}", bak.display()));
                    }
                    Err(e) => {
                        // 改名失败就不能往下写，否则会覆盖掉用户的原文件
                        return report_err(
                            steps,
                            format!(
                                "原文件改名失败 {} → {}：{e}",
                                target.display(),
                                bak.display()
                            ),
                        );
                    }
                }
            }
        }

        // 整份写入：署名行（alicewe，无寒霜/版本）+ frontmatter + 正文
        let fm = t.frontmatter.clone().unwrap_or_default();
        let content = if fm.trim().is_empty() {
            format!("{}{}\n", managed_header(&client.id), body.trim_end())
        } else {
            format!("{}{}\n{}\n", managed_header(&client.id), fm.trim_end(), body.trim_end())
        };
        if let Err(e) = write_utf8_no_bom(&target, &content) {
            return report_err(steps, e);
        }
        injected_files.push(InjectedFile {
            path: target.display().to_string(),
            size: content.len() as u64,
        });
        steps.push(format!(
            "写入 {}（{} 字节 · 整份接管）",
            target.display(),
            content.len()
        ));
        progress!(
            format!("target:{}", t.path),
            &format!("提示词 → {}", t.path),
            true
        );
    }

    // 4) 第三方条目延后到技能之后（见函数末尾）——
    //    顺序要求：提示词 → 技能 → 第三方。这样「包套包」时先铺好被套的
    //    底层，再往里放上层内容；反过来会出现「刚放进去就被下一层覆盖」。

    let mut failed: Vec<String> = Vec::new();
    let mut third_party_placed: Vec<PlacedThirdParty> = Vec::new();

    // 5) 技能同步
    let mut installed_skills = Vec::new();
    let mut skipped_total = 0;
    let mut skill_dirs: Vec<String> = Vec::new();
    /// 本次是否把技能包里的 `_modules` 复制了过去（卸载要据此清理）
    let mut modules_copied = false;
    if with_skills {
        // 技能源：优先用 skill_source（manifest 驱动），否则按 skill_packs 在 _assets 下找
        let mut sources: Vec<(String, PathBuf)> = Vec::new();
        if let Some(ss) = version.skill_source.as_ref().map(PathBuf::from) {
            if ss.exists() {
                sources.push(("manifest".into(), ss));
            }
        }
        for pack in &version.skill_packs {
            if let Some(p) = resolve_skill_pack(&app, pack) {
                sources.push((pack.clone(), p));
            } else {
                failed.push(format!("技能包未找到：{pack}"));
                steps.push(format!("技能包未找到：{pack}（跳过）"));
            }
        }

        if sources.is_empty() && !version.skill_packs.is_empty() {
            failed.push(format!(
                "技能包全部无法解析（该版本声明 {} 个）",
                version.skill_packs.len()
            ));
            steps.push(format!(
                "跳过技能同步（未勾选或找不到源；该版本含 {} 个技能包）",
                version.skill_packs.len()
            ));
        }

        // 安全闸：一个技能源都没有时，绝不能去动落点目录。
        // 否则「技能包全部找不到」这种情况会把用户现有技能目录改名清空，
        // 结果一个技能都没装 —— 纯毁数据。
        if sources.is_empty() {
            steps.push("没有可用的技能源，未改动任何技能目录".into());
        } else {
            // 技能落点先「改名备份 + 清空」，再放新技能。
            // 每个落点只做一次：多个技能包要装进同一个 dest，
            // 逐个 prepare 会把前一个包刚放进去的内容又清掉。
            let mut ready: Vec<(PathBuf, bool)> = Vec::new();
            for sync in &client.skill_sync {
                let dest_root = expand_path(&app, &sync.dest);
                match prepare_skill_dest(&dest_root, &mut steps) {
                    Ok(()) => {
                        skill_dirs.push(dest_root.display().to_string());
                        ready.push((dest_root, true));
                    }
                    Err(e) => {
                        failed.push(format!("技能目录准备失败：{e}"));
                        steps.push(format!("技能目录准备失败：{e}"));
                        ready.push((dest_root, false));
                    }
                }
            }

            for (label, src_dir) in &sources {
                for (dest_root, ok) in &ready {
                    if !ok {
                        continue;
                    }
                    match sync_skills(
                        src_dir,
                        dest_root,
                        skill_filter.as_deref(),
                        label,
                        skill_source_map.as_ref(),
                    ) {
                        Ok((names, skipped, copied_modules)) => {
                            let got = names.len();
                            steps.push(format!(
                                "技能 {label} → {}（{} 个，跳过未变 {} 个）",
                                dest_root.display(),
                                got,
                                skipped
                            ));
                            installed_skills.extend(names);
                            skipped_total += skipped;
                            // 记下「这个落点被复制过 _modules」——卸载时据此清理
                            if copied_modules {
                                modules_copied = true;
                            }
                            progress!(
                                format!("skill:{}", label),
                                &format!("技能包 {label}（{} 个）", got),
                                true
                            );
                        }
                        Err(e) => {
                            failed.push(format!("技能同步失败：{e}"));
                            steps.push(format!("技能同步失败：{e}"));
                            progress!(format!("skill:{}", label), &format!("技能包 {label}"), false);
                        }
                    }
                }
            }
        }
    } else if !version.skill_packs.is_empty() || version.skill_source.is_some() {
        steps.push("跳过技能同步（用户未勾选）".into());
    }

    // 模块库不再单独处理。
    //
    // `_modules` 就是技能包里的一个子目录（`skills/_modules`），
    // 由 sync_skills 跟着技能包一起复制过去。它没有独立身份，
    // 也不该有独立的注入位置 —— 早先单列一步，界面和日志里都多出
    // 一条「模块库同步」，看起来像个独立概念，实际只是技能包的一部分。
    // 有的技能包带 `_modules`、有的不带，这属于包自身的差异，不用特别处理。
    //
    // 但**卸载必须知道它装过**：`_modules` 不含 SKILL.md，进不了技能名单，
    // 只靠名单清理会把它永远留在用户的 skills 目录里（原目录本来没有）。
    // 所以这里单独记一个标志，卸载时据此删掉它。
    let modules_n = usize::from(modules_copied);

    // 7) 第三方条目（**最后一步**）
    //
    // 顺序要求：提示词 → 技能 → 第三方。
    // 第三方常是「包套包」场景（外层目录里放技能/资源），必须等技能铺完
    // 再放，否则会出现「刚放进去就被技能同步覆盖/清掉」。
    // 卸载时反过来（第三方 → 技能 → 提示词），先拆外层再拆内层。
    for tp in &client.third_party {
        let who = tp
            .label
            .as_deref()
            .map(|l| format!("第三方「{l}」"))
            .unwrap_or_else(|| "第三方".to_string());

        if tp.source.trim().is_empty() {
            failed.push(format!("{who} 的源为空（落点 {}）", tp.dest));
            steps.push(format!("{who} 源为空，跳过：→ {}", tp.dest));
            continue;
        }
        let src = expand_asset_path(&app, &tp.source);
        let dest = expand_path(&app, &tp.dest);
        if !src.exists() {
            failed.push(format!("{who} 源不存在：{}", src.display()));
            steps.push(format!("{who} 源不存在，跳过：{}", src.display()));
            continue;
        }
        if src == dest {
            steps.push(format!("{who} 源与落点相同，跳过：{}", dest.display()));
            continue;
        }

        // kind=auto（缺省）时按源的实际类型决定
        let is_file = match tp.kind.as_deref() {
            Some("file") => true,
            Some("dir") => false,
            _ => src.is_file(),
        };

        let res = if is_file {
            place_one_file(&src, &dest, tp.readonly)
                .map(|what| format!("{who} {} → {}（{what}）", src.display(), dest.display()))
        } else {
            copy_dir_merge(&src, &dest).map(|n| {
                format!("{who} {} → {}（{} 项）", src.display(), dest.display(), n)
            })
        };

        match res {
            Ok(msg) => {
                steps.push(msg);
                // 记录落点，卸载时要清掉（含只读属性）
                let placed_path = if is_file {
                    if dest.extension().is_some() {
                        dest.clone()
                    } else {
                        dest.join(src.file_name().unwrap_or_default())
                    }
                } else {
                    dest.clone()
                };
                // 目录型要记下「本次放进去的顶层条目名」，卸载时只删这些。
                // 不记的话卸载会把整个落点目录端掉 —— 而它常和技能落点是同一个目录。
                let entries: Vec<String> = if is_file {
                    vec![]
                } else {
                    std::fs::read_dir(&src)
                        .map(|rd| {
                            rd.filter_map(|e| e.ok())
                                .map(|e| e.file_name().to_string_lossy().to_string())
                                .collect()
                        })
                        .unwrap_or_default()
                };
                third_party_placed.push(PlacedThirdParty {
                    path: placed_path.display().to_string(),
                    is_file,
                    readonly: tp.readonly,
                    entries,
                });
                // 只读要连目录里的文件一起处理（云记忆目录同样会被客户端改写）
                if tp.readonly && !is_file {
                    match set_readonly_tree(&dest, true) {
                        Ok(n) => steps.push(format!("已设为只读 {} 个文件（防客户端篡改）", n)),
                        Err(e) => {
                            failed.push(format!("{who} 设只读失败：{e}"));
                            steps.push(format!("设只读失败：{e}"));
                        }
                    }
                }
                progress!(
                    format!("third:{}", tp.dest),
                    &format!("{who} → {}", tp.dest),
                    true
                );
            }
            Err(e) => {
                failed.push(format!("{who} 复制失败：{e}"));
                steps.push(format!("{who} 复制失败：{e}"));
                progress!(format!("third:{}", tp.dest), &format!("{who} → {}", tp.dest), false);
            }
        }
    }

    // 8) 状态
    let st = InstallState {
        version_id: Some(version.id.clone()),
        version_label: Some(version.label.clone()),
        installed_skills: installed_skills.clone(),
        installed_modules: modules_n,
        installed_at: Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        ),
        backups,
        injected_files,
        skill_dirs,
        third_party_placed,
    };
    if let Err(e) = write_state(&app, &client, &st) {
        steps.push(format!("状态写入警告：{e}"));
    } else {
        steps.push("安装状态已记录".into());
    }

    // 真实成败：有任何一步失败就 ok=false 并回报原因。
    // 早先这里硬编码 ok:true —— 于是「技能一个没装、第三方没复制」也照样弹
    // 「注入完成」，用户看到的就是「右下角显示注入成功实则失败」。
    let ok = failed.is_empty();
    InstallReport {
        ok,
        steps,
        skills_installed: installed_skills,
        skills_skipped: skipped_total,
        error: if ok {
            None
        } else {
            Some(failed.join("；"))
        },
    }
}

fn report_err(steps: Vec<String>, e: impl Into<String>) -> InstallReport {
    InstallReport {
        ok: false,
        steps,
        skills_installed: vec![],
        skills_skipped: 0,
        error: Some(e.into()),
    }
}

/// 卸载：摘块（或从固定名备份还原）+ 只删本工具装过的技能
///
/// 进度上报：同安装，emit `inject:progress`（phase = "uninstall"）。
/// 同 `inject_install`，必须是 async 才不卡住主线程的渲染。
#[tauri::command(async)]
pub fn inject_uninstall(app: AppHandle, client: ClientSpec, restore_backup: bool) -> InstallReport {
    macro_rules! progress {
        ($key:expr, $label:expr, $ok:expr) => {{
            let _ = app.emit(
                "inject:progress",
                serde_json::json!({
                    "phase": "uninstall",
                    "key": $key,
                    "label": $label,
                    "ok": $ok,
                }),
            );
        }};
    }
    let mut steps = Vec::new();
    let st = read_state(&app, &client);
    let mut failed: Vec<String> = Vec::new();

    // ---- 先上报「计划」：界面据此画出全部待办行（含待办态）----
    {
        let mut plan: Vec<serde_json::Value> = Vec::new();
        for f in &st.injected_files {
            plan.push(serde_json::json!({
                "key": format!("file:{}", f.path),
                "label": format!("移除 {}", f.path),
            }));
        }
        if !st.installed_skills.is_empty() {
            plan.push(serde_json::json!({
                "key": "skills",
                "label": format!("清理技能 {} 个", st.installed_skills.len()),
            }));
        }
        for item in &st.third_party_placed {
            plan.push(serde_json::json!({
                "key": format!("third:{}", item.path),
                "label": format!("移除第三方 {}", item.path),
            }));
        }
        let _ = app.emit(
            "inject:plan",
            serde_json::json!({ "phase": "uninstall", "items": plan }),
        );
    }


    // 卸载 = 删除本次注入放进去的内容 + 把 `<路径>-bak` 改回原名。
    //
    // 安全性靠字节数比对：只有「当前文件大小 == 注入时记录的大小」才认为
    // 没人动过它，可以放心删；大小不同说明用户改过，保留文件并报告，
    // 绝不把用户内容删掉。技能目录同理，比对目录里的技能数。
    let mut targets: Vec<(String, Option<u64>)> = st
        .injected_files
        .iter()
        .map(|f| (f.path.clone(), Some(f.size)))
        .collect();
    // 兼容没有 injectedFiles 记录的旧状态：退回按注入目标逐个处理
    // （同样要排除 dir 型 —— 那是第三方目录，不是我们写进去的文件，不能删）
    if targets.is_empty() {
        for t in client.inject_targets.iter().filter(|t| t.mode != WriteMode::Dir) {
            targets.push((expand_path(&app, &t.path).display().to_string(), None));
        }
    }

    for (path, expect_size) in &targets {
        let target = PathBuf::from(path);
        let bak = PathBuf::from(format!("{path}{BAK_SUFFIX}"));
        if !target.exists() {
            // 文件不在，但备份还在 → 还是把原文件还原回去
            if bak.exists() {
                match std::fs::rename(&bak, &target) {
                    Ok(()) => steps.push(format!("文件已不在，从备份还原原名：{}", target.display())),
                    Err(e) => failed.push(format!("还原失败 {}：{e}", target.display())),
                }
            } else {
                steps.push(format!("目标不存在，跳过：{}", target.display()));
            }
            continue;
        }

        let cur = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        let untouched = match expect_size {
            Some(want) => cur == *want,
            // 旧状态没有记录：用产物标记判定
            None => is_injection_artifact(&read_text(&target)),
        };

        if !untouched {
            failed.push(format!(
                "{} 已被修改（当前 {cur} 字节，注入时 {} 字节），保留不动",
                target.display(),
                expect_size.map(|s| s.to_string()).unwrap_or_else(|| "未记录".into())
            ));
            continue;
        }

        if let Err(e) = std::fs::remove_file(&target) {
            failed.push(format!("删除失败 {}：{e}", target.display()));
            progress!(format!("file:{}", path).as_str(), &format!("移除 {}", target.display()), false);
            continue;
        }
        steps.push(format!("已删除注入内容：{}", target.display()));
        progress!(format!("file:{}", path).as_str(), &format!("移除 {}", target.display()), true);

        if restore_backup && bak.exists() {
            match std::fs::rename(&bak, &target) {
                Ok(()) => steps.push(format!("原文件已还原：{}", target.display())),
                Err(e) => failed.push(format!("还原失败 {}：{e}", target.display())),
            }
        }
    }

    // 技能目录：删掉本次装进去的技能，再把 `<目录>-bak` 改回原名。
    // 记录里没有 skillDirs 时，退回按 skill_sync 落点处理。
    let dirs: Vec<String> = if st.skill_dirs.is_empty() {
        client
            .skill_sync
            .iter()
            .map(|s| expand_path(&app, &s.dest).display().to_string())
            .collect()
    } else {
        st.skill_dirs.clone()
    };
    let mut removed = 0;
    // 技能这一步是否处理过（哪怕删了 0 个也要回报，否则进度弹窗里
    // 「清理技能」永远停在待办 —— 用户看到的就是「不显示状态」）
    let mut skills_step_done = false;
    for d in &dirs {
        let dest_root = PathBuf::from(d);
        let name = dest_root
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|| "skills".into());
        let bak = dest_root.with_file_name(format!("{name}{BAK_SUFFIX}"));

        // 只删本工具装过的技能（状态清单里记录过的名字）
        if dest_root.is_dir() {
            skills_step_done = true;
            for n in &st.installed_skills {
                let sk = dest_root.join(n);
                if sk.is_dir() && sk.join("SKILL.md").exists() && std::fs::remove_dir_all(&sk).is_ok() {
                    removed += 1;
                }
            }
            /*
             * `_modules` 也要清掉。
             *
             * 它是安装时由 sync_skills 随技能包一起复制过去的（`skills/_modules`），
             * 但**从来没被记进 installed_skills 名单** —— 因为名单只收「含 SKILL.md
             * 的技能目录」。于是卸载时这里扫不到它，166 个 md 就永远留在用户的
             * skills 目录里，而原目录本来没有这个东西。
             *
             * 判定依据用安装时记下的 `installed_modules > 0`（表示本次确实复制过
             * `_modules`），而不是「目录存在就删」—— 后者会误删用户自己建的
             * 同名目录。也不能用 installed_skills 非空来判断：用户可能把技能
             * 全取消勾选，但 `_modules` 仍然会被复制（它在勾选筛选之前处理）。
             */
            if st.installed_modules > 0 {
                let mods = dest_root.join("_modules");
                if mods.is_dir() && std::fs::remove_dir_all(&mods).is_ok() {
                    steps.push(format!("已清理模块目录：{}", mods.display()));
                }
            }
            // 装完就只剩空目录了 → 整个删掉，把 -bak 换回来
            let now_empty = std::fs::read_dir(&dest_root)
                .map(|mut rd| rd.next().is_none())
                .unwrap_or(false);
            if now_empty {
                let _ = std::fs::remove_dir(&dest_root);
            }
        }
        // 目录不存在也算这一步走完了（可能被第三方那步先清空）——
        // 关键是**一定要发事件**，否则界面那行点不亮
        if !skills_step_done && !dest_root.exists() {
            skills_step_done = true;
        }

        if restore_backup && bak.is_dir() {
            if dest_root.exists() {
                // 目标还在（目录被占用删不掉，或用户又放了东西）。
                // 目录被客户端占用时它是删不掉的，此时把 bak 的内容搬回来 ——
                // 与「改回原名」对用户是同一个结果（技能回到原位）。
                let leftover = std::fs::read_dir(&dest_root)
                    .map(|mut rd| rd.next().is_some())
                    .unwrap_or(false);
                match move_contents(&bak, &dest_root) {
                    Ok(n) => {
                        steps.push(format!(
                            "技能目录已还原：{}（{} 项{}）",
                            dest_root.display(),
                            n,
                            if leftover { " · 目录被占用，内容已合并回原位" } else { "" }
                        ));
                        // 搬空后的 bak 清掉，避免下次误判「已有备份」
                        let _ = std::fs::remove_dir_all(&bak);
                    }
                    Err(e) => failed.push(format!(
                        "技能目录还原失败 {}：{e}（原始备份仍在 {}）",
                        dest_root.display(),
                        bak.display()
                    )),
                }
            } else {
                match std::fs::rename(&bak, &dest_root) {
                    Ok(()) => steps.push(format!("技能目录已还原：{}", dest_root.display())),
                    Err(e) => failed.push(format!("技能目录还原失败 {}：{e}", dest_root.display())),
                }
            }
        }
    }
    if removed > 0 {
        steps.push(format!("清理本工具安装的技能 {removed} 个"));
    }
    // 无条件上报：删了 0 个也要把这一行标记完成。
    // 早先写成 `if removed > 0 { progress!(...) }` —— 当技能目录已被
    // 第三方那步清空、或清单里没有已装技能时，这条事件永不发出，
    // 进度弹窗里「清理技能」就永远停在「待办」。
    if skills_step_done {
        progress!(
            "skills",
            &format!(
                "清理技能 {}",
                if removed > 0 { format!("{removed} 个") } else { "（无）".into() }
            ),
            true
        );
    }

    // 第三方条目：删掉本次放进去的内容。
    // 必须先清只读属性 —— 只读文件 remove_file 会直接失败（os error 5）。
    // 记录里没有 thirdPartyPlaced 时，退回按 manifest 的 dest 逐个处理。
    let placed: Vec<PlacedThirdParty> = if st.third_party_placed.is_empty() {
        client
            .third_party
            .iter()
            .map(|tp| {
                let dest = expand_path(&app, &tp.dest);
                let src = expand_asset_path(&app, &tp.source);
                let is_file = match tp.kind.as_deref() {
                    Some("file") => true,
                    Some("dir") => false,
                    _ => src.is_file(),
                };
                let path = if is_file && dest.extension().is_none() {
                    dest.join(src.file_name().unwrap_or_default())
                } else {
                    dest
                };
                PlacedThirdParty {
                    path: path.display().to_string(),
                    is_file,
                    readonly: tp.readonly,
                    // 旧状态没有 entries 记录 → 空数组，下面会退回「整目录删」的保守做法
                    entries: vec![],
                }
            })
            .collect()
    } else {
        st.third_party_placed.clone()
    };
    let mut tp_removed = 0;
    for item in &placed {
        let p = PathBuf::from(&item.path);
        if !p.exists() {
            // 已经被前一步（或用户）删掉了 —— 仍然要把这一行标记完成，
            // 否则进度弹窗里永远停在「待办」
            progress!(format!("third:{}", item.path).as_str(), &format!("移除 {}", p.display()), true);
            continue;
        }

        let done = if item.is_file {
            // 文件型：清只读后直接删
            if item.readonly {
                let _ = set_readonly(&p, false);
            }
            std::fs::remove_file(&p).is_ok()
        } else if !item.entries.is_empty() {
            /*
             * 目录型且有 entries 记录：**只删自己放进去的那几个顶层条目**。
             *
             * 关键：第三方落点常常和技能落点是同一个目录（如都指向
             * ~/.codex/skills）。早先这里直接 remove_dir_all(path)，
             * 会把技能那一步要清理的东西一并端掉 —— 于是技能步骤变成
             * 空操作，进度条上那行永远停在「待办」。
             * 现在只删自己的条目，两步互不干扰。
             */
            if item.readonly {
                let _ = set_readonly_tree(&p, false);
            }
            let mut ok = true;
            for name in &item.entries {
                let child = p.join(name);
                if !child.exists() {
                    continue;
                }
                let r = if child.is_dir() {
                    std::fs::remove_dir_all(&child)
                } else {
                    std::fs::remove_file(&child)
                };
                if r.is_err() {
                    ok = false;
                }
            }
            // 目录空了才顺手删掉它（有别的步骤的东西在里面就保留）
            let now_empty = std::fs::read_dir(&p)
                .map(|mut rd| rd.next().is_none())
                .unwrap_or(false);
            if now_empty {
                let _ = std::fs::remove_dir(&p);
            }
            ok
        } else {
            // 旧状态没有 entries 记录：保守起见整目录删（旧行为）
            if item.readonly {
                let _ = set_readonly_tree(&p, false);
            }
            std::fs::remove_dir_all(&p).is_ok()
        };

        if done {
            tp_removed += 1;
            steps.push(format!("已移除第三方内容：{}", p.display()));
            progress!(format!("third:{}", item.path).as_str(), &format!("移除 {}", p.display()), true);
        } else {
            failed.push(format!("第三方内容删除失败：{}", p.display()));
            progress!(format!("third:{}", item.path).as_str(), &format!("移除 {}", p.display()), false);
        }
    }
    if tp_removed > 0 {
        steps.push(format!("清理第三方条目 {tp_removed} 项"));
    }

    let mut st2 = st.clone();
    st2.version_id = None;
    st2.version_label = None;
    st2.installed_skills.clear();
    st2.backups.clear();
    st2.injected_files.clear();
    st2.skill_dirs.clear();
    st2.third_party_placed.clear();
    let _ = write_state(&app, &client, &st2);
    steps.push("安装状态已清空".into());

    let ok = failed.is_empty();
    InstallReport {
        ok,
        steps,
        skills_installed: vec![],
        skills_skipped: 0,
        error: if ok { None } else { Some(failed.join("；")) },
    }
}

// ============================================================
// 真实文件扫描（技能库 / 提示词库从磁盘读，不用前端种子数据）
// ============================================================

/// 一个技能包（磁盘上的真实目录）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    pub name: String,
    /// 绝对路径
    pub path: String,
    /// SKILL.md 里的 name（若有 frontmatter）
    pub title: String,
    /// SKILL.md 里的 description（若有）
    pub description: String,
    /// 文件数（递归）
    pub files: usize,
    /// SKILL.md 的字节数
    pub skill_md_len: u64,
    /// 最近修改时间（秒）
    pub mtime: u64,
    /// 是否合规（以 --- frontmatter 开头且含 name/description）
    pub valid: bool,
    /// 子路由技能（subskills/<名>/SKILL.md）—— 旧版路由型技能
    pub sub_skills: Vec<String>,
    /// 是否有 references/ 参考树
    pub has_references: bool,
    /// 是否有 scripts/ 工具目录
    pub has_scripts: bool,
    /// 目录形态：simple（单 SKILL.md） | router（带 subskills） | tree（带 references/scripts）
    pub shape: String,
}

/// 递归统计文件数
fn count_files(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                n += count_files(&p);
            } else {
                n += 1;
            }
        }
    }
    n
}

/// 从 SKILL.md 的 YAML frontmatter 提取 name / description / 是否合规
pub fn parse_skill_frontmatter(text: &str) -> (String, String, bool) {
    let mut name = String::new();
    let mut desc = String::new();
    let t = text.trim_start_matches('\u{feff}'); // 去 BOM
    if !t.starts_with("---") {
        return (name, desc, false);
    }
    let rest = &t[3..];
    let Some(end) = rest.find("\n---") else {
        return (name, desc, false);
    };
    let fm = &rest[..end];
    for line in fm.lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("name:") {
            name = v.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(v) = l.strip_prefix("description:") {
            desc = v.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }
    let valid = !name.is_empty() && !desc.is_empty();
    (name, desc, valid)
}

/// 扫描一个技能包目录（含子路由/参考树识别）
pub fn scan_skill_dir(root: &Path) -> Vec<SkillItem> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut out = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let md = p.join("SKILL.md");
        if !md.exists() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == "_modules" {
            continue;
        }
        let text = std::fs::read_to_string(&md).unwrap_or_default();
        let (title, description, valid) = parse_skill_frontmatter(&text);
        let mtime = md
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // 子路由：subskills/<名>/SKILL.md
        let mut sub_skills = Vec::new();
        if let Ok(sub) = std::fs::read_dir(p.join("subskills")) {
            for s in sub.filter_map(|e| e.ok()) {
                if s.path().join("SKILL.md").exists() {
                    sub_skills.push(s.file_name().to_string_lossy().to_string());
                }
            }
        }
        sub_skills.sort();
        let has_references = p.join("references").is_dir();
        let has_scripts = p.join("scripts").is_dir();

        // 形态判定：router 优先（会影响安装与引用路径）
        let shape = if !sub_skills.is_empty() {
            "router"
        } else if has_references || has_scripts {
            "tree"
        } else {
            "simple"
        }
        .to_string();

        out.push(SkillItem {
            name,
            path: p.display().to_string(),
            title,
            description,
            files: count_files(&p),
            skill_md_len: md.metadata().map(|m| m.len()).unwrap_or(0),
            mtime,
            valid,
            sub_skills,
            has_references,
            has_scripts,
            shape,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 已安装技能（读某客户端的 skills 目录）
#[tauri::command]
pub fn scan_installed_skills(app: AppHandle, client: ClientSpec) -> Vec<SkillItem> {
    let mut all = Vec::new();
    for sync in &client.skill_sync {
        let dir = expand_path(&app, &sync.dest);
        let mut items = scan_skill_dir(&dir);
        // 标注来源目录
        for it in items.iter_mut() {
            if !it.path.contains(&sync.dest.replace('~', "")) {
                it.name = format!("{}", it.name);
            }
        }
        all.extend(items);
    }
    all
}

/// 技能包根目录解析：
///   新结构：_assets/skill/<包名>/skills/<技能>/
///   兼容旧结构：_assets/<包名>/<技能>/  与  _assets/<包名>/materials/skills/<技能>/
pub fn shipped_skill_pack_root(app: &AppHandle, pack: &str) -> Option<PathBuf> {
    let assets = runtime_root(app).join("_assets");
    let cands = [
        // 新结构
        assets.join("skill").join(pack).join("skills"),
        // 旧结构兼容
        assets.join(pack).join("materials/skills"),
        assets.join(pack),
    ];
    cands.into_iter().find(|c| c.is_dir())
}

/// 技能包的模块库目录（_modules）
///
/// 随包技能库（_assets 下的技能包，供选择安装）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillPack {
    pub id: String,
    pub path: String,
    pub skills: Vec<SkillItem>,
    /// 该包的展示名（可由用户命名，读 pack.json）
    pub title: String,
    /// 是否为用户自建包
    pub custom: bool,
}

/// 技能包的元数据文件（用户可命名/描述）
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackMeta {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub custom: bool,
}

fn read_pack_meta(dir: &Path) -> PackMeta {
    std::fs::read_to_string(dir.join("pack.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 写入技能包元数据（用户命名）
#[tauri::command]
pub fn save_pack_meta(app: AppHandle, pack: String, meta: PackMeta) -> Result<(), String> {
    let dir = shipped_skill_pack_root(&app, &pack)
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .ok_or_else(|| format!("技能包不存在：{pack}"))?;
    let js = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    write_utf8_no_bom(&dir.join("pack.json"), &js)
}

/// 新建一个空技能包（用户自建）
#[tauri::command]
pub fn create_skill_pack(app: AppHandle, id: String, title: String) -> Result<String, String> {
    let clean: String = id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if clean.is_empty() {
        return Err("包名不能为空".into());
    }
    let dir = runtime_root(&app).join("_assets/skill").join(&clean);
    if dir.exists() {
        return Err(format!("技能包已存在：{clean}"));
    }
    std::fs::create_dir_all(dir.join("skills")).map_err(|e| e.to_string())?;
    let meta = PackMeta {
        title: if title.is_empty() { clean.clone() } else { title },
        desc: String::new(),
        custom: true,
    };
    save_pack_meta(app, clean.clone(), meta)?;
    Ok(dir.display().to_string())
}

/// 删除技能包（整包删除，含其中的技能）
#[tauri::command]
pub fn delete_skill_pack(app: AppHandle, pack: String) -> Result<(), String> {
    let root = shipped_skill_pack_root(&app, &pack)
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .ok_or_else(|| format!("技能包不存在：{pack}"))?;
    std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(())
}

/// 扫描单个技能包
pub fn scan_one_pack(app: &AppHandle, pack: &str) -> Option<SkillPack> {
    let root = shipped_skill_pack_root(app, pack)?;
    let meta = read_pack_meta(root.parent().unwrap_or(&root));
    Some(SkillPack {
        id: pack.to_string(),
        path: root.display().to_string(),
        skills: scan_skill_dir(&root),
        title: if meta.title.is_empty() {
            pack.to_string()
        } else {
            meta.title
        },
        custom: meta.custom,
    })
}

/// 随包技能库扫描。
///
/// 为什么是 `async`：实测本函数要 497ms（遍历 6 个技能包的目录树 +
/// 逐个读 SKILL.md 解析 frontmatter）。同步 command 会占住主线程，
/// 进「技能库」/「目标」页时就是一次可感知的卡顿。
/// 与 engine_probe 同一个坑，见 runtime.rs 里的详细说明。
#[tauri::command(async)]
pub fn scan_shipped_skill_packs(app: AppHandle) -> Vec<SkillPack> {
    let base = runtime_root(&app).join("_assets/skill");
    let Ok(rd) = std::fs::read_dir(&base) else {
        return vec![];
    };
    let mut out = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        if !e.path().is_dir() {
            continue;
        }
        let id = e.file_name().to_string_lossy().to_string();
        if let Some(p) = scan_one_pack(&app, &id) {
            out.push(p);
        }
    }
    out.sort_by(|a, b| b.custom.cmp(&a.custom).then(a.id.cmp(&b.id)));
    out
}

/// 提示词文件（磁盘上的真实 .md）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PromptItem {
    pub file: String,
    pub path: String,
    /// 来源目录标签（_assets/prompts、.codex/prompts、懒人包 …）
    pub source: String,
    pub size: u64,
    pub mtime: u64,
    /// 正文首行非空内容（预览用，取自真实文件）
    pub preview: String,
    /// 是否含模板占位符
    pub has_placeholders: bool,
}

fn scan_prompts_in(dir: &Path, source: &str, out: &mut Vec<PromptItem>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if !p.is_file() || p.extension().map(|x| x != "md").unwrap_or(true) {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let preview = text
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty() && !l.starts_with("<!--"))
            .unwrap_or("")
            .chars()
            .take(90)
            .collect::<String>();
        let has_placeholders = text.contains("{{");
        out.push(PromptItem {
            file: e.file_name().to_string_lossy().to_string(),
            path: p.display().to_string(),
            source: source.to_string(),
            size: p.metadata().map(|m| m.len()).unwrap_or(0),
            mtime: p
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            preview,
            has_placeholders,
        });
    }
}

/// 扫描全部真实提示词文件（多来源）
#[tauri::command]
pub fn scan_prompts(app: AppHandle) -> Vec<PromptItem> {
    let root = runtime_root(&app);
    let mut out = Vec::new();
    // 只扫 `_assets/prompts`（用户要求：提示词读取目录只认这里，不读其它地方）。
    //
    // 注意：这只影响**提示词页的列表**。安装时按 manifest 的 asset/file/path
    // 解析提示词照旧走 `resolve_prompt`（含历史候选目录），已有的预设组不受影响。
    scan_prompts_in(&root.join("_assets/prompts"), "_assets/prompts", &mut out);
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

/// 便携 codex 提示词选择：列出 `.codex/prompts` 里的 .md，供「选择 + 注入」。
///
/// 与 scan_prompt_sources 的区别：那个是体检用的「来源统计」（列的是软件库），
/// 这个是**注入选择器** —— 只列便携箱自己的目录，因为 config.toml 的
/// model_instructions_file 相对 CODEX_HOME 解析，指向软件库目录是无效配置。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexPromptOption {
    pub name: String,
    /// 绝对路径
    pub path: String,
    pub size: u64,
    /// 是否当前被 model_instructions_file 指向
    pub active: bool,
}

#[tauri::command(async)]
pub fn list_codex_prompts(app: AppHandle) -> Vec<CodexPromptOption> {
    let dir = runtime_root(&app).join(".codex/prompts");
    let cfg = runtime_root(&app).join(".codex/config.toml");
    let active = {
        let v = crate::runtime::toml_scalar(&std::fs::read_to_string(&cfg).unwrap_or_default(), "model_instructions_file");
        let v = v.trim_start_matches("./").replace('\\', "/");
        v.rsplit('/').next().unwrap_or("").to_string()
    };
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            // 只收 .md，跳过编辑备份（.bak-edit-*）
            if !p.is_file() || p.extension().map(|x| x != "md").unwrap_or(true) || name.contains(".bak") {
                continue;
            }
            out.push(CodexPromptOption {
                active: !active.is_empty() && name == active,
                size: p.metadata().map(|m| m.len()).unwrap_or(0),
                path: p.display().to_string(),
                name,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 注入：把选中的提示词写成唯一生效的那一份。
///
/// 落地：改写 config.toml 的 model_instructions_file = "./prompts/<name>"。
/// 单值约束就落在这里 —— codex 只认一个全局指令文件。
///
/// ══ 导入提示词到便携箱 ═════════════════════════════════════════════
/// 便携箱导入（runtime::codex_import_portable）之后 `.codex/prompts` 是
/// 空目录 —— 本机 ~/.codex 通常没有 prompts。给一个直接入口：
/// 系统对话框选 .md（可多选）→ 复制进 .codex/prompts，同名先备份。
/// 与「提示词页从软件库复制」互补：这里不要求先入软件库。
#[tauri::command(async)]
pub fn import_prompts_to_codex(app: AppHandle, files: Vec<String>) -> Result<Vec<String>, String> {
    let dir = runtime_root(&app).join(".codex/prompts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 prompts 目录失败: {e}"))?;
    let mut imported = Vec::new();
    for raw in files {
        let p = PathBuf::from(&raw);
        if !p.is_file() {
            continue;
        }
        // 只收 .md；跳过编辑备份
        let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if !name.to_ascii_lowercase().ends_with(".md") || name.contains(".bak") {
            continue;
        }
        let to = dir.join(&name);
        if to.exists() {
            let bak = dir.join(format!(
                "{name}.bak-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
            ));
            let _ = std::fs::rename(&to, &bak);
        }
        match std::fs::copy(&p, &to) {
            Ok(_) => imported.push(name),
            Err(e) => return Err(format!("复制 {} 失败: {e}", name)),
        }
    }
    Ok(imported)
}
/// 原配置先备份为 config.toml.bak-instr-<ts>。
#[tauri::command(async)]
pub fn inject_codex_prompt(app: AppHandle, name: String) -> Result<String, String> {
    let root = runtime_root(&app);
    let home = root.join(".codex");
    let target = home.join("prompts").join(&name);
    if !target.is_file() {
        return Err(format!("提示词不存在：{}", target.display()));
    }
    let cfg_path = home.join("config.toml");
    let text = std::fs::read_to_string(&cfg_path)
        .map_err(|e| format!("读 config.toml 失败：{e}"))?;
    if text.trim().is_empty() {
        return Err("config.toml 为空".into());
    }

    let want = format!("./prompts/{name}");
    let mut replaced = false;
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        if raw.trim_start().starts_with("model_instructions_file") {
            lines.push(format!("model_instructions_file = \"{want}\""));
            replaced = true;
        } else {
            lines.push(raw.to_string());
        }
    }
    if !replaced {
        // 原本没这一项 → 插到文件头（顶层键必须在任何 [table] 段之前）
        let mut it = lines.insert(0, format!("model_instructions_file = \"{want}\""));
        let _ = &mut it;
    }
    let mut next = lines.join("\n");
    if text.ends_with('\n') && !next.ends_with('\n') {
        next.push('\n');
    }

    let bak = home.join(format!("config.toml.bak-instr-{}", stamp_pub()));
    let _ = std::fs::write(&bak, text.as_bytes());
    write_utf8_no_bom(&cfg_path, &next)?;
    Ok(want)
}

/// 便携箱技能导入结果（复用技能包导入的 DTO 形状）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkillImport {
    pub name: String,
    /// 落盘后的绝对路径
    pub target: String,
    pub title: String,
    pub description: String,
    pub valid: bool,
    pub files: usize,
    /// 同名被顶掉时的备份路径
    pub backup: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkillImportReport {
    pub imported: Vec<CodexSkillImport>,
    pub skipped: Vec<String>,
}

/// 便携箱技能库：把用户选的文件夹（可多选，系统对话框）里的技能
/// 批量复制进 `.codex/skills`。
///
/// ══ 便携箱技能导入：**纯复制语义**（用户明确要求，v3）═══════════════
/// 选中的每个文件夹 → **按原样整目录复制**到 `.codex/skills/<文件夹名>`。
///
/// · 不识别、不收集、不下钻、不拆包：选 `skills` 就得到
///   `skills/skills/<原内容>`；选 `alice-ai` 就得到 `skills/alice-ai/<原内容>`。
/// · 同名目录已存在 → 整目录改名备份（.bak-时间戳）后复制，不静默覆盖。
/// · 不弹导入结果窗：完成后只刷新列表 + toast 一句摘要。
///
/// 旧实现（collect 识别式导入）会下钻拆包：选 7 个技能包被拆成 300+
/// 平铺技能（真机踩坑，用户两次指出），本版彻底移除该行为。
#[tauri::command(async)]
pub fn import_skills_to_codex(
    app: AppHandle,
    src_paths: Vec<String>,
) -> Result<CodexSkillImportReport, String> {
    if src_paths.is_empty() {
        return Ok(CodexSkillImportReport {
            imported: vec![],
            skipped: vec![],
        });
    }
    let home = runtime_root(&app).join(".codex");
    let dest = home.join("skills");
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    let mut imported: Vec<CodexSkillImport> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for raw in src_paths {
        let dir = PathBuf::from(&raw);
        if !dir.is_dir() {
            skipped.push(format!("不是目录：{raw}"));
            continue;
        }
        let Some(name) = dir.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let target = dest.join(&name);
        let mut backup = None;
        if target.exists() {
            let bak = dest.join(format!("{name}.bak-{}", stamp_pub()));
            let _ = std::fs::remove_dir_all(&bak);
            if let Ok(_) = std::fs::rename(&target, &bak) {
                backup = Some(bak.display().to_string());
            }
        }
        if let Err(e) = copy_dir_pub(&dir, &target) {
            skipped.push(format!("复制失败 {name}：{e}"));
            continue;
        }
        let text = std::fs::read_to_string(target.join("SKILL.md")).unwrap_or_default();
        let (title, description, valid) = parse_skill_frontmatter(&text);
        imported.push(CodexSkillImport {
            files: count_files_pub(&target),
            title,
            description,
            valid,
            name,
            target: target.display().to_string(),
            backup,
        });
    }

    let n = imported.len();
    let _ = &app; // 便携箱导入走 toast 摘要，不再向运行日志发事件
    Ok(CodexSkillImportReport { imported, skipped })
}

/// 便携箱技能库：列出 .codex/skills 里已装的技能（供展示/管理）
#[tauri::command(async)]
pub fn list_codex_skills(app: AppHandle) -> Vec<CodexSkillImport> {
    let dir = runtime_root(&app).join(".codex/skills");
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if !p.is_dir() || name.starts_with('.') || name.contains(".bak-") {
                continue;
            }
            // 只收真技能：目录里必须有 SKILL.md。
            //
            // 实测（2026-09-20）：.codex/skills 里混着 73 个空目录和
            // 1 个只有空 scripts 的目录（历史同步残留），不过滤的话
            // 列表会列出 305 项，其中 74 项是「无 SKILL.md / 0 文件」的
            // 空壳，与左侧体检的技能数对不上，用户还以为导入丢了东西。
            if !p.join("SKILL.md").is_file() {
                continue;
            }
            let text = std::fs::read_to_string(p.join("SKILL.md")).unwrap_or_default();
            let (title, description, valid) = parse_skill_frontmatter(&text);
            out.push(CodexSkillImport {
                files: count_files_pub(&p),
                title,
                description,
                valid,
                name,
                target: p.display().to_string(),
                backup: None,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 便携箱有效技能数（与 list_codex_skills 同一口径：有 SKILL.md 的目录）。
///
/// 为什么要单独一个命令：体检项「Alice 技能库」用的是 dir_count（数一级
/// 目录），把空目录也算进去 —— 两侧数字对不上（实测 308 vs 305），
/// 用户以为数据丢了。体检行改用这个口径后两侧一致。
#[tauri::command(async)]
pub fn count_codex_skills(app: AppHandle) -> usize {
    let dir = runtime_root(&app).join(".codex/skills");
    let mut n = 0usize;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() && !name.starts_with('.') && !name.contains(".bak-") && p.join("SKILL.md").is_file() {
                n += 1;
            }
        }
    }
    n
}

/// 便携箱技能库根目录绝对路径（「打开目录」按钮用）。
///
/// 为什么不叫前端拼：包根由后端探测（runtime_root），前端拼相对路径
/// 会踩分隔符/找不到目录的坑；实测之前用「第一个技能的 target」当目录打开，
/// 排序后第一个是技能子目录而不是库根 —— 打开的位置完全不对。
#[tauri::command(async)]
pub fn codex_skills_root(app: AppHandle) -> String {
    // 不存在就创建：导入便携箱后 skills 可能是空的，「打开目录」必须能
    // 打开一个真实存在的位置 —— explorer 对不存在的路径会打开默认视图
    // （用户看到的「打开了其他目录」就是这个原因）。
    let dir = runtime_root(&app).join(".codex/skills");
    let _ = std::fs::create_dir_all(&dir);
    dir.display().to_string()
}

/// 从便携箱技能库移除一个技能（只删 .codex/skills 里的副本，不动源）
#[tauri::command(async)]
pub fn remove_codex_skill(app: AppHandle, name: String) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() || n.contains("..") || n.contains('/') || n.contains('\\') {
        return Err(format!("非法技能名：{name}"));
    }
    let target = runtime_root(&app).join(".codex/skills").join(n);
    if !target.is_dir() {
        return Err(format!("技能不存在：{}", target.display()));
    }
    std::fs::remove_dir_all(&target).map_err(|e| format!("{}: {e}", target.display()))
}

fn stamp_pub() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 读文件正文（技能/提示词编辑器用）
#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// 写文件正文（原子写 + UTF-8 无 BOM）
#[tauri::command]
pub fn save_file_text(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    // 备份原文件（.bak-edit-<ts>），保留最近 3 份
    if p.exists() {
        let _ = backup_stamped(&p, "bak-edit");
    }
    write_utf8_no_bom(&p, &content)
}

/// 删除文件或目录（技能/提示词删除；进回收站由前端确认后调用）
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

/// 某版本的配套真实数据（技能 + 提示词），用于「随版本切换」的面板
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VersionBundle {
    pub version_id: String,
    /// 该版本用的提示词文件（已解析到真实路径）
    pub prompt_file: String,
    pub prompt_path: Option<String>,
    pub prompt_text: String,
    pub prompt_size: u64,
    /// 该版本的技能包（含每个技能的真实描述）
    pub packs: Vec<SkillPack>,
    /// 所有可选提示词（供二级选择预览）
    pub all_prompts: Vec<PromptItem>,
}

#[tauri::command]
pub fn version_bundle(app: AppHandle, client: ClientSpec, version: VersionSpec) -> VersionBundle {
    let all_prompts = scan_prompts(app.clone());

    // 提示词：优先按版本 file 解析
    let prompt_path = resolve_prompt(&app, &version.file).ok();
    let prompt_text = prompt_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();

    // 只扫描该版本声明的技能包（含 manifest 直接指定的源目录）
    let mut packs = Vec::new();
    if let Some(src) = version.skill_source.as_ref().map(PathBuf::from) {
        if src.is_dir() {
            packs.push(SkillPack {
                id: src
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "custom".into()),
                title: "自定义技能目录".into(),
                custom: true,
                path: src.display().to_string(),
                skills: scan_skill_dir(&src),
            });
        }
    }
    for id in &version.skill_packs {
        // 统一走 scan_one_pack（含标题与自定义标记）
        if let Some(p) = scan_one_pack(&app, id) {
            packs.push(p);
        }
    }

    let _ = client;
    VersionBundle {
        version_id: version.id.clone(),
        prompt_file: version.file.clone(),
        prompt_path: prompt_path.map(|p| p.display().to_string()),
        prompt_size: prompt_text.len() as u64,
        prompt_text,
        packs,
        all_prompts,
    }
}

/// 把用户自备的技能目录复制进某个技能库（手动添加额外技能）
///
/// 校验：
///   · 源目录必须存在且含 SKILL.md（否则不是合法技能）
///   · frontmatter 应含 name/description（不合规给出警告但仍允许，与旧版宽容策略一致）
///   · 目标同名目录已存在时先备份为 <名字>.bak-<ts>，不静默覆盖用户的东西
#[tauri::command]
pub fn import_skill_dir(
    app: AppHandle,
    src_dir: String,
    pack_id: String,
) -> Result<serde_json::Value, String> {
    let src = PathBuf::from(&src_dir);
    if !src.is_dir() {
        return Err(format!("源目录不存在或不是目录：{src_dir}"));
    }
    let md = src.join("SKILL.md");
    if !md.exists() {
        return Err(format!(
            "该目录不含 SKILL.md，不是合法技能目录：{}",
            src.display()
        ));
    }

    let Some(pack_root) = shipped_skill_pack_root(&app, &pack_id) else {
        return Err(format!("技能库不存在：{pack_id}"));
    };

    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无法取源目录名".to_string())?;
    let target = pack_root.join(&name);

    // 已存在 → 先备份，不静默覆盖
    let mut backup: Option<String> = None;
    if target.exists() {
        let bak = pack_root.join(format!("{name}.bak-{}", stamp()));
        let _ = std::fs::remove_dir_all(&bak);
        std::fs::rename(&target, &bak).map_err(|e| format!("备份已存在技能失败: {e}"))?;
        backup = Some(bak.display().to_string());
    }

    copy_dir(&src, &target)?;

    // 校验落盘结果
    let text = std::fs::read_to_string(target.join("SKILL.md")).unwrap_or_default();
    let (title, description, valid) = parse_skill_frontmatter(&text);

    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "target": target.display().to_string(),
        "backup": backup,
        "title": title,
        "description": description,
        "valid": valid,
        "files": count_files(&target),
    }))
}

/// 自定义版本（用户新建：自选提示词文件 + 自选技能文件夹 → 自定义注入位置）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomVersion {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub desc: String,
    /// 提示词文件绝对路径（可为空 = 不注入提示词）
    #[serde(default)]
    pub prompt_path: Option<String>,
    /// 要注入的技能目录列表（源绝对路径）
    #[serde(default)]
    pub skill_dirs: Vec<String>,
    /// 自定义注入目标（目标路径 → 写入模式）
    #[serde(default)]
    pub targets: Vec<CustomTarget>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomTarget {
    /// 目标文件夹或文件路径（用户指定，例如某个软件的配置目录）
    pub path: String,
    /// file = 写单个文件（提示词）；dir = 目录（把技能目录复制进去）
    pub kind: String,
    /// file 模式下的文件名（拼到 path 后）
    #[serde(default)]
    pub file_name: Option<String>,
    /// dir 模式下要复制的源目录绝对路径（可多个来源对应多个目标）
    #[serde(default)]
    pub source_dir: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CustomStore {
    pub versions: Vec<CustomVersion>,
}

fn custom_store_path(app: &AppHandle) -> PathBuf {
    runtime_root(app).join(".codex/custom-versions.json")
}

fn load_custom(app: &AppHandle) -> CustomStore {
    std::fs::read_to_string(custom_store_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_custom(app: &AppHandle, st: &CustomStore) -> Result<(), String> {
    let p = custom_store_path(app);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let js = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, js).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// 列出用户自定义版本
#[tauri::command]
pub fn custom_versions_list(app: AppHandle) -> Vec<CustomVersion> {
    load_custom(&app).versions
}

/// 新建/更新自定义版本
#[tauri::command]
pub fn custom_version_save(app: AppHandle, version: CustomVersion) -> Result<CustomVersion, String> {
    let mut st = load_custom(&app);
    match st.versions.iter().position(|v| v.id == version.id) {
        Some(i) => st.versions[i] = version.clone(),
        None => st.versions.push(version.clone()),
    }
    save_custom(&app, &st)?;
    Ok(version)
}

/// 删除自定义版本
#[tauri::command]
pub fn custom_version_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut st = load_custom(&app);
    st.versions.retain(|v| v.id != id);
    save_custom(&app, &st)
}

/// 按自定义版本执行注入（用户指定 文件夹 → 文件夹）
#[tauri::command]
pub fn custom_version_install(app: AppHandle, version: CustomVersion) -> InstallReport {
    let mut steps = Vec::new();
    let mut installed: Vec<String> = Vec::new();

    // 1) 提示词
    if let Some(pp) = &version.prompt_path {
        let src = PathBuf::from(pp);
        if !src.exists() {
            return report_err(steps, format!("提示词文件不存在：{pp}"));
        }
        let raw = std::fs::read_to_string(&src).unwrap_or_default();
        steps.push(format!("提示词源 {}（{} 字节）", src.display(), raw.len()));

        // 渲染模板（用自定义版本的 label 作为 channel）
        let body = expand_template(&strip_metadata(&raw), &version.id, &version.label, "", "");

        for t in version.targets.iter().filter(|t| t.kind == "file") {
            let mut target = PathBuf::from(&t.path);
            if let Some(fname) = &t.file_name {
                if !fname.is_empty() {
                    target = target.join(fname);
                }
            }
            let existing = read_text(&target);
            let bk = backup_fixed(&target, ".bak-inject").ok().flatten();
            if let Some(b) = &bk {
                steps.push(format!("原件备份 → {}", b.display()));
            }
            let out = format!(
                "{}\n{}\n",
                managed_header(&version.id),
                body.trim_end()
            );
            let _ = existing;
            if let Err(e) = write_utf8_no_bom(&target, &out) {
                return report_err(steps, e);
            }
            steps.push(format!("写入 {}", target.display()));
        }
    }

    // 2) 技能目录复制（源文件夹 → 目标文件夹）
    for t in version.targets.iter().filter(|t| t.kind == "dir") {
        let Some(srcd) = t.source_dir.as_ref().filter(|s| !s.is_empty()) else {
            steps.push(format!("目标 {} 未指定源目录，跳过", t.path));
            continue;
        };
        let src = PathBuf::from(srcd);
        if !src.is_dir() {
            steps.push(format!("源目录不存在：{srcd}"));
            continue;
        }
        let dest_root = PathBuf::from(&t.path);

        // 若源本身是一个技能（含 SKILL.md）→ 整体复制为一个技能
        if src.join("SKILL.md").exists() {
            let name = src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let dest = dest_root.join(&name);
            let _ = std::fs::remove_dir_all(&dest);
            match copy_dir(&src, &dest) {
                Ok(_) => {
                    steps.push(format!("技能 {name} → {}", dest.display()));
                    installed.push(name);
                }
                Err(e) => steps.push(format!("复制失败：{e}")),
            }
        } else {
            // 否则按技能库扫描（只收含 SKILL.md 的一级子目录）
            match sync_skills(&src, &dest_root, None, "", None) {
                Ok((names, skipped, _)) => {
                    steps.push(format!(
                        "技能库 {} → {}（{} 个，跳过 {}）",
                        src.display(),
                        dest_root.display(),
                        names.len(),
                        skipped
                    ));
                    installed.extend(names);
                }
                Err(e) => steps.push(format!("同步失败：{e}")),
            }
        }
    }

    steps.push("自定义注入完成".into());
    InstallReport {
        ok: true,
        steps,
        skills_installed: installed,
        skills_skipped: 0,
        error: None,
    }
}

/// 浏览目录（自定义版本选择文件夹用）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn browse_dir(path: Option<String>) -> Result<Vec<BrowseEntry>, String> {
    // 空路径 → 列盘符
    let Some(p) = path.filter(|s| !s.trim().is_empty()) else {
        let mut out = Vec::new();
        for letter in b'C'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if PathBuf::from(&root).exists() {
                out.push(BrowseEntry {
                    name: root.clone(),
                    path: root,
                    is_dir: true,
                });
            }
        }
        return Ok(out);
    };
    let dir = expand_path_light(&p);
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut out = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let path = e.path();
        let is_dir = path.is_dir();
        let name = e.file_name().to_string_lossy().to_string();
        // 跳过隐藏与系统目录，减少干扰
        if name.starts_with('.') || name == "System Volume Information" || name == "$RECYCLE.BIN" {
            continue;
        }
        out.push(BrowseEntry {
            name,
            path: path.display().to_string(),
            is_dir,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// 不带 AppHandle 的路径展开：只处理 `~` 与 `{{HOME}}`。
/// 给 browse_dir 这种没有 AppHandle 的命令用。
fn expand_path_light(raw: &str) -> PathBuf {
    let home = home_dir();
    let s = raw.replace("{{HOME}}", &home);
    let s = if let Some(rest) = s.strip_prefix('~') {
        format!("{home}{rest}")
    } else {
        s
    };
    PathBuf::from(s.replace('/', "\\"))
}

// ============================================================
// 测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Claude 风格的标记（带载荷）
    const BK: &str = "HANSHUANG-INJECT:BEGIN";
    const EK: &str = "HANSHUANG-INJECT:END";
    const BM: &str = "<!-- HANSHUANG-INJECT:BEGIN prompt=x.md -->";
    const EM: &str = "<!-- HANSHUANG-INJECT:END -->";

    #[test]
    fn block_is_idempotent_and_keeps_user_content() {
        let base = "# 我自己写的规则\n\n保留我。\n";
        let (once, updated1) = apply_block(base, BK, EK, BM, EM, "注入正文 A");
        assert!(!updated1, "首次应为追加");
        assert!(once.contains("# 我自己写的规则"));
        assert!(once.contains("注入正文 A"));

        let (twice, updated2) = apply_block(&once, BK, EK, BM, EM, "注入正文 B");
        assert!(updated2, "第二次应为更新");
        assert!(twice.contains("注入正文 B"));
        assert!(!twice.contains("注入正文 A"), "旧块内容应被替换");
        assert!(twice.contains("# 我自己写的规则"), "用户内容必须保留");
        assert_eq!(twice.matches(BK).count(), 1, "块只能有一个");
    }

    #[test]
    fn legacy_bare_marker_is_recognized() {
        // 旧版写的是无载荷的裸标记，必须也能识别并替换（不能叠加）
        let legacy = "用户内容\n<!-- HANSHUANG-INJECT:BEGIN -->\n老版正文\n<!-- HANSHUANG-INJECT:END -->\n";
        let (out, updated) = apply_block(legacy, BK, EK, BM, EM, "新版正文");
        assert!(updated, "应识别到旧版裸标记并更新");
        assert!(out.contains("新版正文"));
        assert!(!out.contains("老版正文"), "旧正文应被替换掉");
        assert!(out.contains("用户内容"));
        assert_eq!(out.matches("HANSHUANG-INJECT:BEGIN").count(), 1, "不能叠加成两块");
    }

    #[test]
    fn dsh_pack_payload_marker_is_recognized() {
        // DSH 懒人包的 marker 带 pack= 载荷；旧版卸载正是栽在这里认不出
        let existing = "<!-- HANSHUANG-INJECT:BEGIN pack=dsh-lazy-pack-v5 -->\n懒人包正文\n<!-- HANSHUANG-INJECT:END -->\n";
        let (out, updated) = apply_block(existing, BK, EK, BM, EM, "新正文");
        assert!(updated, "带 pack= 载荷的块也必须能认出");
        assert_eq!(out.matches("HANSHUANG-INJECT:BEGIN").count(), 1);
        let stripped = strip_block(&out, BK, EK);
        assert!(!stripped.contains("懒人包正文"));
        assert!(stripped.trim().is_empty());
    }

    #[test]
    fn strip_block_keeps_user_only() {
        let base = "# 保留\n";
        let (inj, _) = apply_block(base, BK, EK, BM, EM, "注入");
        let cleaned = strip_block(&inj, BK, EK);
        assert_eq!(cleaned.trim(), "# 保留");
    }

    #[test]
    fn uninstall_cycle_is_lossless() {
        let original = "# 用户手写\n内容\n";
        let (v4, _) = apply_block(original, BK, EK, BM, EM, "V4 正文");
        let (v5, _) = apply_block(&v4, BK, EK, BM, EM, "V5 正文");
        let un = strip_block(&v5, BK, EK);
        assert_eq!(un.trim(), original.trim(), "装 V4→V5→卸载 后原文必须完好");
    }

    #[test]
    fn codex_style_chinese_marker_works() {
        // Codex 用的是中文标记「寒霜破甲注入开始 · <文件名>」
        let bk = "寒霜破甲注入开始";
        let ek = "寒霜破甲注入结束";
        let bm = "<!-- 寒霜破甲注入开始 · 寒霜v4.md -->";
        let em = "<!-- 寒霜破甲注入结束 -->";
        let base = "# 用户配置\n";
        let (once, _) = apply_block(base, bk, ek, bm, em, "V4 正文");
        assert!(once.contains("寒霜破甲注入开始"));
        let (twice, upd) = apply_block(&once, bk, ek, bm, em, "V5 正文");
        assert!(upd);
        assert_eq!(twice.matches("寒霜破甲注入开始").count(), 1);
        assert!(twice.contains("# 用户配置"));
    }

    #[test]
    fn metadata_lines_are_stripped_persona_kept() {
        let t = "<!-- L-SKILL-VERSION: 5 -->\n<!-- CONTRACT -->\n正文\n<!-- MANAGED-PERSONA:START -->\n人格\n<!-- MANAGED-PERSONA:END -->";
        let out = strip_metadata(t);
        assert!(!out.contains("L-SKILL-VERSION"));
        assert!(!out.contains("<!-- CONTRACT"));
        assert!(out.contains("正文"));
        assert!(out.contains("MANAGED-PERSONA"), "人格块必须保留");
    }

    /// 用户要求：注入文件的头必须是「managed by alicewe」，
    /// 不能再带寒霜 / 破甲 / 版本号 —— 各客户端可能原样展示出来。
    #[test]
    fn injected_signature_is_alicewe_without_version() {
        let head = managed_header("codex");
        assert!(head.contains("<!-- managed by alicewe -->"), "应含 alicewe 署名: {head}");
        for banned in ["寒霜", "破甲", "pojia", "v5", "v4", "HANSHUANG"] {
            assert!(
                !head.to_lowercase().contains(&banned.to_lowercase()),
                "署名头不应包含 {banned}，实际: {head}"
            );
        }
        // 且以换行结尾，正文从下一行开始
        assert!(head.ends_with('\n'));
    }

    #[test]
    fn template_expansion_slashes_forward() {
        let out = expand_template(
            "{{CHANNEL}}/{{CHANNEL_LABEL}} {{SKILLS_ROOT}} {{MODULES_ROOT}}",
            "cursor",
            "Cursor",
            r"C:\u\.l-skill\skills",
            r"C:\u\.l-skill\modules",
        );
        assert!(out.contains("cursor/Cursor"));
        assert!(out.contains("C:/u/.l-skill/skills"), "反斜杠应转正斜杠: {out}");
        assert!(has_unrendered(&out).is_none());
    }

    #[test]
    fn unrendered_variable_is_detected() {
        let bad = "正文 {{SOME_VAR}} 未完";
        assert_eq!(has_unrendered(bad).as_deref(), Some("{{SOME_VAR}}"));
    }

    #[test]
    fn injection_artifact_detection() {
        assert!(is_injection_artifact("这里提到 拒绝话术全清单 的内容"));
        assert!(is_injection_artifact("<!-- HANSHUANG-INJECT:BEGIN -->"));
        assert!(is_injection_artifact("CTF Lab 2.0 规范"));
        assert!(!is_injection_artifact("# 我自己的项目规则\n用 TypeScript"));
    }

    #[test]
    fn stamp_matches_legacy_format() {
        let s = stamp();
        assert_eq!(s.len(), 15);
        assert!(Regex::new(r"^\d{8}-\d{6}$").unwrap().is_match(&s), "格式: {s}");
    }

    #[test]
    fn cursor_frontmatter_structure() {
        // Cursor 的 .mdc 必须是 frontmatter + marker + body
        let fm = "---\ndescription: 寒霜工作规范（自动注入 · 全局生效）\nglobs: \"**/*\"\nalwaysApply: true\n---";
        let content = format!("{fm}\n<!-- HANSHUANG-CURSOR-INJECT -->\n正文");
        assert!(content.starts_with("---"));
        assert!(content.contains("alwaysApply: true"));
        assert!(content.contains("HANSHUANG-CURSOR-INJECT"));
    }

    #[test]
    fn every_client_marker_pair_is_self_consistent() {
        // 每个客户端的 begin/end 关键串必须不同且非空，否则块定位会错乱
        for (name, bk, ek) in [
            ("codex", "寒霜破甲注入开始", "寒霜破甲注入结束"),
            ("claude", "HANSHUANG-INJECT:BEGIN", "HANSHUANG-INJECT:END"),
            ("dsh", "HANSHUANG-INJECT:BEGIN", "HANSHUANG-INJECT:END"),
        ] {
            assert!(!bk.is_empty() && !ek.is_empty(), "{name} 标记不能为空");
            assert_ne!(bk, ek, "{name} 起止标记不能相同");
            // 结束标记不能是开始标记的子串（否则先匹配到错误位置）
            assert!(!bk.contains(ek) && !ek.contains(bk), "{name} 起止标记不能互相包含");
        }
    }

    /// 真实文件结构：孤立的前置结束标记 + 单个完整块，必须正确定位
    ///
    /// 现场依据：C:\Users\alicewe\.codex\AGENTS.md 里
    /// `寒霜破甲注入结束` 出现 2 次（1 次孤立在前），`开始` 出现 1 次。
    /// 若实现写成「先找 begin 再找它之后的 end」会踩到孤立标记，
    /// 或写成「全局第一个 end」会把块边界截错。
    #[test]
    fn handles_orphan_end_marker_in_real_layout() {
        const BK: &str = "寒霜破甲注入开始";
        const EK: &str = "寒霜破甲注入结束";

        let real_like = concat!(
            "<!--  · 助手专业版v1.md -->\n",
            "<!-- L-SKILL HANDSHAKE:START -->\n",
            "用户自有内容第一部分\n",
            "<!-- 寒霜破甲注入结束 -->\n", // 孤立的结束标记（旧版遗留）
            "\n",
            "<!-- 寒霜破甲注入开始 · 破甲助手专业版v1.md -->\n",
            "旧注入正文\n",
            "<!-- 寒霜破甲注入结束 -->\n"
        );

        // 定位应命中第二个开始标记到其后的结束标记
        let (s, e) = find_block(real_like, BK, EK).expect("应能定位到块");
        let block = &real_like[s..e];
        assert!(block.starts_with("<!-- 寒霜破甲注入开始"), "块起点错误: {block}");
        assert!(block.ends_with("<!-- 寒霜破甲注入结束 -->"), "块终点错误");
        assert!(block.contains("旧注入正文"));
        assert!(!block.contains("用户自有内容第一部分"), "不能把用户内容圈进块");

        // 替换后：用户内容保留、孤立标记保留、块只有一份新内容
        let bm = "<!-- 寒霜破甲注入开始 · 新版本.md -->";
        let em = "<!-- 寒霜破甲注入结束 -->";
        let (out, updated) = apply_block(real_like, BK, EK, bm, em, "新注入正文");
        assert!(updated);
        assert!(out.contains("用户自有内容第一部分"), "用户内容必须保留");
        assert!(out.contains("新注入正文"));
        assert!(!out.contains("旧注入正文"), "旧块内容应被替换");
        assert_eq!(out.matches(BK).count(), 1, "开始标记仍应只有 1 个");

        // 摘块后：用户内容与孤立标记保留，注入正文消失
        let cleaned = strip_block(&out, BK, EK);
        assert!(cleaned.contains("用户自有内容第一部分"));
        assert!(!cleaned.contains("新注入正文"));
        assert!(!cleaned.contains(BK));
    }

    /// 真实文件的读写往返（对本机 ~/.codex/AGENTS.md 的副本操作）
    /// 若文件不存在则跳过（CI/换机场景）
    #[test]
    fn roundtrip_on_real_agents_md_copy() {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        if home.is_empty() {
            return;
        }
        let real = PathBuf::from(&home).join(".codex/AGENTS.md");
        if !real.exists() {
            return; // 环境没有该文件，跳过
        }
        let original = std::fs::read_to_string(&real).unwrap_or_default();
        if original.is_empty() {
            return;
        }

        const BK: &str = "寒霜破甲注入开始";
        const EK: &str = "寒霜破甲注入结束";
        let bm = "<!-- 寒霜破甲注入开始 · 测试.md -->";
        let em = "<!-- 寒霜破甲注入结束 -->";

        // 模拟：注入 → 再注入一次 → 卸载
        let (step1, _) = apply_block(&original, BK, EK, bm, em, "第一次注入正文");
        let (step2, updated) = apply_block(&step1, BK, EK, bm, em, "第二次注入正文");
        assert!(updated, "对真实文件结构，第二次必须是更新而非追加");
        assert_eq!(step2.matches(BK).count(), 1, "真实文件上也不能叠加成两块");
        assert!(step2.contains("第二次注入正文"));
        assert!(!step2.contains("第一次注入正文"));

        let cleaned = strip_block(&step2, BK, EK);
        assert!(!cleaned.contains(BK), "卸载后不应残留开始标记");
        assert!(!cleaned.contains("第二次注入正文"));

        // 卸载语义校验：
        // 真实文件的块内是整份提示词正文（16KB），摘掉块后文件必然显著变小，
        // 这是**正确行为**（注入内容是工具写的，理应被移除）。
        // 关键不变量是：块外内容必须一字不少。
        let orig_outside = strip_block(&original, BK, EK);
        let cleaned_outside = cleaned.trim();
        let orig_outside = orig_outside.trim();
        let delta = (cleaned_outside.len() as i64 - orig_outside.len() as i64).abs();
        assert!(
            delta < 64,
            "卸载后块外内容必须与原文件的块外内容一致（原块外 {} vs 卸载后 {}，差 {}）",
            orig_outside.len(),
            cleaned_outside.len(),
            delta
        );
    }
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    use std::path::PathBuf;

    /// 真实磁盘校验：新结构 _assets/skill/<包名>/skills/<技能>
    #[test]
    fn scan_real_assets_dir() {
        let base = PathBuf::from("F:/重构ui/新alice助手/resources/_assets/skill");
        if !base.exists() {
            return; // 环境没有则跳过
        }
        let rd = std::fs::read_dir(&base).unwrap();
        let mut found = Vec::new();
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            // 新结构：包目录下的 skills/
            let n = scan_skill_dir(&p.join("skills")).len();
            if n > 0 {
                found.push(format!("{}={}", e.file_name().to_string_lossy(), n));
            }
        }
        println!("扫描结果: {}", found.join(", "));
        assert!(!found.is_empty(), "应在 _assets/skill/*/skills 下发现技能包");
    }

    /// 旧结构兼容：_assets/<包名>/<技能>/（无 skills 中间层）
    #[test]
    fn scan_legacy_layout_still_works() {
        let base = PathBuf::from("F:/重构ui/新alice助手/resources/_assets");
        if !base.exists() {
            return;
        }
        // 造一个旧结构目录验证兼容分支
        let legacy = base.join("_legacy_probe");
        let sk = legacy.join("probe-skill");
        let _ = std::fs::create_dir_all(&sk);
        let _ = std::fs::write(
            sk.join("SKILL.md"),
            "---\nname: probe\ndescription: 测试用\n---\n正文\n",
        );
        let n = scan_skill_dir(&legacy).len();
        let _ = std::fs::remove_dir_all(&legacy);
        assert_eq!(n, 1, "旧结构（技能直接铺在包目录下）应能扫到");
    }
}
