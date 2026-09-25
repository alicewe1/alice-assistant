// 后端 API 类型契约（阶段二由 Tauri commands 实现，字段即契约）
// 语义对齐原版 Alice：目标=被注入的 AI 客户端，版本=提示词包，技能=skill 目录
export type Theme = 'light' | 'dark'

/** 可注入的客户端类型（对齐原版 6 目标 + 自定义） */
export type ClientKind = 'codex' | 'zcode' | 'cursor' | 'claude' | 'workbuddy' | 'dsh' | 'custom'

/** 破甲目标 = 一个 AI 客户端 */
export interface TargetProfile {
  id: string
  kind: ClientKind
  name: string
  /** 注入位置说明，如 ~/.codex/AGENTS.md */
  injectPath: string
  desc: string
  /** 已安装的版本 id（原版"已安装"徽标） */
  installedVersionId: string | null
  createdAt: number
  updatedAt: number
}

/** 提示词包版本选项（顶尖破甲 V5 的 六/5.6 双选择） */
export interface VersionChoice {
  name: string
  desc: string
  file: string
}

/** 版本 = 提示词包 */
export interface TargetVersion {
  id: string
  targetId: string
  label: string
  desc: string
  /** 提示词文件名（对应 resources/*.md 或内置 kit） */
  file: string
  /** 二级选择（如 V5 的 六 / 5.6） */
  choices: VersionChoice[]
  recommended: boolean
  /** 该版本独立挂载的技能包 */
  skillIds: string[]
  createdAt: number
  updatedAt: number
}

/** 技能包 = .codex/skills 下的一个目录 */
export interface SkillPackage {
  id: string
  name: string
  /** 关联版本（独立技能管理），空 = 通用 */
  versionIds: string[]
  dir: string
  /** 模块数（对齐原版 63/150/166 模块计数） */
  modules: number
  enabled: boolean
  description: string
  updatedAt: number
}

/** 提示词模板文件（resources/*.md 的可编辑形态） */
export interface PromptTemplate {
  id: string
  name: string
  file: string
  versionIds: string[]
  content: string
  updatedAt: number
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: number
}

export interface RunSession {
  id: string
  targetId: string
  versionId: string
  status: 'idle' | 'running' | 'done' | 'error'
  messages: SessionMessage[]
  startedAt: number
  endedAt: number | null
}

// ---------- 运行时（王炸codex） ----------

/** 原 x1 的 7 项路径体检 */
export type RuntimeCheckKey =
  | 'codexHome'
  | 'codexExe'
  | 'desktopExe'
  | 'skills'
  | 'prompts'

export interface RuntimeState {
  ready: boolean
  running: boolean
  pid: number | null
  /** 运行体实例数（CLI + 桌面端可同时存在） */
  procCount?: number
  /** 包内残留进程 PID（停止后应为空；非空说明有孤儿） */
  strayPids?: number[]
  /**
   * 当前实例的随机镜像名（如 `wz7f3a91c2`）。
   *
   * 启动时每次重新生成 + 建硬链接，进程在任务管理器里就显示这个名字，
   * 按 `codex.exe` / `alice` 扫进程的清理工具认不出来。
   */
  aliasName?: string
  /**
   * 独占终止保护（已移除，恒为 false）。
   *
   * 字段保留只为兼容后端 LaunchResult.protected —— 后端现在恒回 false，
   * 界面不再有任何地方展示「保护中」。
   */
  guarded?: boolean
  checks: Record<RuntimeCheckKey, boolean>
  counts: { skills: number; prompts: number }
  runtimeMB: number
  hasKey: boolean
  root: string
  /** 提示词库来源（体检项可切换查看） */
  promptSources: PromptSourceInfo[]
  /** 包内 config.toml 当前使用的 provider 名（如 custom） */
  configProvider: string
  /** 本机 ~/.codex/config.toml 是否存在（决定「透传」按钮可用性） */
  hostConfigExists: boolean
  hostConfigPath: string
}

/** 提示词库来源（与后端 PromptSource 对应） */
export interface PromptSourceInfo {
  rel: string
  label: string
  path: string
  count: number
  active: boolean
}

export interface LogLine {
  ts: number
  text: string
  kind: 'info' | 'ok' | 'warn' | 'err'
}

// ---------- 云过审 ----------

export interface CloudUpstream {
  id: string
  /** 客户端名，如 codex / zcode */
  client: string
  /** 原始 base_url */
  originalUrl: string
  /** 当前是否已接入（base_url 已指向本地服务端） */
  attached: boolean
}

export interface CloudState {
  running: boolean
  listenHost: string
  listenPort: number
  upstreams: CloudUpstream[]
  /** 中转站自检结论 */
  lastTest: { ok: boolean; endpoint: string; model: string; ts: number } | null
  logs: LogLine[]
}

