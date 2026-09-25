#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cloud;
mod cloud_translate;
mod profiles;
mod inject;
mod runtime;
mod winproc;
mod alias;
mod import_skill;

use tauri::Emitter;
use tauri::Manager;

/// 应用启动时按配置自动拉起本地代理。
///
/// ══ 为什么需要它 ═══════════════════════════════════════════════════
/// `auto_start` 字段（UI 上的「随工具启动 / 退出时自动停止」开关）
/// 之前只有读写、**没有任何地方消费它**：配置里写着 true，实际启动工具
/// 后代理仍然是关的。症状是「客户端 base_url 指着 127.0.0.1:14649，
/// 一发消息就连接被拒 / 502」，用户以为代理「刚开过」。
///
/// 放在 setup 里而不是前端 useEffect：客户端（codex 等）是在工具之外
/// 独立启动的，可能早于用户切到「云过审」页；等前端挂载再起代理会有
/// 一段「点了客户端却没代理」的窗口期。
fn spawn_proxy_if_auto_start(app: &tauri::AppHandle) {
    use tauri::Manager;
    let cfg = cloud::cloud_config_get(app.clone());
    if !cfg.auto_start || cfg.upstream_url.trim().is_empty() {
        return;
    }
    let state = app.state::<cloud::CloudProxy>();
    if state.running.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app2 = app.clone();
    // 起代理要 bind 端口，可能失败；失败只记日志，不拦启动
    std::thread::spawn(move || {
        let r = cloud::cloud_proxy_start(app2.clone(), cfg, app2.state::<cloud::CloudProxy>());
        let msg = if r.ok {
            format!("[cloud] 随工具自动启动本地服务端 {}", r.listen)
        } else {
            format!(
                "[cloud] 自动启动失败：{}（可在「云过审」页手动启动）",
                r.error.unwrap_or_default()
            )
        };
        let _ = app2.emit("runtime:log", (msg, if r.ok { "ok" } else { "warn" }.to_string()));
    });
}

fn main() {
    /*
     * WebView2 用户数据目录（含前端 localStorage：主题、技能勾选等）默认落在
     * `%APPDATA%\\alice`，跑在系统盘上。用户要求「所有配置不落其他盘，
     * 统一放 exe 同级的 resources 内，方便 agent 改」—— 所以在建窗口前
     * 把 `WEBVIEW2_USER_DATA_FOLDER` 指到包内 `resources/data/WebView2`。
     *
     * 必须在 Builder 之前设置：WebView2 在创建环境时读这个变量，设晚了不生效。
     * 目录不存在时 WebView2 会自己建，这里只是先备好父目录。
     */
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                // 与 runtime_root 同口径：认「含 .codex 或 runtime 的 resources」为运行体根
                let root = [
                    dir.join("resources"),
                    dir.join("resources/王炸codex"),
                    dir.join("王炸codex"),
                ]
                .into_iter()
                .find(|c| c.join(".codex").exists() || c.join("runtime").exists())
                .unwrap_or_else(|| dir.join("resources"));
                let data = root.join("data").join("WebView2");
                let _ = std::fs::create_dir_all(&data);
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data);
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(runtime::CodexProc::default())
        .manage(runtime::AgentProcs::default())
        .manage(alias::AliasGuards::default())
        .manage(cloud::CloudProxy::default())
        .invoke_handler(tauri::generate_handler![
            // 运行时 / 王炸codex
            runtime::engine_probe,
            runtime::runtime_root_path,
            runtime::codex_launch,
            runtime::codex_stop,
            runtime::codex_factory_reset,
            runtime::codex_import_portable,
            runtime::codex_status,
            runtime::codex_alias_status,
            runtime::codex_alias_rotate,
            runtime::open_path,
            runtime::read_text,
            runtime::write_text,
            runtime::list_dir,
            runtime::append_with_backup,
            // config.toml 透传（只同步模型/供应商字段，保留包内 MCP 段）
            runtime::read_host_config,
            runtime::read_bundled_config,
            runtime::sync_config_from_host,
            // 提示词注入引擎
            inject::inject_status,
            inject::inject_install,
            inject::inject_uninstall,
            // 真实文件扫描（技能库 / 提示词库）
            inject::scan_installed_skills,
            inject::scan_shipped_skill_packs,
            inject::scan_prompts,
            inject::read_file_text,
            inject::save_file_text,
            inject::delete_path,
            inject::version_bundle,
            inject::import_skill_dir,
            // 便携箱（.codex）提示词选择注入 + 技能库批量导入
            inject::list_codex_prompts,
            inject::inject_codex_prompt,
            inject::import_skills_to_codex,
            inject::list_codex_skills,
            inject::count_codex_skills,
            inject::codex_skills_root,
            inject::remove_codex_skill,
            // 技能包管理（新建 / 重命名 / 删除整包）
            // 这三个函数一直存在于 inject.rs，但漏了注册 —— 前端调用会得到
            // "Command xxx not found"，表现为技能库的「新建技能包 / 重命名 / 删除整包」全失效。
            inject::save_pack_meta,
            inject::create_skill_pack,
            inject::delete_skill_pack,
            // 技能导入：原生多选 + 自动解压 + 自动识别
            import_skill::pick_import_sources,
            import_skill::import_skill_multi,
            // 提示词添加：用户自备 .md 文件 / 文件夹 → _assets/prompts
            import_skill::import_prompt_multi,
            import_skill::pick_one_folder,
            import_skill::pick_one_file,
            // 自定义版本（用户自选 文件夹→文件夹 注入）
            inject::custom_versions_list,
            inject::custom_version_save,
            inject::custom_version_delete,
            inject::custom_version_install,
            inject::browse_dir,
            // 版本清单（manifest 驱动）
            profiles::profiles_list,
            profiles::profile_get,
            profiles::profile_save,
            profiles::clients_list,
            profiles::clients_order_save,
            profiles::client_create,
            profiles::client_delete,
            profiles::profile_delete,
            profiles::profile_install,
            profiles::profile_open_dir,
            profiles::profile_write_asset,
            profiles::profile_import,
            // Agent 助手会话（05 会话页）：列表 / 新建 / 跑一轮 / 停止 / 状态
            runtime::agent_list,
            runtime::agent_create,
            runtime::agent_launch,
            runtime::agent_stop,
            runtime::agent_status,
            runtime::agent_refresh_snapshot,
            runtime::agent_save_image,
            runtime::agent_live_steps,
            // 写入通道：agent 输出围栏块，宿主直接落盘并留档，界面可回看/移除
            runtime::agent_applied_writes,
            runtime::agent_dismiss_write,
            profiles::client_set_workdir,
            profiles::client_config_get,
            profiles::client_config_save,
            // 云过审：配置 / 统计 / 自检 / 模型 / 客户端接入 / 代理
            cloud::cloud_config_get,
            cloud::cloud_config_set,
            cloud::cloud_config_reset,
            cloud::cloud_defaults,
            cloud::cloud_stats,
            cloud::cloud_stats_reset,
            cloud::cloud_rules_file_path,
            cloud::cloud_rules_open_folder,
            cloud::cloud_rules_reload,
            cloud::cloud_models_fetch,
            cloud::cloud_selftest,
            cloud::cloud_proxy_start,
            cloud::cloud_proxy_stop,
            cloud::cloud_proxy_status,
            cloud::cloud_probe_text,
            inject::import_prompts_to_codex,
        ])
        .setup(|app| {
            // 便携运行体 / 云过审代理都依赖包根，晚一步启动避免拖慢窗口
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                spawn_proxy_if_auto_start(&handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Alice 启动失败");
}