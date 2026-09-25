// 注入逻辑的类型契约（前端 ↔ Rust 共享）
//
// Rust 侧对应 src-tauri/src/inject.rs 的同名字段（camelCase ↔ snake_case 由 serde 转换）

/** 写入语义（按客户端差异区分，不能统一） */
export type WriteMode =
  /** 标记块替换：块存在则只换块内，否则追加（Codex / DSH） */
  | 'markedBlock'
  /** Claude 四分支：有块→换块内；空/纯提示词→整份；残渣→挪走留证；用户内容→首次备份+追加 */
  | 'claudeBlock'
  /** 整份覆盖（Cursor .mdc / ZCode AGENTS.md / WorkBuddy 记忆档案） */
  | 'overwrite'

export interface InjectTarget {
  /** 路径模板，支持 ~ 与 {{HOME}} */
  path: string
  mode: WriteMode
  /**
   * 块开始**关键串**（稳定，用于定位）。
   * 写入时包成 `<!-- <key><payload> -->`。
   * 用关键串而非完整标记匹配，是为了兼容旧版写的可变载荷
   *（`BEGIN` / `BEGIN prompt=x.md` / `BEGIN pack=dsh-lazy-pack-v5`）。
   */
  beginKey?: string
  /** 追加在 key 之后、`-->` 之前的载荷 */
  beginPayload?: string
  endKey?: string
  /** Cursor 的 .mdc 需要 YAML frontmatter */
  frontmatter?: string
  /** overwrite 模式用于识别是否已注入的标记串 */
  marker?: string
  /** 固定备份后缀（.bak-inject / .bak） */
  backupSuffix?: string
  /** 固定备份的完整路径（Claude / DSH 放在 managed-prompts 下） */
  fixedBackup?: string
  /** 时间戳备份标签（backup / inject） */
  stampTag?: string
}

export interface SkillSync {
  dest: string
}

export interface ChoiceSpec {
  name: string
  desc: string
  file: string
}

export interface VersionSpec {
  id: string
  label: string
  desc: string
  /** 默认提示词文件 */
  file: string
  /** 二级选择（如 V5 的六 / 5.6） */
  choices: ChoiceSpec[]
  recommended: boolean
  /** 该版本同步的技能包（_assets 下的目录名） */
  skillPacks: string[]
  /** 懒人包附带文件（shield-protocol.md 等） */
  extraFiles?: string[]
}

export interface ClientSpec {
  /** 与 TargetProfile.id 对应 */
  id: string
  name: string
  /** 旧版脚本文件名（留档核对） */
  legacyScript: string
  versions: VersionSpec[]
  injectTargets: InjectTarget[]
  skillSync: SkillSync[]
  /** 技能清单文件（WorkBuddy 用，记录 sha256） */
  skillManifest?: string
  /** 模块库同步目标 */
  moduleSync?: string
  /** 该客户端支持的附加文件（懒人包 shield-protocol.md 等） */
  extraFiles?: string[]
}

/** 单个注入目标的当前状态 */
export interface TargetStatus {
  path: string
  exists: boolean
  injected: boolean
  blockLen: number
  fileLen: number
  backup: string | null
}

/** 安装/卸载报告 */
export interface InstallReport {
  ok: boolean
  steps: string[]
  skillsInstalled: string[]
  skillsSkipped: number
  error: string | null
}
