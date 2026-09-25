/**
 * Tauri 桥接层：唯一后端出口。
 *
 * 浏览器里跑（阶段一 dev / 设计评审）→ 自动降级为 mock，页面照常可用。
 * Tauri 窗口里跑（桌面客户端）→ 全部走 Rust commands 真执行。
 *
 * 页面组件一律只调这里，不直接 import @tauri-apps/api，
 * 这样换壳、换协议、加缓存都只改本文件。
 */

export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let invokeImpl: InvokeFn | null = null
let listenImpl:
  | (<T>(event: string, cb: (payload: T) => void) => Promise<() => void>)
  | null = null

if (IS_TAURI) {
  // 动态导入，避免浏览器构建时把 Tauri API 打进包
  void (async () => {
    const core = await import('@tauri-apps/api/core')
    invokeImpl = core.invoke as InvokeFn
    const ev = await import('@tauri-apps/api/event')
    listenImpl = async <T,>(event: string, cb: (payload: T) => void) => {
      const un = await ev.listen<T>(event, (e) => cb(e.payload))
      return un
    }
  })()
}

/** 调用后端命令；非 Tauri 环境抛错，由调用方决定是否降级 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeImpl) {
    // 首次调用时模块可能还没加载完，等一下
    for (let i = 0; i < 20 && !invokeImpl; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  if (!invokeImpl) throw new Error('NOT_TAURI')
  return invokeImpl<T>(cmd, args)
}

/** 订阅后端事件（日志/状态流），返回取消订阅函数 */
export async function onEvent<T>(
  event: string,
  cb: (payload: T) => void,
): Promise<() => void> {
  if (!listenImpl) {
    for (let i = 0; i < 20 && !listenImpl; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  if (!listenImpl) return () => {}
  return listenImpl<T>(event, cb)
}

// ---------- 后端命令的类型化封装（字段即契约，见 types/domain.ts） ----------

export interface ProbeCheckDto {
  key: string
  label: string
  ok: boolean
  detail: string
}

/** 提示词库的一个来源（体检项里可切换） */
export interface PromptSourceDto {
  rel: string
  label: string
  path: string
  count: number
  /** 是否被 config.toml 的 model_instructions_file 指向（当前生效） */
  active: boolean
}

export interface ProbeReportDto {
  root: string
  checks: ProbeCheckDto[]
  counts: { skills: number; prompts: number; mcp_libs: number }
  runtime_mb: number
  has_key: boolean
  codex_version: string
  adb_version: string
  python_version: string
  ok: boolean
  prompt_sources: PromptSourceDto[]
  config_provider: string
  host_config_exists: boolean
  host_config_path: string
}

/** config.toml 的关键字段（只同步这些，不整份覆盖） */
export interface ConfigModelFieldsDto {
  model: string
  model_provider: string
  model_reasoning_effort: string
  model_context_window: string
  model_auto_compact_token_limit: string
  disable_response_storage: string
  provider_block: string
  from: string
}

/** 读本机 ~/.codex/config.toml 的模型/供应商字段（只读） */
export const readHostConfig = () => invoke<ConfigModelFieldsDto>('read_host_config')

/** 读包内 .codex/config.toml 的模型/供应商字段 */
export const readBundledConfig = () => invoke<ConfigModelFieldsDto>('read_bundled_config')

/** 把本机模型/供应商字段透传到包内（保留包内 MCP 段，原文件先备份） */
export const syncConfigFromHost = () => invoke<string>('sync_config_from_host')

export interface LaunchResultDto {
  ok: boolean
  pid: number | null
  error: string | null
  /** 关联/残留的进程 PID 列表（停止与状态查询回执） */
  pids?: number[]
  /** 当前跟踪的运行体实例数 */
  count?: number
  /** 本实例的随机镜像名（如 `wz7f3a91c2`） */
  aliasName?: string
  /** 是否已开启独占终止保护（外部杀不掉，只有本程序能停） */
  protected?: boolean
}

export interface DirEntryDto {
  name: string
  path: string
  is_dir: boolean
  size: number
}

/**
 * 引擎自检。
 *
 * `deep=true`（用户主动点「自检」）：跑 codex/adb/python 的 --version 子进程，
 * 并强制重算运行体体积。
 * 缺省（启动时的自动探针）：不跑子进程、体积走缓存 —— 启动路径只求快。
 */
export const engineProbe = (deep = false) => invoke<ProbeReportDto>('engine_probe', { deep })

/** 运行体根目录（拼 `_assets/other` 之类路径时用） */
export const runtimeRoot = () => invoke<string>('runtime_root_path')

/** 安装/卸载进度事件的单项 */
export interface InjectProgressItem {
  /** install | uninstall */
  phase: 'install' | 'uninstall'
  /** 唯一 key（如 target:~/.codex/AGENTS.md） */
  key: string
  /** 显示文案 */
  label: string
  /** 该项是否成功 */
  ok: boolean
}

/** 安装/卸载的计划清单事件（开跑前一次性发全，界面照此画待办行） */
export interface InjectPlanItem {
  key: string
  label: string
}
export interface InjectPlanEvent {
  phase: 'install' | 'uninstall'
  items: InjectPlanItem[]
}
export const codexLaunch = (mode: 'cli' | 'exec' | 'desktop', execTask?: string) =>
  invoke<LaunchResultDto>('codex_launch', { mode, execTask: execTask ?? null })
export const codexStop = () => invoke<LaunchResultDto>('codex_stop')
/**
 * 导入本地 codex 目录作为便携箱（包内缺 .codex 时的恢复入口）。
 * 源目录必须含 config.toml；包内已有 .codex 时后端会拒绝。
 */
export const codexImportPortable = (source: string) =>
  invoke<string>('codex_import_portable', { source })
/** 选 .md 文件复制进 .codex/prompts（同名先备份），返回导入的文件名列表 */
export const importPromptsToCodex = (files: string[]) =>
  invoke<string[]>('import_prompts_to_codex', { files })
/**
 * 恢复出厂清理：清空会话/记忆/日志等运行数据，只保留
 * skills/、prompts/ 与关键配置（config.toml/auth.json/api_key.txt/AGENTS.md）。
 * 必须传 confirm_token="RESET"（二次确认令牌），否则后端拒绝执行。
 */
export const codexFactoryReset = () =>
  invoke<string>('codex_factory_reset', { confirmToken: 'RESET' })
export const codexStatus = () => invoke<LaunchResultDto>('codex_status')
/** 随机名 / 独占保护状态查询 */
export const codexAliasStatus = () => invoke<LaunchResultDto>('codex_alias_status')
/** 换一个随机名重启（停止后用新名字拉起同一模式） */
export const codexAliasRotate = (mode?: 'cli' | 'exec' | 'desktop', execTask?: string) =>
  invoke<LaunchResultDto>('codex_alias_rotate', {
    mode: mode ?? null,
    execTask: execTask ?? null,
  })
export const openPath = (path: string) => invoke<LaunchResultDto>('open_path', { path })
export const readText = (path: string) => invoke<string>('read_text', { path })
export const writeText = (path: string, content: string) =>
  invoke<void>('write_text', { path, content })
export const listDir = (path: string) => invoke<DirEntryDto[]>('list_dir', { path })
export const appendWithBackup = (path: string, content: string) =>
  invoke<string>('append_with_backup', { path, content })

// ---------- 云过审 ----------

export interface RulePairDto {
  from: string
  to: string
}

export interface CloudConfigDto {
  listenHost: string
  listenPort: number
  autoStart: boolean
  maxRetry: number
  upstreamMode: string
  upstreamUrl: string
  apiKey: string
  line: string
  model: string
  testModel: string
  featGreetingGate: boolean
  featInjectInstructions: boolean
  featSensitiveRewrite: boolean
  featTokenizeTargets: boolean
  featWarmupHistory: boolean
  featMultiWaveRetry: boolean
  featResponseClean: boolean
  /** 是否同时洗白 system 提示词（AGENTS.md 里天然含敏感词） */
  featWashSystem: boolean
  /** 自定义洗白表（空 = 用内置） */
  rewrites: RulePairDto[]
  /** 自定义判定表（空 = 用内置） */
  refusals: string[]
}

export interface CloudStatsDto {
  requests: number
  hits: number
  retries: number
  graybox: number
  cleaned: number
  gates: number
  errors: number
  selftestOk: boolean | null
  selftestDetail: string
}

export interface ProxyStartResultDto {
  ok: boolean
  listen: string
  error: string | null
}

export const cloudConfigGet = () => invoke<CloudConfigDto>('cloud_config_get')
export const cloudConfigSet = (config: CloudConfigDto) =>
  invoke<CloudConfigDto>('cloud_config_set', { config })
/** 还原默认规则与开关（保留上游/密钥等连接信息） */
export const cloudConfigReset = () => invoke<CloudConfigDto>('cloud_config_reset')
/** 取内置默认规则表（编辑界面加载用） */
export const cloudDefaults = () =>
  invoke<{ rewrites: RulePairDto[]; refusals: string[] }>('cloud_defaults')
export const cloudStats = () => invoke<CloudStatsDto>('cloud_stats')
export const cloudStatsReset = () => invoke<void>('cloud_stats_reset')
/** 外置规则表 JSON 文件的绝对路径 */
export const cloudRulesFilePath = () => invoke<string>('cloud_rules_file_path')
/** 在资源管理器中打开规则表所在文件夹（并选中文件）；文件不存在时先写入模板 */
export const cloudRulesOpenFolder = () => invoke<string>('cloud_rules_open_folder')
/** 重载外置规则表（改完文件保存后点此立即生效，无需重启代理），返回条数 */
export const cloudRulesReload = () => invoke<number>('cloud_rules_reload')
export const cloudModelsFetch = (config: CloudConfigDto) =>
  invoke<string[]>('cloud_models_fetch', { config })
export const cloudSelftest = (config: CloudConfigDto) =>
  invoke<CloudStatsDto>('cloud_selftest', { config })
export const cloudProxyStart = (config: CloudConfigDto) =>
  invoke<ProxyStartResultDto>('cloud_proxy_start', { config })
export const cloudProxyStop = () => invoke<ProxyStartResultDto>('cloud_proxy_stop')
export const cloudProxyStatus = () => invoke<ProxyStartResultDto>('cloud_proxy_status')
export const cloudProbeText = (text: string, config: CloudConfigDto) =>
  invoke<Record<string, unknown>>('cloud_probe_text', { text, config })

// ---------- 提示词注入引擎 ----------

export interface TargetStatusDto {
  /** prompt | skills | thirdParty | modules */
  kind: string
  path: string
  exists: boolean
  injected: boolean
  blockLen: number
  fileLen: number
  backup: string | null
  /** 目录型落点里的条目数（技能数 / 第三方顶层项 / 模块 md 数） */
  itemCount: number
  /** 目录型落点的来源标签（技能包名 / 第三方源目录） */
  label: string | null
  /** 该落点是否真的落盘成功 */
  ok: boolean
}

export interface InstallReportDto {
  ok: boolean
  steps: string[]
  skillsInstalled: string[]
  skillsSkipped: number
  error: string | null
}

/** 查看某客户端各注入目标的当前状态 */
export const injectStatus = (client: unknown) =>
  invoke<TargetStatusDto[]>('inject_status', { client })

/** 安装：注入提示词 + 同步技能；skillFilter 为勾选的技能名（空=全部） */
export const injectInstall = (
  client: unknown,
  version: unknown,
  choiceFile?: string | null,
  withSkills = true,
  skillFilter?: string[] | null,
) =>
  invoke<InstallReportDto>('inject_install', {
    client,
    version,
    choiceFile: choiceFile ?? null,
    withSkills,
    skillFilter: skillFilter ?? null,
  })

/** 卸载：摘块/还原 + 清理本工具装过的技能 */
export const injectUninstall = (client: unknown, restoreBackup = true) =>
  invoke<InstallReportDto>('inject_uninstall', { client, restoreBackup })

// ---------- 真实文件扫描（技能库 / 提示词库） ----------

export interface SkillItemDto {
  name: string
  path: string
  title: string
  description: string
  files: number
  skillMdLen: number
  mtime: number
  valid: boolean
  /** 子路由技能（subskills/<名>/SKILL.md） */
  subSkills: string[]
  hasReferences: boolean
  hasScripts: boolean
  /** 目录形态：simple | router（带子路由） | tree（带参考树/脚本） */
  shape: 'simple' | 'router' | 'tree' | string
}

/**
 * 技能包。
 *
 * 注意：**没有「模块」这个概念**。`_modules` 只是技能包里的一个子目录，
 * 由 sync_skills 跟着技能包一起复制到客户端，不是独立的东西。
 * 有的包带它、有的不带，这属于包自身的差异。
 */
export interface SkillPackDto {
  id: string
  path: string
  skills: SkillItemDto[]
  /** 展示名（用户可在界面命名） */
  title: string
  /** 是否用户自建 */
  custom: boolean
}

export interface PromptItemDto {
  file: string
  path: string
  source: string
  size: number
  mtime: number
  preview: string
  hasPlaceholders: boolean
}

/** 已安装技能（扫客户端 skills 目录） */
export const scanInstalledSkills = (client: unknown) =>
  invoke<SkillItemDto[]>('scan_installed_skills', { client })

/** 随包技能库（_assets 下的技能包） */
export const scanShippedSkillPacks = () => invoke<SkillPackDto[]>('scan_shipped_skill_packs')

/** 全部真实提示词文件（多来源） */
export const scanPrompts = () => invoke<PromptItemDto[]>('scan_prompts')

/** 读文件正文 */
export const readFileText = (path: string) => invoke<string>('read_file_text', { path })

/** 写文件正文（自动备份 .bak-edit-<ts>，保留 3 份） */
export const saveFileText = (path: string, content: string) =>
  invoke<void>('save_file_text', { path, content })

// ---------- 技能包管理（用户命名 / 新建 / 删除） ----------

export interface PackMetaDto {
  title: string
  desc: string
  custom: boolean
}

/** 用户命名技能包 */
export const savePackMeta = (pack: string, meta: PackMetaDto) =>
  invoke<void>('save_pack_meta', { pack, meta })

/** 新建空技能包（用户自建） */
export const createSkillPack = (id: string, title: string) =>
  invoke<string>('create_skill_pack', { id, title })

/** 删除技能包（整包） */
export const deleteSkillPack = (pack: string) => invoke<void>('delete_skill_pack', { pack })

/** 删除文件或目录 */
export const deletePath = (path: string) => invoke<void>('delete_path', { path })

/** 某版本的配套真实数据（提示词正文 + 技能包），随版本切换加载 */
export interface VersionBundleDto {
  versionId: string
  promptFile: string
  promptPath: string | null
  promptText: string
  promptSize: number
  packs: SkillPackDto[]
  allPrompts: PromptItemDto[]
}

export const versionBundle = (client: unknown, version: unknown) =>
  invoke<VersionBundleDto>('version_bundle', { client, version })

/** 手动添加技能的结果 */
export interface ImportSkillResultDto {
  ok: boolean
  name: string
  target: string
  backup: string | null
  title: string
  description: string
  valid: boolean
  files: number
}

/** 把用户自备的技能目录复制进某个技能库（手动添加额外技能） */
export const importSkillDir = (srcDir: string, packId: string) =>
  invoke<ImportSkillResultDto>('import_skill_dir', { srcDir, packId })

// ---------- 技能导入（原生多选 + 自动解压 + 自动识别） ----------

export interface ImportedSkillDto {
  name: string
  target: string
  title: string
  description: string
  valid: boolean
  files: number
  backup: string | null
  /** 来源（原目录名或 zip 名），便于用户核对 */
  source: string
}

export interface ImportManyResultDto {
  cancelled: boolean
  imported: ImportedSkillDto[]
  /** 跳过/失败的原因（不阻断其它项） */
  skipped: string[]
  tempCleaned: boolean
}

/**
 * 打开系统「资源管理器」选择导入来源。
 * kind='dir' 选文件夹（可多选）；kind='zip' 选压缩包（可多选）。
 * 两者必须分开弹：Windows 的文件夹选择器不能选中文件，反之亦然。
 */
export const pickImportSources = (kind: 'dir' | 'zip' | 'file') =>
  invoke<string[]>('pick_import_sources', { kind })

/** 把选中的文件夹/压缩包里的技能全部导入指定技能包 */
export const importSkillMulti = (srcPaths: string[], packId: string) =>
  invoke<ImportManyResultDto>('import_skill_multi', { srcPaths, packId })

/**
 * 把用户自备的提示词文件/文件夹收进 _assets/prompts。
 * kind 由 pickImportSources 决定：'file' 选 .md 多选，'dir' 选文件夹多选（递归收 .md）。
 * 同名文件先备份为 .bak-<ts>，绝不静默覆盖。
 */
export const importPromptMulti = (srcPaths: string[]) =>
  invoke<ImportManyResultDto>('import_prompt_multi', { srcPaths })

// ---------- 便携箱（.codex）提示词选择注入 + 技能库批量导入 ----------
//
// 便携箱 = 包内 .codex 运行体（CODEX_HOME）。它的提示词生效由
// config.toml 的 model_instructions_file 决定（单值），技能生效目录是 .codex/skills。

/** 便携箱提示词目录里的一个 .md */
export interface CodexPromptOptionDto {
  name: string
  path: string
  size: number
  /** 当前被 model_instructions_file 指向 */
  active: boolean
}

/** 列出便携箱提示词（.codex/prompts），供「选择 + 注入」 */
export const listCodexPrompts = () =>
  invoke<CodexPromptOptionDto[]>('list_codex_prompts')

/** 注入：让选中的提示词成为唯一生效的一份（改写 config.toml） */
export const injectCodexPrompt = (name: string) =>
  invoke<string>('inject_codex_prompt', { name })

/** 便携箱技能（导入结果与列举共用） */
export interface CodexSkillDto {
  name: string
  target: string
  title: string
  description: string
  valid: boolean
  files: number
  backup: string | null
}

export interface CodexSkillImportReportDto {
  imported: CodexSkillDto[]
  skipped: string[]
}

/** 便携箱技能批量导入：文件夹多选（系统对话框）→ 递归找 SKILL.md → 复制进 .codex/skills */
export const importSkillsToCodex = (srcPaths: string[]) =>
  invoke<CodexSkillImportReportDto>('import_skills_to_codex', { srcPaths })

/** 列出便携箱已装技能（.codex/skills，只含含 SKILL.md 的真技能） */
export const listCodexSkills = () => invoke<CodexSkillDto[]>('list_codex_skills')

/** 便携箱有效技能数（与列表同口径：有 SKILL.md 的目录；体检行用它对齐数字） */
export const countCodexSkills = () => invoke<number>('count_codex_skills')

/** 便携箱技能库根目录绝对路径（「打开目录」用） */
export const codexSkillsRoot = () => invoke<string>('codex_skills_root')

/** 从便携箱移除一个技能（只删 .codex/skills 里的副本） */
export const removeCodexSkill = (name: string) =>
  invoke<void>('remove_codex_skill', { name })

// ---------- 自定义版本（用户自选 文件夹 → 文件夹 注入） ----------

export interface CustomTargetDto {
  /** 目标文件或文件夹路径（用户指定，如某软件配置目录） */
  path: string
  /** file = 写单个文件（提示词）；dir = 目录（复制技能进去） */
  kind: 'file' | 'dir'
  /** file 模式下的文件名 */
  fileName?: string | null
  /** dir 模式下的源目录 */
  sourceDir?: string | null
}

export interface CustomVersionDto {
  id: string
  label: string
  desc: string
  /** 提示词文件绝对路径（空 = 不注入提示词） */
  promptPath?: string | null
  /** 要注入的技能目录（源绝对路径） */
  skillDirs: string[]
  /** 自定义注入目标 */
  targets: CustomTargetDto[]
}

export interface BrowseEntryDto {
  name: string
  path: string
  isDir: boolean
}

export const customVersionsList = () => invoke<CustomVersionDto[]>('custom_versions_list')
export const customVersionSave = (version: CustomVersionDto) =>
  invoke<CustomVersionDto>('custom_version_save', { version })
export const customVersionDelete = (id: string) => invoke<void>('custom_version_delete', { id })
export const customVersionInstall = (version: CustomVersionDto) =>
  invoke<InstallReportDto>('custom_version_install', { version })
/** 浏览目录（path 为空 = 列盘符） */
export const browseDir = (path?: string | null) =>
  invoke<BrowseEntryDto[]>('browse_dir', { path: path ?? null })

// ---------- 版本清单（manifest 驱动） ----------

export interface ManifestTargetDto {
  path: string
  mode: string
  beginKey?: string | null
  beginPayload?: string | null
  endKey?: string | null
  marker?: string | null
  frontmatter?: string | null
  backupSuffix?: string | null
  fixedBackup?: string | null
  stampTag?: string | null
  fileName?: string | null
  sourceDir?: string | null
}

export interface ProfileEntryDto {
  id: string
  client: string
  label: string
  desc: string
  recommended: boolean
  /** manifest 所在目录 */
  dir: string
  /** 提示词组是否**全部**可解析（有任何一份缺失即 false） */
  promptOk: boolean
  /** 默认选中那份的标识 */
  promptFile: string
  /** 默认选中第几份（第一份能解析到的；都没有则 0） */
  defaultPromptIndex: number
  /** 每份提示词各自的存在性 —— 界面按选中那份显示，不要用整组状态顶替 */
  promptItems: PromptStatusDto[]
  skillsOk: boolean
  skillsDir: string | null
  skillCount: number
  targets: number
  custom: boolean
  choices: { name: string; desc: string; file: string; skillPack?: string | null }[]
  /** 提示词组（注入时多选一） */
  prompts: { name: string; asset?: string | null; file?: string | null; path?: string | null }[]
  /** 技能组（可多选安装） */
  skillPacks: string[]
}

/** 单份提示词的解析状态 */
export interface PromptStatusDto {
  name: string
  /** asset/file/path 里第一个非空值（界面上显示的标识） */
  key: string
  /** 这份提示词的真实文件是否存在 */
  ok: boolean
  /** 解析到的绝对路径（存在时才有） */
  resolved: string | null
}

/** 扫描 profiles/ 列出全部版本 */
export const profilesList = () => invoke<ProfileEntryDto[]>('profiles_list')

/** 读某版本的 manifest */
export const profileGet = (id: string) =>
  invoke<{ manifest: Record<string, unknown>; dir: string }>('profile_get', { id })

/** 保存 manifest（新建或修改） */
export const profileSave = (manifest: Record<string, unknown>, dirName?: string | null) =>
  invoke<string>('profile_save', { manifest, dirName: dirName ?? null })

/** 删除版本；removeDir 同时删版本目录（内置版本引用 _assets，删目录不影响素材） */
export const profileDelete = (id: string, removeDir = false) =>
  invoke<void>('profile_delete', { id, removeDir })

/** 按清单执行安装
 *
 *  参数名必须与 Rust 侧 `profile_install` 的形参一一对应（Tauri v2 按 camelCase 匹配）：
 *    promptIndex       ↔ prompt_index
 *    choiceFile        ↔ choice_file
 *    withSkills        ↔ with_skills
 *    skillFilter       ↔ skill_filter
 *    skillPacksOverride↔ skill_packs_override
 *    skillSourceMap    ↔ skill_source_map
 *  名字对不上不会报错，只会静默变成 None —— 之前 promptIndex 就因此一直是 None，
 *  导致「不管选哪份提示词都注入第一份」。
 *
 *  skillPacksOverride：技能库的最终勾选结果（null = 用预设声明的技能组）
 *  skillSourceMap：重名技能的来源选择（技能名 → 只从这个包取） */
export const profileInstall = (
  id: string,
  choiceFile?: string | null,
  promptIndex?: number | null,
  withSkills = true,
  skillFilter?: string[] | null,
  skillPacksOverride?: string[] | null,
  skillSourceMap?: Record<string, string> | null,
) =>
  invoke<InstallReportDto>('profile_install', {
    id,
    choiceFile: choiceFile ?? null,
    promptIndex: promptIndex ?? null,
    withSkills,
    skillFilter: skillFilter ?? null,
    skillPacksOverride: skillPacksOverride ?? null,
    skillSourceMap: skillSourceMap ?? null,
  })

/** 打开系统对话框单选一个文件夹（技能注入位置用）
 *  startDir：初始目录（客户端工作路径），避免用户从 C 盘翻起 */
export const pickOneFolder = (title?: string, startDir?: string) =>
  invoke<string | null>('pick_one_folder', {
    title: title ?? null,
    startDir: startDir ?? null,
  })

/**
 * 打开系统对话框单选一个文件（提示词注入位置用）。
 * 提示词落点是文件（AGENTS.md 等），不能复用选文件夹的对话框。
 */
export const pickOneFile = (title?: string, defaultName?: string, startDir?: string) =>
  invoke<string | null>('pick_one_file', {
    title: title ?? null,
    defaultName: defaultName ?? null,
    startDir: startDir ?? null,
  })

/** 客户端目录（profiles/<id>/）及其工作路径 */
export interface ClientEntryDto {
  id: string
  label: string
  /** 客户端工作路径（展开后的绝对路径），未知则为空 */
  workDir: string
  profileCount: number
  /** 是否已注入（读该客户端的安装状态文件） */
  injected: boolean
  /** 已注入的预设组名（未注入则 null） */
  installedLabel: string | null
}

/** 列出所有客户端目录 + 反推出的工作路径（按用户自定义顺序） */
export const clientsList = () => invoke<ClientEntryDto[]>('clients_list')

/** 保存侧栏拖动排序后的客户端顺序 */
export const clientsOrderSave = (order: string[]) =>
  invoke<void>('clients_order_save', { order })

/** 新建客户端目录 profiles/<id>/（含一个默认预设组） */
export const clientCreate = (id: string, workDir?: string | null) =>
  invoke<string>('client_create', { id, workDir: workDir ?? null })

/** 删除客户端目录（连同其下预设组） */
export const clientDelete = (id: string) => invoke<void>('client_delete', { id })

/** 修改客户端工作路径：批量改写该客户端全部 manifest 的注入点/技能落点，返回改写的 manifest 数 */
export const clientSetWorkdir = (id: string, newDir: string, oldDir: string) =>
  invoke<number>('client_set_workdir', { id, newDir, oldDir })

/** 客户端配置文件（profiles/<客户端>/<客户端>.json）—— 工作路径的权威记录 */
export interface ClientConfigDto {
  id: string
  label: string
  workDir: string
  notes: string
}

/** 读客户端配置（不存在则按 manifest 反推一份返回，不落盘） */
export const clientConfigGet = (id: string) => invoke<ClientConfigDto>('client_config_get', { id })

/** 保存客户端配置；工作路径变化时自动同步该客户端全部预设组的落点，返回改写的 manifest 数 */
export const clientConfigSave = (config: ClientConfigDto) =>
  invoke<number>('client_config_save', { config })

/** 打开版本目录 */
export const profileOpenDir = (id: string) => invoke<string>('profile_open_dir', { id })

/** 在版本目录内写资源文件（自定义版本自制提示词） */
export const profileWriteAsset = (id: string, rel: string, content: string) =>
  invoke<string>('profile_write_asset', { id, rel, content })

/** 把源目录/文件复制进版本目录（自定义版本导入技能） */
export const profileImport = (id: string, src: string, relDest: string) =>
  invoke<string>('profile_import', { id, src, relDest })

/** 运行时日志/状态事件订阅 */
export const onRuntimeLog = (cb: (text: string, kind: string) => void) =>
  onEvent<[string, string]>('runtime:log', ([text, kind]) => cb(text, kind))
export const onRuntimeStatus = (cb: (status: string) => void) =>
  onEvent<string>('runtime:status', cb)

// ---------- Agent 助手会话（05 会话页） ----------
//
// 每个会话独立于便携箱注入：自带 prompt.md（= model_instructions_file）
// 与唯一一个 skill；模型/供应商取自包内 .codex/config.toml。

export interface AgentSessionDto {
  name: string
  dir: string
  promptPath: string
  /** 本会话挂载的技能 frontmatter name（未挂载为 null） */
  skillName: string | null
  skillPath: string | null
  /** codex rollout uuid（首轮后写入） */
  sessionId: string | null
  messageCount: number
  updatedAt: number
}

/** 列出全部 Agent 会话 */
export const agentList = () => invoke<AgentSessionDto[]>('agent_list')

/** 新建会话（写 prompt.md 模板 + 内置技能 + 空 messages.json） */
export const agentCreate = (name: string) => invoke<AgentSessionDto>('agent_create', { name })

/** 跑一轮对话：首轮 codex exec，之后 codex exec resume <sessionId>；images 为本地图片路径 */
export const agentLaunch = (name: string, userText: string, images?: string[]) =>
  invoke<LaunchResultDto>('agent_launch', { name, userText, images: images ?? [] })

/** 保存一张上传图片（base64），返回落盘路径（codex 用 -i 读它） */
export const agentSaveImage = (name: string, dataBase64: string, ext: string) =>
  invoke<string>('agent_save_image', { name, dataBase64, ext })

/**
 * 一轮对话的助手回复（后端从 codex stdout 的 `codex` / `tokens used` 之间截取）。
 *
 * 不走日志流：日志里混着 banner、警告、进度，前端没法可靠还原正文。
 */
export const onAgentReply = (cb: (session: string, text: string) => void) =>
  onEvent<[string, string]>('agent:reply', ([session, text]) => cb(session, text))

/**
 * 一轮结束（codex 进程 stdout 关闭）。
 *
 * 成功、报错、模型不可达都会发 —— 前端据此解除「运行中」状态，
 * 不必依赖回复内容里出现什么字样。
 */
export const onAgentDone = (cb: (session: string) => void) =>
  onEvent<string>('agent:done', cb)

/** 某会话开始跑一轮（含 pid）—— 切页回来据此恢复「运行中」 */
export const onAgentRunning = (cb: (session: string, pid: number) => void) =>
  onEvent<[string, number]>('agent:running', ([session, pid]) => cb(session, pid))

/** 本轮过程（思考 / 命令 / 工具调用）实时推送 */
export const onAgentStep = (cb: (session: string, step: string) => void) =>
  onEvent<[string, string]>('agent:step', ([session, step]) => cb(session, step))

/** 停止某会话的进程（只杀这一个会话的树，不动 Alice-codex 页的实例） */
export const agentStop = (name: string) => invoke<LaunchResultDto>('agent_stop', { name })

/** 某会话是否在跑（切页回来恢复状态用） */
export const agentStatus = (name: string) => invoke<LaunchResultDto>('agent_status', { name })

/**
 * 手动刷新该会话的技能快照（把最新体检项与配置喂给 agent）。
 *
 * agent 在只读沙箱里读不到文件，所以配置信息全靠宿主注入的快照；
 * 用户改了配置后点这个按钮，下一次发言 agent 就能看到新值。
 */
export const agentRefreshSnapshot = (name: string) =>
  invoke<void>('agent_refresh_snapshot', { name })

/** 读进行中过程（切页回来补显示：agent 正在跑但界面刚挂载时用） */
export const agentLiveSteps = (name: string) => invoke<string[]>('agent_live_steps', { name })

/** 一条已写入留档（宿主落盘后留的记录） */
export interface AppliedWriteDto {
  id: string
  path: string
  content: string
  reason: string
}

/** 列出已写入留档 */
export const agentAppliedWrites = (name: string) =>
  invoke<AppliedWriteDto[]>('agent_applied_writes', { name })

/** 把一条已写入记录移出列表（不还原文件） */
export const agentDismissWrite = (name: string, id: string) =>
  invoke<void>('agent_dismiss_write', { name, id })

/** 宿主刚写入文件 */
export const onAgentWrite = (cb: (session: string, id: string) => void) =>
  onEvent<[string, string]>('agent:proposal', ([session, id]) => cb(session, id))
