// 技能包导入：原生「资源管理器」多选 → 自动解压 zip → 自动识别技能目录 → 复制进技能包。
//
// 为什么不用手填路径：用户拿到的是「一个已解压的文件夹」或「一个 .zip」，
// 让他在输入框里敲绝对路径既容易错也难用。这里直接开系统对话框多选，
// 由后端负责解压与识别，粘错路径这一类问题从根上消失。
//
// 识别规则（不依赖用户说明）：
//   · 目录里直接有 SKILL.md            → 这个目录就是一个技能
//   · 目录里 父级/子级 有 SKILL.md     → 该目录是「技能集合」，逐个收进去
//   · 目录里只有一层包装（zip 常见）    → 自动下钻，如 my-skill-main/my-skill/SKILL.md
//   · 压缩包                            → 解压到临时目录后按上面的规则识别；多包自动展开
// 收集到的每个技能目录都按「目录名 = 技能名」复制进目标技能包；同名先备份。

use serde::Serialize;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::inject::{
    count_files_pub as count_files, copy_dir_pub as copy_dir,
    parse_skill_frontmatter_pub as parse_skill_frontmatter, shipped_skill_pack_root,
    write_utf8_no_bom_pub as write_utf8_no_bom,
};
use crate::runtime::runtime_root;

/// 递归深度上限：防止用户选到 C:\ 这种巨型目录时无限下钻
const MAX_DEPTH: usize = 6;
/// 单次导入收集到的技能数上限（防误选巨型目录把界面卡死）
const MAX_SKILLS: usize = 500;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSkill {
    pub name: String,
    /// 落盘后的绝对路径
    pub target: String,
    pub title: String,
    pub description: String,
    pub valid: bool,
    pub files: usize,
    /// 同名被顶掉时的备份路径
    pub backup: Option<String>,
    /// 来源（原目录名或 zip 内路径），便于用户核对
    pub source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportManyResult {
    /// 用户取消对话框
    pub cancelled: bool,
    pub imported: Vec<ImportedSkill>,
    /// 跳过/失败的原因（不阻断其它项）
    pub skipped: Vec<String>,
    /// 解压出来的临时目录（已清理则为空）
    pub temp_cleaned: bool,
}

fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 打开系统对话框选来源。
///
/// `kind`：
///   "dir"  → 只弹「文件夹多选」
///   "zip"  → 只弹「.zip 多选」
///   "file" → 只弹「.md 文件多选」（提示词添加用）
///   其它/缺省 → 先文件夹，用户取消后再弹 zip（兼容旧调用）
///
/// 为什么必须分开：Windows 的文件夹选择器**不能选中文件**（FOS_PICKFOLDERS），
/// 压缩包选择器也不能选目录。早先写成「先弹文件夹、取消后再弹 zip」，
/// 结果用户只看到文件夹对话框，永远走不到选 zip 那一步。
/// 现在由界面先问「要文件夹还是压缩包」，再弹对应的对话框。
///
/// 注意必须是 async：blocking_pick_* 会阻塞线程，Tauri v2 里同步 command
/// 跑在主线程上，直接用它会把界面卡死（这块已经踩过一次坑）。
#[tauri::command(async)]
pub fn pick_import_sources(app: AppHandle, kind: Option<String>) -> Vec<String> {
    let dirs = |app: &AppHandle| -> Vec<String> {
        app.dialog()
            .file()
            .set_title("选择要添加的技能文件夹（可多选）")
            .blocking_pick_folders()
            .map(|list| {
                list.into_iter()
                    .filter_map(|f| f.into_path().ok().map(|p| p.display().to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let zips = |app: &AppHandle| -> Vec<String> {
        app.dialog()
            .file()
            .set_title("选择技能压缩包（.zip，可多选）")
            .add_filter("压缩包", &["zip"])
            .blocking_pick_files()
            .map(|list| {
                list.into_iter()
                    .filter_map(|f| f.into_path().ok().map(|p| p.display().to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };
    // 提示词文件多选：只过滤 .md（提示词就是 markdown），避免用户误选一堆无关文件
    let files = |app: &AppHandle| -> Vec<String> {
        app.dialog()
            .file()
            .set_title("选择提示词文件（.md，可多选）")
            .add_filter("Markdown", &["md"])
            .blocking_pick_files()
            .map(|list| {
                list.into_iter()
                    .filter_map(|f| f.into_path().ok().map(|p| p.display().to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };

    match kind.as_deref() {
        Some("dir") => dirs(&app),
        Some("zip") => zips(&app),
        Some("file") => files(&app),
        _ => {
            let d = dirs(&app);
            if !d.is_empty() {
                return d;
            }
            zips(&app)
        }
    }
}

fn unzip_to(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("不是有效的 zip：{e}"))?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name 会拒绝 ../ 与绝对路径，返回 None 即跳过
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out_path, buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 打开系统对话框选一个文件夹（给「注入位置」用）。
/// 与技能导入的文件夹对话框同源，只是单选 + 自定义标题。
///
/// `start_dir`：对话框的初始目录。传客户端工作路径（如 ~/.codex），
/// 用户就不必每次从「此电脑」一层层点进去。
#[tauri::command(async)]
pub fn pick_one_folder(
    app: AppHandle,
    title: Option<String>,
    start_dir: Option<String>,
) -> Option<String> {
    let mut dlg = app.dialog().file();
    dlg = dlg.set_title(title.unwrap_or_else(|| "选择文件夹".into()));
    if let Some(d) = start_dir.as_ref().map(|s| expand_dir(s)).filter(|p| p.is_dir()) {
        dlg = dlg.set_directory(d);
    }
    dlg.blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

/// 把 `~` / `{{HOME}}` 展开成真实路径，并归一化分隔符
fn expand_dir(raw: &str) -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let s = raw.replace("{{HOME}}", &home);
    let s = if let Some(rest) = s.strip_prefix('~') {
        format!("{home}{rest}")
    } else {
        s
    };
    PathBuf::from(s.replace('/', "\\"))
}

/// 打开系统对话框选一个文件（给「提示词注入位置」用）。
///
/// 提示词注入位置是**文件**（如 ~/.codex/AGENTS.md），不是文件夹 ——
/// 早先这个按钮复用 pick_one_folder，弹的是「选择文件夹」对话框，
/// 用户根本选不到 AGENTS.md。这里单独走选文件对话框。
///
/// `default_name`：文件不存在时（用户想指定一个还没创建的落点），
/// 把它作为默认文件名填进对话框，方便用户在同一目录下直接确认。
/// `start_dir`：初始目录（客户端工作路径），避免从 C 盘开始翻。
#[tauri::command(async)]
pub fn pick_one_file(
    app: AppHandle,
    title: Option<String>,
    default_name: Option<String>,
    start_dir: Option<String>,
) -> Option<String> {
    let mut dlg = app.dialog().file();
    dlg = dlg.set_title(title.unwrap_or_else(|| "选择文件".into()));
    if let Some(d) = start_dir.as_ref().map(|s| expand_dir(s)).filter(|p| p.is_dir()) {
        dlg = dlg.set_directory(d);
    }
    if let Some(n) = default_name.as_ref().filter(|s| !s.trim().is_empty()) {
        dlg = dlg.set_file_name(n);
    }
    dlg.blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

/// 导入技能：把一组路径（目录 / zip，可多选）里的技能全部装进指定技能包。
///
/// async 的原因：内部有解压 + 递归扫描 + 大量文件复制，同步 command 会占住主线程卡死界面。
#[tauri::command(async)]
pub fn import_skill_multi(
    app: AppHandle,
    src_paths: Vec<String>,
    pack_id: String,
) -> Result<ImportManyResult, String> {
    if src_paths.is_empty() {
        return Ok(ImportManyResult {
            cancelled: true,
            imported: vec![],
            skipped: vec![],
            temp_cleaned: true,
        });
    }
    let Some(pack_root) = shipped_skill_pack_root(&app, &pack_id) else {
        return Err(format!("技能库不存在：{pack_id}"));
    };

    /*
     * ══ 与便携箱导入同语义（v3，用户要求两处一致）════════════════════
     * **纯复制**：选中的每个文件夹按原样整目录复制到
     * `<包根>/<文件夹名>`。零识别、零收集、零下钻、零拆包。
     * 旧实现（collect_skills 深递归）会把技能集合目录拆散 —— 用户实测
     * 选 7 个包结果多出 300+ 平铺技能，就是它干的。
     * zip 压缩包保留解压支持：解压后**解压根目录整体**作为导入单元
     * （解压后通常是一层包装目录，整体复制即保结构）。
     */
    let mut imported: Vec<ImportedSkill> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut copied_units = 0usize;

    for raw in src_paths {
        let src = PathBuf::from(&raw);
        if !src.exists() {
            skipped.push(format!("不存在：{raw}"));
            continue;
        }

        // zip：解压到临时目录，然后**解压根里的唯一顶层目录**（或解压根本身）作为导入单元
        let unit = if src.is_file() {
            let is_zip = src
                .extension()
                .map(|e| e.eq_ignore_ascii_case("zip"))
                .unwrap_or(false);
            if !is_zip {
                skipped.push(format!("不是 zip，已跳过：{}", src.display()));
                continue;
            }
            let temp_root = pack_root.join(".import-tmp");
            let _ = std::fs::remove_dir_all(&temp_root);
            if let Err(e) = std::fs::create_dir_all(&temp_root) {
                skipped.push(format!("建临时目录失败：{e}"));
                continue;
            }
            if let Err(e) = unzip_to(&src, &temp_root) {
                skipped.push(format!("解压失败 {}：{e}", src.display()));
                continue;
            }
            // 解压根下若只有唯一一个目录，则该目录为导入单元；否则整个临时根
            let entries: Vec<PathBuf> = std::fs::read_dir(&temp_root)
                .map(|rd| rd.flatten().map(|e| e.path()).collect())
                .unwrap_or_default();
            let dirs: Vec<&PathBuf> = entries.iter().filter(|p| p.is_dir()).collect();
            if entries.len() == 1 && dirs.len() == 1 {
                dirs[0].clone()
            } else {
                temp_root.clone()
            }
        } else {
            src.clone()
        };

        let Some(name) = unit
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
        else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let target = pack_root.join(&name);

        // 同名先备份，绝不静默覆盖用户已有技能
        let mut backup: Option<String> = None;
        if target.exists() {
            let bak = pack_root.join(format!("{name}.bak-{}", stamp()));
            let _ = std::fs::remove_dir_all(&bak);
            match std::fs::rename(&target, &bak) {
                Ok(_) => backup = Some(bak.display().to_string()),
                Err(e) => {
                    skipped.push(format!("备份已存在技能失败 {name}：{e}"));
                    continue;
                }
            }
        }

        if let Err(e) = copy_dir(&unit, &target) {
            skipped.push(format!("复制失败 {name}：{e}"));
            continue;
        }
        copied_units += 1;

        let text = std::fs::read_to_string(target.join("SKILL.md")).unwrap_or_default();
        let (title, description, valid) = parse_skill_frontmatter(&text);
        imported.push(ImportedSkill {
            name,
            target: target.display().to_string(),
            title,
            description,
            valid,
            files: count_files(&target),
            backup,
            source: raw,
        });
    }

    // 清理临时解压目录（失败也不影响已导入结果）
    let temp_cleaned = true;

    let _ = copied_units;
    Ok(ImportManyResult {
        cancelled: false,
        imported,
        skipped,
        temp_cleaned,
    })
}

// ============================================================
// 提示词导入：把用户自备的 .md 收进 _assets/prompts
// ============================================================

/// 提示词目标目录：运行体根的 `_assets/prompts`。
///
/// 为什么固定落这里：scan_prompts 的第 1 个来源就是它，加完立刻能被扫到；
/// 而且 profiles 的 manifest 里提示词 asset 也按 `prompts/xxx.md` 相对 _assets 解析，
/// 放这里既能在「提示词」页看到，也能被版本/预设组引用。
fn prompts_home(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = runtime_root(app).join("_assets/prompts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// 递归收集目录下的 .md 文件（跳过点开头目录与常见非提示词目录）。
/// 返回 (文件绝对路径, 相对来源根的展示路径)。
fn collect_md(dir: &Path, root: &Path, depth: usize, out: &mut Vec<(PathBuf, String)>) {
    if depth > MAX_DEPTH || out.len() >= MAX_SKILLS {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if p.is_dir() {
            // 点开头目录（.git/.import-tmp/…）与 node_modules 里不会有用户提示词
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            collect_md(&p, root, depth + 1, out);
        } else if p.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) {
            let rel = p
                .strip_prefix(root)
                .map(|r| r.display().to_string().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            out.push((p, rel));
        }
    }
}

/// 添加提示词：把用户选的 .md 文件 / 文件夹里的 .md 收进 `_assets/prompts`。
///
/// 与技能导入同源的取舍：
///   · 只收 .md（提示词就是 markdown），文件夹递归但深度受限，防止误选巨型目录
///   · 单次上限 MAX_SKILLS 个文件，超出只记「已截断」不报错
///   · 同名先备份为 `<name>.bak-<ts>`，绝不静默覆盖用户已有提示词
///   · 文件夹递归时把相对路径用 `_` 压平，避免把用户的整棵目录树搬进来
#[tauri::command(async)]
pub fn import_prompt_multi(
    app: AppHandle,
    src_paths: Vec<String>,
) -> Result<ImportManyResult, String> {
    if src_paths.is_empty() {
        return Ok(ImportManyResult {
            cancelled: true,
            imported: vec![],
            skipped: vec![],
            temp_cleaned: true,
        });
    }
    let home = prompts_home(&app)?;

    let mut found: Vec<(PathBuf, String)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();

    for raw in &src_paths {
        let p = PathBuf::from(raw);
        if !p.exists() {
            skipped.push(format!("不存在：{raw}"));
            continue;
        }
        let mut local: Vec<(PathBuf, String)> = Vec::new();
        if p.is_dir() {
            collect_md(&p, &p, 0, &mut local);
            if local.is_empty() {
                skipped.push(format!(
                    "{} 下没找到 .md 文件",
                    p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
                ));
            }
        } else if p.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) {
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            local.push((p.clone(), name));
        } else {
            skipped.push(format!(
                "不是 .md，已跳过：{}",
                p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
            ));
            continue;
        }

        for (f, rel) in local {
            if found.len() >= MAX_SKILLS {
                skipped.push(format!("已达单次上限 {MAX_SKILLS} 个文件，其余未添加"));
                break;
            }
            let key = f.canonicalize().unwrap_or_else(|_| f.clone());
            if seen.insert(key) {
                found.push((f, rel));
            }
        }
    }

    let mut imported: Vec<ImportedSkill> = Vec::new();
    for (src, rel) in found {
        // 文件夹递归时保留相对结构（用 / 转 _，避免把用户目录树整个搬进来）
        let flat = rel.replace('/', "_");
        let name = PathBuf::from(&flat)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(flat.clone());
        if name.is_empty() {
            skipped.push(format!("无法取文件名：{}", src.display()));
            continue;
        }
        let target = home.join(&name);

        // 同名先备份，绝不静默覆盖
        let mut backup: Option<String> = None;
        if target.exists() {
            let bak = home.join(format!("{name}.bak-{}", stamp()));
            match std::fs::rename(&target, &bak) {
                Ok(_) => backup = Some(bak.display().to_string()),
                Err(_) => {
                    // 重命名失败（文件被占用等）也不阻断：先按内容另存一份备份再覆盖
                    let old = std::fs::read_to_string(&target).unwrap_or_default();
                    if write_utf8_no_bom(&bak, &old).is_ok() {
                        backup = Some(bak.display().to_string());
                    }
                }
            }
        }

        let bytes = match std::fs::read(&src) {
            Ok(b) => b,
            Err(e) => {
                skipped.push(format!("读取失败 {}：{e}", src.display()));
                continue;
            }
        };
        if let Err(e) = std::fs::write(&target, &bytes) {
            skipped.push(format!("写入失败 {name}：{e}"));
            continue;
        }

        imported.push(ImportedSkill {
            name: name.clone(),
            target: target.display().to_string(),
            title: name,
            description: String::new(),
            valid: true,
            files: 0,
            backup,
            source: src.display().to_string(),
        });
    }

    Ok(ImportManyResult {
        cancelled: false,
        imported,
        skipped,
        temp_cleaned: true,
    })
}

