// 版本清单引擎：一切皆目录 + manifest.json
//
// 设计目标（按需求演进倒推）：
//   · 多目标多版本       → resources/profiles/<客户端>/<版本>/manifest.json
//   · 每版本独立技能/提示词 → 版本目录自带 prompt.md 与 skills/（自定义版本）
//                         或引用 _assets/（内置版本）
//   · 便于后期增删       → 加版本 = 加目录，删版本 = 删目录，不改代码
//   · 注入位置可声明     → manifest 的 injectTargets 数组
//   · 自定义 文件夹→文件夹 → profiles/_custom/<版本>/manifest.json
//
// 内置版本从 _assets/ 取素材，自定义版本从自己目录取，两者共用同一执行路径。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::inject::{
    count_files_pub as count_files, copy_dir_pub as copy_dir, read_text_pub as read_text,
    write_utf8_no_bom_pub as write_utf8_no_bom, ClientSpec, InjectTarget, InstallReport, WriteMode,
};
use crate::runtime::runtime_root;

// ============================================================
// manifest.json 结构
// ============================================================

/// 提示词来源：引用素材库 或 版本目录内文件
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptRef {
    /// 相对 _assets/ 的路径，如 "prompts/寒霜v4.md"
    #[serde(default)]
    pub asset: Option<String>,
    /// 相对版本目录的文件名，如 "prompt.md"
    #[serde(default)]
    pub file: Option<String>,
    /// 绝对路径（自定义版本可填）
    #[serde(default)]
    pub path: Option<String>,
}

/// 技能来源：引用素材库包 或 版本目录内 skills/
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillRef {
    /// _assets/ 下的技能包目录名
    #[serde(default)]
    pub asset_pack: Option<String>,
    /// 相对版本目录的目录名，如 "skills"
    #[serde(default)]
    pub dir: Option<String>,
    /// 绝对路径目录
    #[serde(default)]
    pub path: Option<String>,
}

/// 一个版本 = 一个 manifest.json
///
/// 预设组新写法（v2）：
///   prompts[]     提示词组（可多份，注入时多选一）—— 唯一权威
///   skillPacks[]  技能组（可多选）—— 唯一权威
///   其余为注入位置声明。
/// 老字段 prompt / skills / choices 仅在读取旧文件时兜底，不再写入。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    /// 归属客户端（codex/zcode/… 或 _custom）
    pub client: String,
    pub label: String,
    #[serde(default)]
    pub desc: String,
    /// 兼容保留；界面不再显示「推荐」标签。
    /// skip_serializing：只读不写，避免 App 保存时把已清掉的字段又写回去。
    #[serde(default, skip_serializing)]
    pub recommended: bool,
    /// 兼容保留；激活词概念已整体废弃，界面不再显示。
    /// skip_serializing：只读不写，避免 App 保存时把已清掉的字段又写回去。
    #[serde(default, skip_serializing)]
    pub activation_word: Option<String>,
    /// 提示词组（可多份，注入时多选一）—— 唯一权威
    #[serde(default)]
    pub prompts: Vec<ManifestPrompt>,
    /// 老字段兜底：prompts 为空时从这里派生。
    ///
    /// skip_serializing 很关键：这些字段只用于**读**旧文件，写回时一律不再输出。
    /// 少了它，界面上任何一次保存都会把 prompt/skills 重新写进 manifest ——
    /// 用户手改干净的配置文件会被 App 悄悄改脏。
    #[serde(default, skip_serializing)]
    pub prompt: Option<PromptRef>,
    /// 技能组（可多选）—— 唯一权威
    #[serde(default)]
    pub skill_packs: Vec<String>,
    /// 老字段兜底：skillPacks 为空时从这里派生（只读，见 prompt 的说明）
    #[serde(default, skip_serializing)]
    pub skills: Option<SkillRef>,
    /// 注入点
    #[serde(default)]
    pub inject_targets: Vec<ManifestTarget>,
    /// 技能落点
    #[serde(default)]
    pub skill_sync: Vec<ManifestSkillSync>,
    #[serde(default)]
    pub module_sync: Option<String>,
}

/// 提示词条目（预设组可挂多份，注入时多选一）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPrompt {
    /// 显示名（默认取文件名）
    #[serde(default)]
    pub name: String,
    /// 相对 _assets/ 的路径，如 "prompts/寒霜v5.md"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    /// 相对版本目录的文件名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// 绝对路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTarget {
    pub path: String,
    /// 只有 "dir" 有意义（第三方文件夹对）。提示词落点一律整份接管，
    /// 不再区分 markedBlock/claudeBlock/overwrite，所以这个字段缺省即空。
    ///
    /// skip_serializing_if：提示词落点写回时不输出该字段，
    /// 让配置文件保持「用户可直接手改」的干净形态。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
    // 以下全是可选项：写回时省略 null，让配置文件保持用户可直接手改的形态
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_payload: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontmatter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_backup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp_tag: Option<String>,
    /// file/dir 模式下的文件名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// dir 模式下的源目录（第三方条目的源：文件或目录）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dir: Option<String>,
    /// 第三方条目的源类型：file | dir（缺省按源的实际类型自动判断）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 第三方条目的用户备注（界面显示用，不参与复制）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 放置后设为只读，防止客户端篡改（云记忆场景用）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub readonly: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSkillSync {
    pub dest: String,
}

/// 单份提示词的解析状态（界面按选中那份显示存在性）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PromptStatus {
    pub name: String,
    /// asset/file/path 里第一个非空值（界面上显示的标识）
    pub key: String,
    /// 这份提示词的真实文件是否存在
    pub ok: bool,
    /// 解析到的绝对路径（存在时才有）
    pub resolved: Option<String>,
}

/// 扫描结果：给前端列出的一行
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEntry {
    pub id: String,
    pub client: String,
    pub label: String,
    pub desc: String,
    pub recommended: bool,
    /// manifest 所在目录
    pub dir: String,
    /// 提示词组是否**全部**可解析（有任何一份缺失即 false）
    pub prompt_ok: bool,
    /// 默认选中那份的标识（界面初始显示它）
    pub prompt_file: String,
    /// 默认选中第几份（第一份能解析到的；都没有则 0）
    pub default_prompt_index: usize,
    /// 每份提示词各自的存在性 —— 界面据此显示，不再用整组状态顶替
    pub prompt_items: Vec<PromptStatus>,
    /// 技能包是否有真实目录
    pub skills_ok: bool,
    pub skills_dir: Option<String>,
    /// 技能个数（扫描得到）
    pub skill_count: usize,
    pub targets: usize,
    /// 是否自定义版本
    pub custom: bool,
    /// 提示词组（预设组挂的多份提示词，注入时多选一）
    pub prompts: Vec<ManifestPrompt>,
    /// 技能组（预设组挂的技能包，可多选安装）
    pub skill_packs: Vec<String>,
}

fn profiles_root(app: &AppHandle) -> PathBuf {
    runtime_root(app).join("profiles")
}

fn assets_root(app: &AppHandle) -> PathBuf {
    runtime_root(app).join("_assets")
}

/// 解析技能源目录
///
/// 优先级：新字段 skillPacks（可多个，取第一个存在的）→ 老的 skills.assetPack
/// → skills.dir（版本目录内）→ skills.path（绝对路径）。
/// 早先只看 skills.assetPack，于是用新字段声明技能组的预设组会被判成
/// 「本组不装技能」，界面自相矛盾。
pub fn resolve_skills(app: &AppHandle, m: &Manifest, version_dir: &Path) -> Option<PathBuf> {
    // 1) 新字段：技能组（取第一个能找到的）
    for pack in &m.skill_packs {
        if let Some(p) = skill_pack_root(app, pack) {
            return Some(p);
        }
    }
    // 2) 老字段兼容
    if let Some(sk) = &m.skills {
        if let Some(pack) = &sk.asset_pack {
            if let Some(p) = skill_pack_root(app, pack) {
                return Some(p);
            }
        }
        if let Some(d) = &sk.dir {
            let p = version_dir.join(d);
            if p.exists() {
                return Some(p);
            }
        }
        if let Some(p) = &sk.path {
            let pb = PathBuf::from(p);
            if pb.exists() {
                return Some(pb);
            }
        }
    }
    None
}

/// 找一个技能包的可注入技能目录。
/// 统一走 inject 的 shipped_skill_pack_root，覆盖三种历史落点：
///   _assets/skill/<包>/skills/、_assets/<包>/materials/skills、_assets/<包>/
fn skill_pack_root(app: &AppHandle, pack: &str) -> Option<PathBuf> {
    crate::inject::shipped_skill_pack_root(app, pack)
}

/// 提示词组：manifest.prompts 为唯一权威；空则用老 prompt 单份兜底派生
fn effective_prompts(m: &Manifest) -> Vec<ManifestPrompt> {
    if !m.prompts.is_empty() {
        return m.prompts.clone();
    }
    if let Some(pr) = &m.prompt {
        let key = pr.asset.clone().or(pr.file.clone()).or(pr.path.clone());
        if let Some(k) = key {
            return vec![ManifestPrompt {
                name: k.split(['/', '\\']).next_back().unwrap_or(&k).to_string(),
                asset: pr.asset.clone(),
                file: pr.file.clone(),
                path: pr.path.clone(),
            }];
        }
    }
    vec![]
}

/// 技能组：manifest.skillPacks 为唯一权威；空则用老 skills.assetPack 兜底派生
fn effective_skill_packs(m: &Manifest) -> Vec<String> {
    if !m.skill_packs.is_empty() {
        return m.skill_packs.clone();
    }
    m.skills
        .as_ref()
        .and_then(|s| s.asset_pack.clone())
        .map(|p| vec![p])
        .unwrap_or_default()
}

/// 解析提示词组并**剔除已不存在的文件**。
///
/// ══ 为什么必须过滤（用户报「删掉的提示词永远占坑不消失」）══════════════
/// 原先 `prompts` / `prompt_items` 直接由 manifest 的 `prompts` 生成，
/// **从不检查文件是否还在**。于是用户在提示词库里删掉某份 .md 之后，
/// 预设组界面里那个 chip 仍然在，还带着红色警告图标 —— 永远不会消失，
/// 只能手改 manifest.json 才能去掉。
///
/// 现在统一走这个函数：只返回**文件真实存在**的条目。
///
/// ══ 关键：列表与安装必须用同一个函数（否则会装错文件）════════════════
/// `profile_install` 同时接收 `prompt_index`（索引进这个列表）与
/// `choice_file`，且**优先按索引取**。若只过滤列表、不过滤安装里的索引
/// 基准，索引就会错位 —— 用户选了第 1 份，实际装的是原始列表里的第 1 份
/// （可能已被删/是另一份），属于静默装错。所以两处都调这个函数。
fn resolved_prompts(app: &AppHandle, m: &Manifest, version_dir: &Path) -> Vec<(ManifestPrompt, PathBuf)> {
    effective_prompts(m)
        .into_iter()
        .filter_map(|p| {
            let r = resolve_prompt_ref(app, &p, version_dir);
            r.map(|path| (p, path))
        })
        .collect()
}


/// 老 PromptRef → 新提示词条目（兼容旧 manifest 兜底路径）
fn legacy_prompt_entry(pr: &PromptRef) -> ManifestPrompt {
    let key = pr.asset.clone().or(pr.file.clone()).or(pr.path.clone()).unwrap_or_default();
    ManifestPrompt {
        name: key.split(['/', '\\']).next_back().unwrap_or(&key).to_string(),
        asset: pr.asset.clone(),
        file: pr.file.clone(),
        path: pr.path.clone(),
    }
}

/// 解析提示词条目的真实文件路径。
///
/// 查找顺序（越靠前越精确）：
///   1. `_assets/<asset>`            —— asset 是完整相对路径时的标准落点
///   2. `_assets/prompts/<asset>`    —— asset 只写了文件名时
///   3. 版本目录内的 file
///   4. 绝对路径 path
///
/// **不做「按文件名全盘兜底」**。
/// 早先为了修「文件被挪位找不到」加过一条兜底：asset 拼不出路径时，
/// 退化成「只按文件名在 _assets 下找」。结果它把**真缺失**也一起吞了 ——
/// manifest 写 `prompts/xxx.md`、该文件已被用户删掉，但 `_assets/xxx.md`
/// 恰有同名文件，于是界面照样报「文件存在」，用户看到的路径和状态又对不上。
/// 位置漂移是用户自己的操作，应该在界面上如实报缺失并让他补，
/// 而不是靠模糊匹配猜一个「差不多」的文件顶上。
pub fn resolve_prompt_ref(app: &AppHandle, p: &ManifestPrompt, version_dir: &Path) -> Option<PathBuf> {
    let base = assets_root(app);
    if let Some(a) = p.asset.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let a = a.replace('\\', "/");
        for c in [base.join(&a), base.join("prompts").join(&a)] {
            if c.is_file() {
                return Some(c);
            }
        }
    }
    if let Some(f) = &p.file {
        let pf = version_dir.join(f);
        if pf.exists() {
            return Some(pf);
        }
    }
    if let Some(p) = &p.path {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    None
}

/// 扫描全部版本清单
#[tauri::command]
pub fn profiles_list(app: AppHandle) -> Vec<ProfileEntry> {
    let root = profiles_root(&app);
    let mut out = Vec::new();
    let Ok(clients) = std::fs::read_dir(&root) else {
        return out;
    };
    for c in clients.filter_map(|e| e.ok()) {
        if !c.path().is_dir() {
            continue;
        }
        let client_id = c.file_name().to_string_lossy().to_string();
        if client_id.starts_with('_') && client_id != "_custom" {
            continue;
        }
        let Ok(versions) = std::fs::read_dir(c.path()) else {
            continue;
        };
        for v in versions.filter_map(|e| e.ok()) {
            let vdir = v.path();
            if !vdir.is_dir() {
                continue;
            }
            let mf = vdir.join("manifest.json");
            let Ok(txt) = std::fs::read_to_string(&mf) else {
                continue;
            };
            let Ok(m) = serde_json::from_str::<Manifest>(&txt) else {
                continue;
            };

            /*
             * 提示词组：**只保留文件真实存在的那些**（用户报「删掉的提示词
             * 永远占坑不消失」—— 详见 resolved_prompts 的注释）。
             * 缺失项不再回给界面，那个 chip 自然就不显示了。
             *
             * 注意 `prompts` 与 `prompt_items` 必须来自**同一个过滤后的列表**，
             * 否则两者索引对不上（界面按 prompt_items[i] 显示第 i 个 chip 的
             * 状态，而 prompts[i] 是另一份文件）。
             */
            let resolved: Vec<(ManifestPrompt, PathBuf)> = resolved_prompts(&app, &m, &vdir);
            // 默认选中第一份（列表已保证全部存在）
            let default_idx = 0usize;
            // 过滤后非空即视为「整组可用」—— 缺失项已经被剔除了，
            // 这里再报 false 只会让界面显示一个指向不存在的红字警告。
            let all_ok = !resolved.is_empty();
            let prompts: Vec<ManifestPrompt> = resolved.iter().map(|(p, _)| p.clone()).collect();

            let skills = resolve_skills(&app, &m, &vdir);
            let skill_count = skills
                .as_ref()
                .map(|p| {
                    std::fs::read_dir(p)
                        .map(|rd| {
                            rd.filter_map(|e| e.ok())
                                .filter(|e| e.path().is_dir() && e.path().join("SKILL.md").exists())
                                .count()
                        })
                        .unwrap_or(0)
                })
                .unwrap_or(0);

            out.push(ProfileEntry {
                id: m.id.clone(),
                client: if m.client.is_empty() { client_id.clone() } else { m.client.clone() },
                label: m.label.clone(),
                desc: m.desc.clone(),
                recommended: m.recommended,
                dir: vdir.display().to_string(),
                // prompt_ok 现在指「整组都齐」；界面按选中那份显示各自的 ok
                prompt_ok: all_ok,
                // 默认选中那份的路径与存在性，界面初始显示的就是它
                prompt_file: resolved
                    .get(default_idx)
                    .map(|(p, _)| p.asset.clone().or(p.file.clone()).or(p.path.clone()).unwrap_or_default())
                    .unwrap_or_default(),
                default_prompt_index: default_idx,
                prompt_items: resolved
                    .iter()
                    .map(|(p, path)| PromptStatus {
                        name: p.name.clone(),
                        key: p
                            .asset
                            .clone()
                            .or(p.file.clone())
                            .or(p.path.clone())
                            .unwrap_or_default(),
                        // 列表已经过滤成「只含存在的文件」，所以恒为 true；
                        // 保留该字段是因为前端仍在读它（进度提示等），
                        // 且以后若要改成"显示缺失项但置灰"还能用上。
                        ok: true,
                        resolved: Some(path.display().to_string()),
                    })
                    .collect(),
                skills_ok: skills.is_some(),
                skills_dir: skills.map(|p| p.display().to_string()),
                skill_count,
                targets: m.inject_targets.len(),
                custom: client_id == "_custom" || m.client == "_custom",
                prompts,
                skill_packs: effective_skill_packs(&m),
            });
        }
    }
    // 推荐版本排前，其余按 label
    out.sort_by(|a, b| {
        b.recommended
            .cmp(&a.recommended)
            .then(a.client.cmp(&b.client))
            .then(a.label.cmp(&b.label))
    });
    out
}

/// 找出某 id 的 manifest 及其目录
fn find_manifest(app: &AppHandle, id: &str) -> Option<(Manifest, PathBuf)> {
    let root = profiles_root(app);
    let clients = std::fs::read_dir(&root).ok()?;
    for c in clients.filter_map(|e| e.ok()) {
        let versions = std::fs::read_dir(c.path()).ok()?;
        for v in versions.filter_map(|e| e.ok()) {
            let vdir = v.path();
            let mf = vdir.join("manifest.json");
            if let Ok(txt) = std::fs::read_to_string(&mf) {
                if let Ok(m) = serde_json::from_str::<Manifest>(&txt) {
                    if m.id == id {
                        return Some((m, vdir));
                    }
                }
            }
        }
    }
    None
}

/// 读某版本的 manifest（前端编辑用）
#[tauri::command]
pub fn profile_get(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let (m, dir) = find_manifest(&app, &id).ok_or_else(|| format!("未找到版本：{id}"))?;
    Ok(serde_json::json!({ "manifest": m, "dir": dir.display().to_string() }))
}

/// 保存 manifest（新建或修改版本）
#[tauri::command]
pub fn profile_save(app: AppHandle, manifest: Manifest, dir_name: Option<String>) -> Result<String, String> {
    let root = profiles_root(&app);
    let client = if manifest.client.is_empty() {
        "_custom".to_string()
    } else {
        manifest.client.clone()
    };
    // 若已存在同 id，就地更新；否则新建目录
    let (_, exist_dir) = match find_manifest(&app, &manifest.id) {
        Some(x) => (Some(x.0), Some(x.1)),
        None => (None, None),
    };
    let vdir = exist_dir.unwrap_or_else(|| {
        let name = dir_name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| manifest.id.clone());
        root.join(&client).join(name)
    });
    std::fs::create_dir_all(&vdir).map_err(|e| e.to_string())?;
    let js = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let mf = vdir.join("manifest.json");
    let tmp = mf.with_extension("json.tmp");
    std::fs::write(&tmp, js).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &mf).map_err(|e| e.to_string())?;
    Ok(vdir.display().to_string())
}

/// 删除版本（可选同时删除版本目录内的 prompt.md / skills）
#[tauri::command]
pub fn profile_delete(app: AppHandle, id: String, remove_dir: bool) -> Result<(), String> {
    let (_, dir) = find_manifest(&app, &id).ok_or_else(|| format!("未找到版本：{id}"))?;
    // 先删 manifest，保证列表立刻不显示
    let _ = std::fs::remove_file(dir.join("manifest.json"));
    if remove_dir {
        // 只删版本目录本身（内置版本引用 _assets，删掉不影响素材）
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(())
}

/// 把 manifest 转成 inject 引擎能用的 ClientSpec + VersionSpec，然后执行安装
///
/// 提示词来源有两个入口，**参数名必须和前端一致**：
///   `prompt_index` —— 提示词组多选一的选中项（0 = 第一份）
///   `choice_file`  —— 前端直接给的提示词标识（asset 相对路径 / 文件名 / 绝对路径）
///
/// 这里曾经踩过一个静默失效的坑：前端发的是 `choiceIndex`/`choiceFile`，
/// 而本函数声明的是 `prompt_index`（Tauri v2 按 camelCase 匹配），
/// 于是 `prompt_index` 永远是 None → 索引回落成 0 → **无论选哪份都注入第一份**。
/// 参数名对不上不会有任何报错，只是安静地用错值，所以两侧名字必须锁死。
///
/// `skill_packs_override`：界面上技能库的最终勾选结果。
///   None = 用预设组声明的技能组；Some(list) = 完全按 list 装
///   （用户取消勾选预设包时也要能真正跳过，所以这里是「替换」而不是「追加」）。
///
/// **必须是 async**：本函数内部会读磁盘、复制技能目录（可能上百个目录），
/// 同步执行会把主线程连同 React 渲染一起卡住 —— 进度弹窗挂载不上，
/// 界面上的进度事件也收不到。
#[tauri::command(async)]
pub fn profile_install(
    app: AppHandle,
    id: String,
    prompt_index: Option<usize>,
    with_skills: bool,
    skill_filter: Option<Vec<String>>,
    skill_packs_override: Option<Vec<String>>,
    choice_file: Option<String>,
    // 重名技能的来源选择：技能名 → 只从这个包取（界面「技能库」弹窗里的选择）
    skill_source_map: Option<std::collections::HashMap<String, String>>,
) -> InstallReport {
    let Some((m, vdir)) = find_manifest(&app, &id) else {
        return InstallReport {
            ok: false,
            steps: vec![],
            skills_installed: vec![],
            skills_skipped: 0,
            error: Some(format!("未找到版本：{id}")),
        };
    };

    let mut spec = manifest_to_spec(&app, &m, &vdir);
    let mut version = manifest_to_version(&m);

    /*
     * 提示词组：必须与 profile_list 用**同一套过滤**（resolved_prompts），
     * 否则前端的 prompt_index 是按过滤后列表给的，这里却按未过滤列表取，
     * 索引错位会静默装错文件 —— 见 resolved_prompts 的注释。
     */
    let list: Vec<(ManifestPrompt, PathBuf)> = resolved_prompts(&app, &m, &vdir);
    let idx = prompt_index.unwrap_or(0);

    // 1) 首选：按索引取提示词组里的那一份（manifest 驱动，最可靠）
    let mut resolved: Option<PathBuf> = list.get(idx).map(|(_, path)| path.clone());

    // 2) 索引取不到时，用前端直接给的标识再试一次
    if resolved.is_none() {
        if let Some(cf) = choice_file.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            // 可能是 asset 相对路径 / 版本目录内文件名 / 绝对路径，逐个试
            let as_entry = ManifestPrompt {
                name: cf.rsplit(['/', '\\']).next().unwrap_or(cf).to_string(),
                asset: Some(cf.to_string()),
                file: None,
                path: None,
            };
            resolved = resolve_prompt_ref(&app, &as_entry, &vdir);
            if resolved.is_none() {
                // 兜底：按文件名在 _assets 里搜（resolve_prompt 自带这条逻辑）
                resolved = crate::inject::resolve_prompt(&app, cf).ok();
            }
        }
    }

    // 3) 最后退回老字段 prompt
    if resolved.is_none() {
        resolved = m
            .prompt
            .as_ref()
            .and_then(|pr| resolve_prompt_ref(&app, &legacy_prompt_entry(pr), &vdir));
    }
    if resolved.is_none() {
        resolved = list.first().map(|(_, path)| path.clone());
    }

    if let Some(p) = resolved {
        // 传绝对路径给引擎，省得它再按目录猜
        version.file = p.display().to_string();
        version.skill_source = m.skills.as_ref().and_then(|s| s.path.clone());
    }

    // 界面勾选结果优先于预设声明（用户取消预设包也要真的不装）
    if let Some(list) = skill_packs_override {
        version.skill_packs = list.into_iter().filter(|s| !s.trim().is_empty()).collect();
    }

    let _ = &mut spec;
    crate::inject::inject_install(
        app,
        spec,
        version,
        None,
        with_skills,
        skill_filter,
        skill_source_map,
    )
}

/// manifest → ClientSpec（注入点、技能落点、模块落点）
///
/// 关键：dir 型注入目标是「第三方文件夹对」（sourceDir → path），
/// 只参与技能复制，**绝不能**进 prompt 注入目标列表 ——
/// 早先 mode 映射里没有 dir 分支，它落到了 MarkedBlock，
/// 结果安装时会把提示词正文写进用户的第三方目录，等于毁数据。
///
/// 注意：`mode` 字段已不再决定写入语义（统一「原文件改名 -bak + 新的放进去」），
/// 它现在只剩一个作用 —— 标识 "dir" 型条目是第三方文件夹对。
pub fn manifest_to_spec(app: &AppHandle, m: &Manifest, vdir: &Path) -> ClientSpec {
    let inject_targets = m
        .inject_targets
        .iter()
        .filter(|t| t.mode != "dir") // dir 型是第三方文件夹对，不是提示词落点
        .map(|t| InjectTarget {
            path: t.path.clone(),
            mode: WriteMode::MarkedBlock,
            begin_key: t
                .begin_key
                .clone()
                .unwrap_or_else(|| "寒霜破甲注入开始".into()),
            begin_payload: t.begin_payload.clone(),
            end_key: t
                .end_key
                .clone()
                .unwrap_or_else(|| "寒霜破甲注入结束".into()),
            frontmatter: t.frontmatter.clone(),
            marker: t.marker.clone(),
            backup_suffix: t.backup_suffix.clone(),
            fixed_backup: t.fixed_backup.clone(),
            stamp_tag: t.stamp_tag.clone(),
        })
        .collect();

    // 技能落点：只看 manifest 的 skillSync。
    //
    // 早先这里还把 dir 型目标（第三方文件夹对）也塞进 skill_sync ——
    // 结果是技能包会被倒进用户的第三方目录，而第三方内容又因为不含
    // SKILL.md 被 sync_skills 全部跳过。两个方向都是错的，现在彻底分开：
    // 技能落点只走 skillSync，第三方走 ClientSpec.third_party。
    let skill_sync: Vec<crate::inject::SkillSync> = m
        .skill_sync
        .iter()
        .map(|s| crate::inject::SkillSync {
            dest: s.dest.clone(),
        })
        .collect();

    let _ = vdir;
    // 第三方条目：dir 型注入目标摘出来，供引擎按「源 → 落点」放置。
    // kind/label/readonly 都是可选扩展（文件型、用户备注、只读防篡改）。
    let third_party = m
        .inject_targets
        .iter()
        .filter(|t| t.mode == "dir" && !t.path.trim().is_empty())
        .map(|t| crate::inject::ThirdPartyPair {
            source: t.source_dir.clone().unwrap_or_default(),
            dest: t.path.clone(),
            kind: t.kind.clone(),
            label: t.label.clone(),
            readonly: t.readonly,
        })
        .collect();
    ClientSpec {
        id: m.client.clone(),
        name: m.label.clone(),
        legacy_script: String::new(),
        versions: vec![manifest_to_version(m)],
        inject_targets,
        skill_sync,
        module_sync: m.module_sync.clone(),
        state_path: None,
        state_style: None,
        third_party,
    }
}

fn manifest_to_version(m: &Manifest) -> crate::inject::VersionSpec {
    // 提示词组第一份作为默认 file；profile_install 会按用户选中的 index 覆盖成绝对路径
    let default_file = effective_prompts(m)
        .first()
        .and_then(|p| p.asset.clone().or(p.file.clone()).or(p.path.clone()))
        .or_else(|| {
            m.prompt
                .as_ref()
                .and_then(|pr| pr.asset.clone().or(pr.file.clone()).or(pr.path.clone()))
        })
        .unwrap_or_default();
    crate::inject::VersionSpec {
        id: m.id.clone(),
        label: m.label.clone(),
        desc: m.desc.clone(),
        file: default_file,
        choices: vec![],
        recommended: m.recommended,
        skill_packs: effective_skill_packs(m),
        extra_files: vec![],
        skill_source: m.skills.as_ref().and_then(|s| s.path.clone()),
    }
}

/// 打开某版本的目录
#[tauri::command]
pub fn profile_open_dir(app: AppHandle, id: String) -> Result<String, String> {
    let (_, dir) = find_manifest(&app, &id).ok_or_else(|| format!("未找到版本：{id}"))?;
    let mut cmd = std::process::Command::new("explorer");
    cmd.arg(dir.display().to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/// 在版本目录内创建资源文件（自定义版本用）
#[tauri::command]
pub fn profile_write_asset(app: AppHandle, id: String, rel: String, content: String) -> Result<String, String> {
    let (_, dir) = find_manifest(&app, &id).ok_or_else(|| format!("未找到版本：{id}"))?;
    let target = dir.join(&rel);
    write_utf8_no_bom(&target, &content)?;
    Ok(target.display().to_string())
}

/// 把源目录复制进版本目录（自定义版本导入技能/提示词）
#[tauri::command]
pub fn profile_import(app: AppHandle, id: String, src: String, rel_dest: String) -> Result<String, String> {
    let (_, dir) = find_manifest(&app, &id).ok_or_else(|| format!("未找到版本：{id}"))?;
    let s = PathBuf::from(&src);
    if !s.exists() {
        return Err(format!("源不存在：{src}"));
    }
    let dest = dir.join(&rel_dest);
    if s.is_dir() {
        copy_dir(&s, &dest)?;
        Ok(format!("{} 个文件", count_files(&dest)))
    } else {
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&s, &dest).map_err(|e| e.to_string())?;
        let _ = read_text(&dest);
        Ok("1 个文件".into())
    }
}

/// 列出所有客户端目录（profiles/<客户端>/），并附带其工作路径。
///
/// 「工作路径」= 该客户端读配置的目录（如 ~/.codex）。从该目录下任一 manifest
/// 的注入位置反推；目录里还没有 manifest 时返回空串，由界面让用户自己填。
///
/// 为什么需要它：界面「添加客户端」要落一个 profiles/<客户端>/ 目录，
/// 而后续所有文件选择对话框都应默认打开这个客户端的工作路径，
/// 不能让用户每次都从 C 盘一层层点进去。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClientEntry {
    pub id: String,
    pub label: String,
    /// 客户端工作路径（展开后的绝对路径），未知则为空
    pub work_dir: String,
    /// 该客户端下的预设组数量
    pub profile_count: usize,
    /// 是否已注入（读该客户端的安装状态文件）
    pub injected: bool,
    /// 已注入的预设组名（未注入则空）
    pub installed_label: Option<String>,
}

/// 读某客户端的安装状态（用于左侧栏显示注入状态）。
///
/// 状态文件位置与 inject 引擎一致：`<runtime>/.codex/state-<client>.json`。
/// 这里只关心「装没装、装的是哪个预设组」，不需要完整解析 InstallState
/// （字段可能随版本增减），所以按 Value 取值。
fn client_injected_state(app: &AppHandle, client: &str) -> (bool, Option<String>) {
    let p = crate::runtime::runtime_root(app)
        .join(".codex")
        .join(format!("state-{client}.json"));
    let Ok(txt) = std::fs::read_to_string(&p) else {
        return (false, None);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
        return (false, None);
    };
    let label = v
        .get("versionLabel")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());
    // 有 versionId 才算「装过」——卸载后会被清空
    let has_id = v
        .get("versionId")
        .and_then(|x| x.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    (has_id, label)
}

/// 客户端配置文件（`profiles/<客户端>/<客户端>.json`）。
///
/// **工作路径的权威记录**。以前工作路径只能从各预设组 manifest 的落点反推，
/// 用户改了盘符就得逐个 manifest 改；现在有一个显式的客户端级文件，
/// 界面显示、体检、agent 读取都以它为准，manifest 里的落点作为同步副本。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    /// 客户端名（= 目录名），如 `codex`
    pub id: String,
    /// 显示名（如 `Codex 破甲`）
    #[serde(default)]
    pub label: String,
    /// 客户端工作路径（配置文件所在目录），如 `C:\Users\x\.codex`
    #[serde(default)]
    pub work_dir: String,
    /// 备注（自由文本）
    #[serde(default)]
    pub notes: String,
}

/// 客户端配置文件路径：`profiles/<id>/<id>.json`
fn client_config_path(app: &AppHandle, id: &str) -> PathBuf {
    profiles_root(app).join(id).join(format!("{id}.json"))
}

/// 读客户端配置（不存在返回 None）。
fn read_client_config(app: &AppHandle, id: &str) -> Option<ClientConfig> {
    let txt = std::fs::read_to_string(client_config_path(app, id)).ok()?;
    serde_json::from_str::<ClientConfig>(&txt).ok()
}

/// 写客户端配置（原子写）。
fn write_client_config(app: &AppHandle, cfg: &ClientConfig) -> Result<(), String> {
    let p = client_config_path(app, &cfg.id);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let js = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, js).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// 从一组注入位置里反推客户端工作路径。
///
/// 规则：取第一个非 `mode:"dir"` 的落点，取其「工作目录」那一段：
///   `~/.codex/AGENTS.md`               → `<HOME>\.codex`
///   `~/.cursor/rules/x.mdc`            → `<HOME>\.cursor`
///   `C:\Users\x\.workbuddy-ai\AGENTS.md` → `C:\Users\x\.workbuddy-ai`
///   `C:\Users\x\.omp\agent\AGENTS.md`  → `C:\Users\x\.omp\agent`
///
/// 绝对路径的段数没法从路径本身判断（`.omp/agent` 是两段还是 `agent` 是子目录？），
/// 所以取**落点所在目录**再往上剥掉已知的落点文件名 —— 即 `<path>` 的父目录链里，
/// 以 `skills` / `rules` 结尾的再退一级。这里按「取父目录」处理：
/// `AGENTS.md` → 其父目录即工作目录；`skills` / `rules` 型落点退到其父。
///
/// 第三方文件夹对（mode=dir）不参与，它们是用户自选的外部目录。
///
/// 这是**兜底**手段：客户端配置文件存在时以它为准（见 `clients_list`）。
fn infer_work_dir(app: &AppHandle, m: &Manifest) -> Option<String> {
    let seg_of = |p: &str| -> Option<String> {
        let rest = p.trim().strip_prefix('~')?;
        let seg = rest
            .trim_start_matches(['/', '\\'])
            .split(['/', '\\'])
            .next()
            .unwrap_or("");
        (!seg.is_empty()).then(|| expand_home(app, &format!("~/{seg}")).display().to_string())
    };
    // ① 优先 `~` 形态的注入点
    for t in m.inject_targets.iter().filter(|t| t.mode != "dir") {
        if let Some(w) = seg_of(&t.path) {
            return Some(w);
        }
    }
    // ② 再试 `~` 形态的技能落点（如 ~/.codex/skills → ~/.codex）
    for s in &m.skill_sync {
        if let Some(w) = seg_of(&s.dest) {
            return Some(w);
        }
    }
    // ③ 全是绝对路径时：取注入点的父目录，再剥掉一层「容器目录」
    //    （`…\.omp\agent\AGENTS.md` 的父是 `…\.omp\agent`；而
    //     `…\.omp\agent\skills` 这类落点要再退一级到 `…\.omp\agent`）
    for t in m.inject_targets.iter().filter(|t| t.mode != "dir") {
        let p = Path::new(t.path.trim());
        if !p.is_absolute() {
            continue;
        }
        let mut dir = p.parent()?;
        let leaf = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if matches!(leaf.to_ascii_lowercase().as_str(), "skills" | "rules" | "commands") {
            dir = dir.parent().unwrap_or(dir);
        }
        return Some(dir.display().to_string());
    }
    None
}

/// `~` → HOME 的展开（profiles.rs 内部用，不依赖 inject 的私有实现）
fn expand_home(_app: &AppHandle, raw: &str) -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if let Some(rest) = raw.strip_prefix('~') {
        PathBuf::from(format!("{home}{rest}").replace('/', "\\"))
    } else {
        PathBuf::from(raw.replace('/', "\\"))
    }
}

/// 客户端显示顺序的存储文件（放在 profiles/ 下，与预设组同级，便于用户查看）
fn clients_order_path(app: &AppHandle) -> PathBuf {
    profiles_root(app).join("_order.json")
}

/// 读取用户自定义的客户端顺序（缺省为空 = 按名字排）
fn read_clients_order(app: &AppHandle) -> Vec<String> {
    std::fs::read_to_string(clients_order_path(app))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// 保存客户端显示顺序（侧栏拖动排序后调用）。
///
/// 顺序单独存 `profiles/_order.json`，不写进各客户端的 manifest ——
/// 顺序是界面偏好，不是预设组的内容，混在一起会让 manifest 难读。
#[tauri::command]
pub fn clients_order_save(app: AppHandle, order: Vec<String>) -> Result<(), String> {
    let root = profiles_root(&app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let js = serde_json::to_string_pretty(&order).map_err(|e| e.to_string())?;
    let p = clients_order_path(&app);
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, js).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clients_list(app: AppHandle) -> Vec<ClientEntry> {
    let root = profiles_root(&app);
    let mut out: Vec<ClientEntry> = Vec::new();
    let Ok(rd) = std::fs::read_dir(&root) else {
        return out;
    };
    for e in rd.filter_map(|x| x.ok()) {
        if !e.path().is_dir() {
            continue;
        }
        let id = e.file_name().to_string_lossy().to_string();
        // `_` 前缀是内部目录（_custom 等），不作为客户端列出
        if id.starts_with('_') {
            continue;
        }
        // 扫该客户端下的 manifest：统计数量 + 反推工作路径
        let mut count = 0usize;
        let mut work: Option<String> = None;
        let mut label = id.clone();
        if let Ok(vs) = std::fs::read_dir(e.path()) {
            for v in vs.filter_map(|x| x.ok()) {
                let mf = v.path().join("manifest.json");
                let Ok(txt) = std::fs::read_to_string(&mf) else {
                    continue;
                };
                let Ok(m) = serde_json::from_str::<Manifest>(&txt) else {
                    continue;
                };
                count += 1;
                if work.is_none() {
                    work = infer_work_dir(&app, &m);
                }
                // 用第一个 manifest 的 client 字段做展示名兜底
                if label == id && !m.client.is_empty() {
                    label = m.client.clone();
                }
            }
        }
        // 客户端配置文件优先：它是工作路径与显示名的**权威记录**，
        // manifest 落点只在没有配置文件时用来反推（老客户端兜底）。
        if let Some(cfg) = read_client_config(&app, &id) {
            if !cfg.work_dir.trim().is_empty() {
                work = Some(cfg.work_dir.clone());
            }
            if !cfg.label.trim().is_empty() {
                label = cfg.label.clone();
            }
        }
        let (injected, installed_label) = client_injected_state(&app, &id);
        out.push(ClientEntry {
            id: id.clone(),
            label,
            work_dir: work.unwrap_or_default(),
            profile_count: count,
            injected,
            installed_label,
        });
    }
    // 按用户自定义顺序排；未记录在 order 里的排在后面（按名字）
    let order = read_clients_order(&app);
    let rank = |id: &str| order.iter().position(|x| x == id).unwrap_or(usize::MAX);
    out.sort_by(|a, b| {
        rank(&a.id)
            .cmp(&rank(&b.id))
            .then(a.id.cmp(&b.id))
    });
    out
}

/// 新建客户端目录 profiles/<客户端>/，并写一个占位 manifest 让它可以立刻建预设组。
///
/// `work_dir`：客户端工作路径（如 ~/.codex），写进默认预设组的注入位置与技能落点，
/// 这样新建后马上可用，用户不必再手填路径。
#[tauri::command]
pub fn client_create(app: AppHandle, id: String, work_dir: Option<String>) -> Result<String, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("客户端名不能为空".into());
    }
    if id.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("客户端名含非法字符：{id}"));
    }
    if id.starts_with('_') {
        return Err("客户端名不能以 _ 开头（该前缀为内部目录保留）".into());
    }
    let dir = profiles_root(&app).join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // 工作路径：给了就用；没给就按 ~/.<id> 猜一个（绝大多数客户端都这样）
    let wd = work_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("~/.{id}"));

    // 客户端配置文件：工作路径的权威记录（展开成绝对路径存，便于 agent 直接读用）
    let wd_abs = if wd.starts_with('~') {
        expand_home(&app, &wd).display().to_string()
    } else {
        wd.replace('/', "\\")
    };
    write_client_config(
        &app,
        &ClientConfig {
            id: id.clone(),
            label: id.clone(),
            work_dir: wd_abs.clone(),
            notes: String::new(),
        },
    )?;

    // 落一个默认预设组，让新客户端不是空目录
    let pdir = dir.join("v1");
    let mf = pdir.join("manifest.json");
    if !mf.exists() {
        std::fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
        let m = serde_json::json!({
            "id": format!("{id}-v1"),
            "client": id,
            "label": format!("{id} 默认预设组"),
            "desc": "新建客户端的默认预设组，可自由修改",
            "prompts": [],
            "skillPacks": [],
            "injectTargets": [{ "path": format!("{wd_abs}/AGENTS.md") }],
            "skillSync": [{ "dest": format!("{wd_abs}/skills") }],
            "moduleSync": format!("{wd_abs}/skills/_modules"),
        });
        let js = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
        std::fs::write(&mf, js).map_err(|e| e.to_string())?;
    }
    Ok(dir.display().to_string())
}

/// 删除客户端目录（连同其下所有预设组）。内置客户端不允许删。
#[tauri::command]
pub fn client_delete(app: AppHandle, id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() || id.starts_with('_') {
        return Err("不能删除该客户端".into());
    }
    let dir = profiles_root(&app).join(id);
    if !dir.is_dir() {
        return Err(format!("客户端不存在：{id}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// 旧工作路径 → 新工作路径的单条路径改写。
///
/// manifest 里的路径有两种等价形态（`~/.codex/AGENTS.md` 与
/// `C:\Users\x\.codex\AGENTS.md`），旧目录也可能以任一形态传入。
/// 这里把两条路径都归一成「展开后的绝对路径」再比对；tilde 形态的
/// 展开需要在归一化时同步做（`~` → 首段路径的绝对前缀）。
///
/// 返回 None 表示该路径不属于旧工作目录（第三方自选目录等），原样保留。
/// 替换结果保留原串大小写，分隔符统一为 `\`。
fn rewrite_workdir_path(p: &str, old_abs: &str, new_backslash: &str, home: &str) -> Option<String> {
    let norm = |s: &str| -> String {
        let s2 = s.replace('/', "\\").trim_end_matches('\\').to_string();
        // tilde 展开：`~/.codex` + home → `<home>\.codex`
        if let Some(rest) = s2.strip_prefix('~') {
            format!("{home}{rest}")
        } else {
            s2
        }
        .to_ascii_lowercase()
    };
    let p_abs = norm(p);
    let old_norm = norm(old_abs);
    if !p_abs.starts_with(&old_norm) {
        return None;
    }
    /*
     * 目录边界检查（必须）：
     *   前缀匹配必须停在路径分隔符处，否则 `C:\Users\x\.workbuddy`
     *   会错误匹配 `C:\Users\x\.workbuddy-ai\AGENTS.md`，
     *   把 `-ai` 当成子路径 → 改出 `...\.workbuddy-ai\-ai\AGENTS.md`。
     *   同理会把 `.omp` 匹配到 `.omp-other`。
     */
    if p_abs.len() > old_norm.len() {
        let rest = &p_abs[old_norm.len()..];
        if !rest.starts_with('\\') && !rest.starts_with('/') {
            return None;
        }
    }
    // 子路径长度 = 归一化后的总长 - 旧前缀长（归一不改变长度：~ 展开与
    // 分隔符替换都在两侧同步做，尾部 trim 除外）
    let sub_len = p_abs.len() - old_norm.len();
    if sub_len == 0 {
        return None;
    }
    // 原串里对应子路径：从尾部数 sub_len 个字符（归一不改变字符数）
    let raw_back = p.replace('/', "\\");
    let raw_trim = raw_back.trim_end_matches('\\');
    let sub = &raw_trim[raw_trim.len() - sub_len..];
    let sub = sub.trim_start_matches('\\');
    if sub.is_empty() {
        None
    } else {
        Some(format!("{new_backslash}\\{sub}"))
    }
}

/// 修改客户端工作路径：批量改写该客户端全部 manifest 的注入点与技能落点。
///
/// 改写规则（按旧 workdir 的「路径前缀」替换）：
///   `~/.codex/AGENTS.md`          → `<new>/AGENTS.md`
///   `C:\Users\x\.codex\skills`    → `<new>\skills`
///
/// 关键点：替换的是**旧 workdir 目录边界之后的部分**，即旧路径去掉
/// 「`~/.<旧段>` 或旧绝对路径整段」后剩下的子路径（`\AGENTS.md`、`\skills\...`），
/// 拼到新目录后面。不认旧前缀的落点（第三方自选目录、别的盘符）原样保留。
///
/// `old_dir`：当前工作路径（前端从 clientsList 拿到传入）。为空时按 `~/.<id>` 推导。
#[tauri::command]
pub fn client_set_workdir(
    app: AppHandle,
    id: String,
    new_dir: String,
    old_dir: String,
) -> Result<u32, String> {
    let id = id.trim();
    if id.is_empty() || id.starts_with('_') {
        return Err("不能修改该客户端".into());
    }
    let new_wd = new_dir.trim().to_string();
    if new_wd.is_empty() {
        return Err("新工作路径不能为空".into());
    }
    if !Path::new(&new_wd).is_absolute() {
        return Err(format!("工作路径必须是绝对路径（{new_wd}）"));
    }
    let client_dir = profiles_root(&app).join(id);
    if !client_dir.is_dir() {
        return Err(format!("客户端不存在：{id}"));
    }

    // 旧目录的两种等价写法：`~/.<段>` 与展开后的绝对路径（/ 和 \ 都归一）
    let old_abs = if old_dir.trim().is_empty() {
        expand_home(&app, &format!("~/.{id}")).display().to_string()
    } else {
        old_dir.trim().replace('/', "\\")
    };
    let new_backslash = new_wd.replace('/', "\\").trim_end_matches('\\').to_string();

    // ① 先写客户端配置文件 —— 它是工作路径的权威记录，
    //    即使一个预设组都没有（没有可改写的 manifest）也算改成功。
    let existing = read_client_config(&app, id);
    write_client_config(
        &app,
        &ClientConfig {
            id: id.to_string(),
            label: existing
                .as_ref()
                .map(|c| c.label.clone())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| id.to_string()),
            work_dir: new_backslash.clone(),
            notes: existing.map(|c| c.notes).unwrap_or_default(),
        },
    )?;

    // ② 再把该客户端全部预设组的落点同步改到新路径
    Ok(sync_client_manifests(&app, id, &old_abs, &new_backslash))
}

/// 把某客户端全部预设组的落点前缀从 `old_abs` 改写到 `new_backslash`。
///
/// 返回改写的 manifest 数。`mode:"dir"` 的第三方条目跳过（不属于工作路径）。
fn sync_client_manifests(app: &AppHandle, id: &str, old_abs: &str, new_backslash: &str) -> u32 {
    let client_dir = profiles_root(app).join(id);
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let mut changed = 0u32;
    if let Ok(vs) = std::fs::read_dir(&client_dir) {
        for v in vs.filter_map(|x| x.ok()) {
            let mf = v.path().join("manifest.json");
            let Ok(txt) = std::fs::read_to_string(&mf) else { continue };
            let Ok(mut m) = serde_json::from_str::<Manifest>(&txt) else { continue };
            let mut dirty = false;

            for t in m.inject_targets.iter_mut() {
                if t.mode == "dir" {
                    continue; // 第三方文件夹对不参与
                }
                if let Some(np) = rewrite_workdir_path(&t.path, old_abs, new_backslash, &home) {
                    t.path = np;
                    dirty = true;
                }
            }
            for s in m.skill_sync.iter_mut() {
                if let Some(np) = rewrite_workdir_path(&s.dest, old_abs, new_backslash, &home) {
                    s.dest = np;
                    dirty = true;
                }
            }
            if let Some(ms) = &m.module_sync {
                if let Some(np) = rewrite_workdir_path(ms, old_abs, new_backslash, &home) {
                    m.module_sync = Some(np);
                    dirty = true;
                }
            }

            if dirty {
                let Ok(js) = serde_json::to_string_pretty(&m) else { continue };
                let tmp = mf.with_extension("json.tmp");
                if std::fs::write(&tmp, js).is_ok() && std::fs::rename(&tmp, &mf).is_ok() {
                    changed += 1;
                }
            }
        }
    }
    changed
}

/// 读某客户端的配置文件（不存在则按 manifest 反推造一份返回，不落盘）。
#[tauri::command]
pub fn client_config_get(app: AppHandle, id: String) -> Result<ClientConfig, String> {
    let id = id.trim();
    if id.is_empty() || id.starts_with('_') {
        return Err("不能读取该客户端".into());
    }
    if let Some(cfg) = read_client_config(&app, id) {
        return Ok(cfg);
    }
    // 老客户端没有配置文件：从 manifest 反推一份（供界面预填），不写盘
    let entry = clients_list(app.clone()).into_iter().find(|c| c.id == id);
    Ok(ClientConfig {
        id: id.to_string(),
        label: entry.as_ref().map(|c| c.label.clone()).unwrap_or_else(|| id.to_string()),
        work_dir: entry.map(|c| c.work_dir).unwrap_or_default(),
        notes: String::new(),
    })
}

/// 保存客户端配置文件（`profiles/<客户端>/<客户端>.json`）。
///
/// 工作路径变化时**顺带同步该客户端全部预设组的落点** —— 否则界面显示新路径、
/// 安装却仍写旧目录，两边不一致。老路径取自改动前的配置文件（没有则按 `~/.<id>` 推导）。
#[tauri::command]
pub fn client_config_save(app: AppHandle, config: ClientConfig) -> Result<u32, String> {
    let id = config.id.trim().to_string();
    if id.is_empty() || id.starts_with('_') {
        return Err("不能修改该客户端".into());
    }
    if !profiles_root(&app).join(&id).is_dir() {
        return Err(format!("客户端不存在：{id}"));
    }
    let new_wd = config.work_dir.trim().replace('/', "\\").trim_end_matches('\\').to_string();
    if !new_wd.is_empty() && !Path::new(&new_wd).is_absolute() {
        return Err(format!("工作路径必须是绝对路径（{new_wd}）"));
    }

    let prev = read_client_config(&app, &id);
    let old_abs = prev
        .as_ref()
        .map(|c| c.work_dir.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| expand_home(&app, &format!("~/.{id}")).display().to_string());

    write_client_config(
        &app,
        &ClientConfig {
            id: id.clone(),
            label: config.label,
            work_dir: new_wd.clone(),
            notes: config.notes,
        },
    )?;

    // 路径真变了才同步 manifest
    let old_norm = old_abs.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let new_norm = new_wd.to_ascii_lowercase();
    if old_norm != new_norm && !new_wd.is_empty() {
        return Ok(sync_client_manifests(&app, &id, &old_abs, &new_wd));
    }
    Ok(0)
}

// ============================================================
// 测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_config_roundtrip() {
        // 客户端配置文件：序列化字段名必须是 camelCase（前端按这个读），
        // 且缺省字段（label/notes）能反序列化成功 —— 用户手写的最小文件也得认。
        let c = ClientConfig {
            id: "codex".into(),
            label: "Codex 破甲".into(),
            work_dir: r"C:\Users\me\.codex".into(),
            notes: "备注".into(),
        };
        let js = serde_json::to_string(&c).unwrap();
        assert!(js.contains("\"workDir\""), "字段名应为 camelCase: {js}");
        let back: ClientConfig = serde_json::from_str(&js).unwrap();
        assert_eq!(back.work_dir, c.work_dir);
        assert_eq!(back.label, c.label);

        // 最小文件（只有 id + workDir）：其余字段取默认值
        let min: ClientConfig = serde_json::from_str(r#"{"id":"pi","workDir":"C:\\x\\.pi"}"#).unwrap();
        assert_eq!(min.id, "pi");
        assert_eq!(min.work_dir, r"C:\x\.pi");
        assert!(min.label.is_empty());
        assert!(min.notes.is_empty());
    }

    #[test]
    fn rewrite_workdir_respects_directory_boundary() {
        // 前缀相同但不同目录：`.workbuddy` 不能匹配 `.workbuddy-ai`，
        // `.omp` 不能匹配 `.omp-other` —— 否则会把 `-ai` 当子路径拼进新路径。
        let out = rewrite_workdir_path(
            r"C:\Users\me\.workbuddy-ai\AGENTS.md",
            r"C:\Users\me\.workbuddy",
            r"E:\new",
            r"C:\Users\me",
        );
        assert_eq!(out, None, "不该匹配更长的兄弟目录");
        let out2 = rewrite_workdir_path(
            r"C:\Users\me\.omp-other\skills",
            r"C:\Users\me\.omp",
            r"E:\new",
            r"C:\Users\me",
        );
        assert_eq!(out2, None);
        // 边界正确时仍要能改
        let ok = rewrite_workdir_path(
            r"C:\Users\me\.workbuddy-ai\AGENTS.md",
            r"C:\Users\me\.workbuddy-ai",
            r"E:\new",
            r"C:\Users\me",
        );
        assert_eq!(ok.as_deref(), Some(r"E:\new\AGENTS.md"));
    }

    #[test]
    fn rewrite_workdir_absolute_paths() {
        // 绝对路径前缀替换（Windows 反斜杠形态）
        let out = rewrite_workdir_path(
            r"C:\Users\me\.workbuddy-ai\skills",
            r"C:\Users\me\.workbuddy-ai",
            r"E:\tools\wb",
            r"C:\Users\me",
        );
        assert_eq!(out.as_deref(), Some(r"E:\tools\wb\skills"));
    }

    #[test]
    fn rewrite_workdir_tilde_paths() {
        // `~/.<段>` 形态：home 展开后与旧绝对路径等价，必须能匹配
        let out = rewrite_workdir_path(
            "~/.codex/AGENTS.md",
            r"C:\Users\me\.codex",
            "D:\\portable\\codex",
            r"C:\Users\me",
        );
        assert_eq!(out.as_deref(), Some("D:\\portable\\codex\\AGENTS.md"));
        // 混合形态：tilde 路径 + 正斜杠
        let out2 = rewrite_workdir_path(
            "~/.codex/skills/_modules",
            "C:/Users/me/.codex",
            r"E:\new",
            r"C:\Users\me",
        );
        assert_eq!(out2.as_deref(), Some(r"E:\new\skills\_modules"));
    }

    #[test]
    fn rewrite_workdir_unrelated_path_kept() {
        // 别的盘符/别的目录：不改
        let out = rewrite_workdir_path(
            r"D:\Other\config.json",
            r"C:\Users\me\.codex",
            r"E:\new",
            r"C:\Users\me",
        );
        assert_eq!(out, None);
        // 同 home 下不同段：不改（~/.claude ≠ ~/.codex）
        let out2 = rewrite_workdir_path(
            "~/.claude/CLAUDE.md",
            r"C:\Users\me\.codex",
            r"E:\new",
            r"C:\Users\me",
        );
        assert_eq!(out2, None);
    }

    #[test]
    fn rewrite_workdir_case_and_slash_insensitive() {
        // 大小写、正反斜杠差异不影响比对
        let out = rewrite_workdir_path(
            "c:/users/me/.omp/agent/skills",
            r"C:\Users\ME\.omp",
            r"F:\omp2",
            r"C:\Users\me",
        );
        assert_eq!(out.as_deref(), Some(r"F:\omp2\agent\skills"));
    }

    #[test]
    fn rewrite_workdir_equal_path_returns_none() {
        // 路径恰好等于旧目录本身（无子路径）：没有可改的部分，保持原样
        let out = rewrite_workdir_path(r"C:\Users\me\.codex\", r"C:\Users\me\.codex", r"E:\x", r"C:\Users\me");
        assert_eq!(out, None);
    }

    #[test]
    fn manifest_parses_minimal() {
        let js = r#"{
            "id":"codex-v4","client":"codex","label":"顶尖破甲 V4",
            "prompt":{"asset":"prompts/寒霜v4.md"},
            "skills":{"assetPack":"codex-skills-v4"},
            "injectTargets":[{"path":"~/.codex/AGENTS.md","mode":"markedBlock"}]
        }"#;
        let m: Manifest = serde_json::from_str(js).expect("应能解析");
        assert_eq!(m.id, "codex-v4");
        assert_eq!(m.client, "codex");
        assert_eq!(m.inject_targets.len(), 1);
        assert_eq!(m.inject_targets[0].mode, "markedBlock");
        assert!(m.skills.as_ref().unwrap().asset_pack.is_some());
    }

    #[test]
    fn manifest_parses_custom_folder_mapping() {
        // 自定义版本：用户自选文件夹 → 文件夹
        let js = r#"{
            "id":"custom-t1","client":"_custom","label":"我的版本",
            "prompt":{"file":"prompt.md"},
            "skills":{"dir":"skills"},
            "injectTargets":[
                {"path":"D:\\App\\config","mode":"file","fileName":"AGENTS.md"},
                {"path":"D:\\App\\skills","mode":"dir"}
            ],
            "skillSync":[{"dest":"D:\\App\\skills"}]
        }"#;
        let m: Manifest = serde_json::from_str(js).expect("应能解析自定义版本");
        assert_eq!(m.client, "_custom");
        assert_eq!(m.inject_targets.len(), 2);
        assert_eq!(m.inject_targets[0].file_name.as_deref(), Some("AGENTS.md"));
        assert_eq!(m.inject_targets[1].mode, "dir");
    }

    #[test]
    fn dir_target_becomes_skill_sync() {
        // dir 型注入目标应自动成为技能落点
        let js = r#"{
            "id":"x","client":"_custom","label":"x",
            "prompt":{"file":"p.md"},
            "injectTargets":[{"path":"D:\\t","mode":"dir"}]
        }"#;
        let m: Manifest = serde_json::from_str(js).unwrap();
        // 用 manifest_to_spec 需要 AppHandle，这里只验证转换意图：
        let dir_targets = m.inject_targets.iter().filter(|t| t.mode == "dir").count();
        assert_eq!(dir_targets, 1, "dir 目标应被识别");
    }

    /// 老 manifest（choices + prompt + skills + recommended）必须仍能读进来 ——
    /// 用户手上的旧配置文件不能因为升级就打不开。
    #[test]
    fn legacy_manifest_still_reads() {
        let js = r#"{
            "id":"codex-v5","client":"codex","label":"V5","recommended":true,
            "prompt":{"asset":"prompts/gpt-6-astra-v1.md"},
            "skills":{"assetPack":"codex-skills-v4"},
            "choices":[
                {"name":"六","desc":"Astra","file":"prompts/gpt-6-astra-v1.md"}
            ],
            "injectTargets":[{"path":"~/.codex/AGENTS.md","mode":"markedBlock"}]
        }"#;
        let m: Manifest = serde_json::from_str(js).expect("旧 manifest 应能解析");
        assert!(m.recommended);
        assert_eq!(m.prompt.as_ref().unwrap().asset.as_deref(), Some("prompts/gpt-6-astra-v1.md"));
        assert_eq!(m.skills.as_ref().unwrap().asset_pack.as_deref(), Some("codex-skills-v4"));
        // 老字段兜底派生：prompts 为空 → 用 prompt 派生一份
        let eff = effective_prompts(&m);
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].asset.as_deref(), Some("prompts/gpt-6-astra-v1.md"));
        // 老字段兜底派生：skillPacks 为空 → 用 skills.assetPack 派生
        assert_eq!(effective_skill_packs(&m), vec!["codex-skills-v4".to_string()]);
    }

    /// 关键不变量：写回时**绝不能**再输出 choices/prompt/skills/recommended。
    /// 少了这条，界面上任何一次保存都会把用户手改干净的 manifest 重新写脏
    /// （实测发生过：规范化之后 App 一次保存就把三个旧字段全写回去了）。
    #[test]
    fn legacy_fields_are_never_serialized() {
        let js = r#"{
            "id":"x","client":"codex","label":"x","recommended":true,
            "prompt":{"asset":"a.md"},
            "skills":{"assetPack":"p1"},
            "choices":[{"name":"n","desc":"d","file":"f.md"}],
            "prompts":[{"name":"a.md","asset":"a.md"}],
            "skillPacks":["p1"],
            "injectTargets":[{"path":"~/.codex/AGENTS.md","mode":"markedBlock"}]
        }"#;
        let m: Manifest = serde_json::from_str(js).unwrap();
        let out = serde_json::to_string(&m).unwrap();
        for banned in ["\"choices\"", "\"prompt\"", "\"skills\"", "\"recommended\""] {
            assert!(
                !out.contains(banned),
                "写回的 manifest 不应包含旧字段 {banned}，实际输出：{out}"
            );
        }
        // 新字段必须保留
        assert!(out.contains("\"prompts\""));
        assert!(out.contains("\"skillPacks\""));
    }
}
