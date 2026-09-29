// ============================================================
//  其他文件：第三方注入素材的文件管理器（others 根）
//
//  ══ 这个模块解决什么 ══════════════════════════════════════
//  预设组的「第三方文件」条目需要用户自备素材（云记忆、规则、
//  任意要跟着注入过去的文件/文件夹）。早先这些素材只能靠用户
//  自己开资源管理器丢进 `_assets/other/`，界面上看不见、也没有
//  任何归类手段 —— 素材一多就分不清哪个是给哪个客户端的。
//
//  这里提供一个**带备注分类的文件管理器**：
//    · 根目录固定 `_assets/others`（用户指定用 others 这个名）
//    · 每个条目可以写备注（存在同目录的 `.alice-notes.json`）
//    · 支持新建文件夹 / 导入文件 / 导入文件夹 / 重命名 / 删除
//
//  ══ 为什么备注要单独存一个 json，不塞进文件名 ══════════════
//  注入时复制的是**原始文件名**，改文件名会连带改变落点内容
//  （脚本里写死引用的路径全失效）。所以备注必须外挂：
//  以「相对路径 → 备注」的形式记在 `.alice-notes.json` 里，
//  文件本身一个字节不动。
// ============================================================

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::runtime::runtime_root; // 与注入共用同一个包根解析（在 runtime.rs）

/// 其他文件的根目录名（用户指定：others）
pub const OTHERS_DIR: &str = "others";

/// 备注文件名。加前导点让它排在最前、且不参与注入。
const NOTES_FILE: &str = ".alice-notes.json";

/// 一个条目（文件或文件夹）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OtherEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// 字节数（目录为 0）
    pub size: u64,
    /// 修改时间（Unix 毫秒，取不到为 0）
    pub modified: u64,
    /// 用户写的备注（空串 = 没写）
    pub note: String,
    /// 相对 others 根的路径，作为备注的 key
    pub rel: String,
}

/// 备注表：rel 路径 → 备注文本
#[derive(Serialize, Deserialize, Default)]
struct Notes {
    #[serde(default)]
    items: std::collections::BTreeMap<String, String>,
}

/// others 根目录（不存在则创建）
fn others_root(app: &AppHandle) -> PathBuf {
    let root = runtime_root(app).join("_assets").join(OTHERS_DIR);
    let _ = std::fs::create_dir_all(&root);
    root
}

fn notes_path(app: &AppHandle) -> PathBuf {
    others_root(app).join(NOTES_FILE)
}

fn load_notes(app: &AppHandle) -> Notes {
    std::fs::read_to_string(notes_path(app))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_notes(app: &AppHandle, n: &Notes) -> Result<(), String> {
    let p = notes_path(app);
    let js = serde_json::to_string_pretty(n).map_err(|e| e.to_string())?;
    // 原子写：先写临时文件再改名，避免中途失败留下半个 json
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, js).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// 把绝对路径转成相对 others 根的 rel（正斜杠统一，便于跨平台）
fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 列目录。`dir` 为空 = 列 others 根。
///
/// 只列**当前一层**（不像资源管理器那样递归）—— 素材通常按用途分一层
/// 文件夹，平铺更好认；需要深入就双击进去。备注文件自己不出现在列表里。
#[tauri::command]
pub fn others_list(app: AppHandle, dir: Option<String>) -> Result<Vec<OtherEntry>, String> {
    let root = others_root(&app);
    let cur = match dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => root.clone(),
    };
    // 不允许跳出 others 根：越界的路径直接拒绝，避免误操作删到包外的东西
    if !cur.starts_with(&root) {
        return Err("只能浏览 others 目录内部".into());
    }
    let notes = load_notes(&app);

    let rd = std::fs::read_dir(&cur).map_err(|e| format!("{}: {e}", cur.display()))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // 备注文件是元数据，不当素材显示
        if name == NOTES_FILE || name.ends_with(".json.tmp") {
            continue;
        }
        let path = e.path();
        let is_dir = path.is_dir();
        let size = if is_dir {
            0
        } else {
            e.metadata().map(|m| m.len()).unwrap_or(0)
        };
        let rel = rel_of(&root, &path);
        out.push(OtherEntry {
            name,
            path: path.display().to_string(),
            is_dir,
            size,
            modified: mtime_ms(&path),
            note: notes.items.get(&rel).cloned().unwrap_or_default(),
            rel,
        });
    }
    // 目录在前，同类按名字排（与资源管理器一致）
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 写某条目的备注（空串 = 删除该备注）
#[tauri::command]
pub fn others_set_note(app: AppHandle, rel: String, note: String) -> Result<(), String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("缺少条目路径".into());
    }
    let mut n = load_notes(&app);
    let note = note.trim().to_string();
    if note.is_empty() {
        n.items.remove(&rel);
    } else {
        n.items.insert(rel, note);
    }
    save_notes(&app, &n)
}

/// 新建文件夹。`parent` 为空 = others 根。
#[tauri::command]
pub fn others_mkdir(app: AppHandle, parent: Option<String>, name: String) -> Result<String, String> {
    let root = others_root(&app);
    let base = match parent.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => root.clone(),
    };
    if !base.starts_with(&root) {
        return Err("只能建在 others 目录内部".into());
    }
    let name = sanitize_name(&name)?;
    let dst = base.join(&name);
    if dst.exists() {
        return Err(format!("「{name}」已存在"));
    }
    std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    Ok(dst.display().to_string())
}

/// 重命名。备注跟着改 key（否则备注会"留在旧名字上"消失）。
#[tauri::command]
pub fn others_rename(app: AppHandle, path: String, new_name: String) -> Result<String, String> {
    let root = others_root(&app);
    let src = PathBuf::from(&path);
    if !src.starts_with(&root) {
        return Err("只能重命名 others 目录内部的条目".into());
    }
    let new_name = sanitize_name(&new_name)?;
    let parent = src.parent().ok_or("拿不到父目录")?;
    let dst = parent.join(&new_name);
    if dst.exists() {
        return Err(format!("「{new_name}」已存在"));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;

    // 备注迁移：旧 rel → 新 rel（含子项，目录改名时子条目的备注也要跟）
    let mut n = load_notes(&app);
    let old_rel = rel_of(&root, &src);
    let new_rel = rel_of(&root, &dst);
    if !old_rel.is_empty() && !new_rel.is_empty() {
        let moved: Vec<(String, String, String)> = n
            .items
            .iter()
            .filter(|(k, _)| *k == &old_rel || k.starts_with(&format!("{old_rel}/")))
            .map(|(k, v)| {
                (
                    k.clone(),
                    k.replacen(&old_rel, &new_rel, 1),
                    v.clone(),
                )
            })
            .collect();
        for (old_k, new_k, v) in moved {
            n.items.remove(&old_k);
            n.items.insert(new_k, v);
        }
        let _ = save_notes(&app, &n);
    }
    Ok(dst.display().to_string())
}

/// 删除（文件或目录）。目录连同其下所有条目的备注一起清掉。
#[tauri::command]
pub fn others_delete(app: AppHandle, path: String) -> Result<(), String> {
    let root = others_root(&app);
    let p = PathBuf::from(&path);
    if !p.starts_with(&root) {
        return Err("只能删除 others 目录内部的条目".into());
    }
    if p == root {
        return Err("不能删除 others 根目录".into());
    }
    if !p.exists() {
        return Err("路径不存在".into());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }

    let mut n = load_notes(&app);
    let rel = rel_of(&root, &p);
    let before = n.items.len();
    if !rel.is_empty() {
        n.items
            .retain(|k, _| k != &rel && !k.starts_with(&format!("{rel}/")));
    }
    if n.items.len() != before {
        let _ = save_notes(&app, &n);
    }
    Ok(())
}

/// 把外部文件/文件夹**复制**进 others。目录递归复制，同名自动加序号不覆盖。
///
/// 返回实际落地的路径列表。复制而不是移动：用户的原始素材留在原处更安全。
#[tauri::command]
pub fn others_import(
    app: AppHandle,
    parent: Option<String>,
    sources: Vec<String>,
) -> Result<Vec<String>, String> {
    let root = others_root(&app);
    let base = match parent.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => root.clone(),
    };
    if !base.starts_with(&root) {
        return Err("只能导入到 others 目录内部".into());
    }
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    let mut done = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    for s in sources {
        let src = PathBuf::from(&s);
        if !src.exists() {
            failed.push(format!("{}: 不存在", src.display()));
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名".into());
        let dst = unique_path(&base, &name);
        let r = if src.is_dir() {
            copy_dir_rec(&src, &dst)
        } else {
            std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
        };
        match r {
            Ok(_) => done.push(dst.display().to_string()),
            Err(e) => failed.push(format!("{name}: {e}")),
        }
    }

    if !failed.is_empty() && done.is_empty() {
        return Err(format!("导入失败：{}", failed.join("; ")));
    }
    if !failed.is_empty() {
        return Err(format!(
            "部分导入失败（成功 {} 项）：{}",
            done.len(),
            failed.join("; ")
        ));
    }
    Ok(done)
}

/// 过滤文件名里的非法字符（Windows 下这些字符会让创建直接失败）
fn sanitize_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名字不能为空".into());
    }
    if n.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("名字含非法字符：\\ / : * ? \" < > |".into());
    }
    if n == NOTES_FILE {
        return Err("该名字为内部保留名".into());
    }
    Ok(n.to_string())
}

/// 同名时生成 `名字 (2)`、`名字 (3)` …（与资源管理器的「复制」习惯一致）
fn unique_path(base: &Path, name: &str) -> PathBuf {
    let cand = base.join(name);
    if !cand.exists() {
        return cand;
    }
    // 拆出主名与扩展名：`a.txt` → ("a", ".txt")
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..1000 {
        let cand = base.join(format!("{stem} ({i}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    base.join(format!("{stem} (copy){ext}"))
}

fn copy_dir_rec(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let rd = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_dir_rec(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// others 根目录绝对路径（前端「打开目录」用）
#[tauri::command]
pub fn others_root_path(app: AppHandle) -> String {
    others_root(&app).display().to_string()
}

/// 树节点：一个文件夹 + 它的子文件夹（递归）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OtherNode {
    pub name: String,
    pub path: String,
    /// 相对 others 根的路径（备注 key）
    pub rel: String,
    /// 备注
    pub note: String,
    /// 直接子文件夹
    pub children: Vec<OtherNode>,
    /// 该文件夹**直接**包含的文件数（不含子文件夹里的）——
    /// 左栏显示「(3)」让用户知道点进去有没有东西
    pub files: usize,
}

fn build_node(dir: &Path, root: &Path, notes: &Notes, depth: usize) -> Vec<OtherNode> {
    // 深度上限防病态嵌套（正常素材 1~3 层）。超了就只列一层不再往下。
    if depth > 8 {
        return Vec::new();
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == NOTES_FILE || name.ends_with(".json.tmp") {
            continue;
        }
        let rel = rel_of(root, &path);
        // 数直接子文件数
        let files = std::fs::read_dir(&path)
            .map(|r| {
                r.flatten()
                    .filter(|x| x.path().is_file())
                    .count()
            })
            .unwrap_or(0);
        out.push(OtherNode {
            name,
            path: path.display().to_string(),
            note: notes.items.get(&rel).cloned().unwrap_or_default(),
            children: build_node(&path, root, notes, depth + 1),
            rel,
            files,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 完整文件夹树（左栏用）。只含文件夹，不含文件。
///
/// ══ 为什么一次给全树，而不是逐层展开 ═══════════════════════════════════
/// 左栏是导航，用户需要一眼看到**整棵目录结构**才好判断素材怎么归类的。
/// 逐层懒加载在展开时才请求，滚动和切换分类都会有明显延迟感；
/// others 是用户自备素材目录，规模通常几十~几百项，一次取完毫无压力。
#[tauri::command]
pub fn others_tree(app: AppHandle) -> Result<Vec<OtherNode>, String> {
    let root = others_root(&app);
    let notes = load_notes(&app);
    Ok(build_node(&root, &root, &notes, 0))
}
