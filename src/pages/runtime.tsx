import {
  CheckCircle2,
  CircleDashed,
  Download,
  FilePenLine,
  FolderOpen,
  FolderPlus,
  Play,
  Plus,
  RefreshCw,
  Save,
  Shuffle,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { Topbar } from '@/components/topbar'
import { Modal, useConfirm } from '@/components/modal'
import * as be from '@/lib/tauri'
import type { CodexPromptOptionDto, CodexSkillDto } from '@/lib/tauri'
import type { LogLine, RuntimeCheckKey } from '@/types/domain'

/**
 * Alice-codex（原「王炸codex」）
 *
 * 这一页管的是**包内那一套便携运行体**：codex 运行时、桌面端、技能库、
 * 提示词库、MCP 依赖。所有路径都从包根推导，拷到别的机器照常可用。
 */

/** 体检项：key 与后端 engine_probe 的 checks[].key 一一对应。
 *  「MCP 依赖库」「内置工具（adb）」已从体检移除：两者是可选附件，
 *  缺失不代表运行体不可用，列进来只会把 7/7 变 5/7 造成误报。 */
const CHECK_LABELS: [RuntimeCheckKey, string][] = [
  ['codexHome', '配置文件 config.toml'],
  ['codexExe', 'codex 运行时'],
  ['desktopExe', '桌面端完整性'],
  ['skills', 'Alice 技能库'],
  ['prompts', '提示词库'],
]

/**
 * 体检行的状态勾。
 *
 * 抽成一个组件是为了让每行的「勾」落在同一个像素位置：以前有的行
 * 是 `<span flex:1>` 加勾、有的行是 `row gap` 里跟按钮混排，勾的
 * 水平位置随前方内容宽度漂移，一排看下来是锯齿状。
 */
function CheckCircle2OrDashed({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 size={15} className="text-ok" />
  ) : (
    <CircleDashed size={15} className="text-faint" />
  )
}

export function Runtime() {
  const {
    runtime,
    logs,
    pushLog,
    syncConfigFromHost,
    refreshProbe,
    probeEngine,
    probing,
    launchCodex,
    stopCodex,
    rotateAlias,
    syncRuntime,
    openFolder,
    backendLive,
  } = useStore()
  const { toast } = useApp()
  const { confirm, confirmNode } = useConfirm()
  const [busy, setBusy] = useState(false)
  // 便携箱提示词/技能数据（见 refreshCodex）

  // ---------- 便携箱提示词选择注入 ----------
  const [codexPrompts, setCodexPrompts] = useState<CodexPromptOptionDto[]>([])
  /** 下拉选中的文件名（与「生效中」是两回事：选了但还没点注入） */
  const [pickedPrompt, setPickedPrompt] = useState('')
  const [activePrompt, setActivePrompt] = useState('')

  // ---------- 便携箱技能库 ----------
  const [codexSkills, setCodexSkills] = useState<CodexSkillDto[]>([])
  /** 技能库根目录（「打开目录」用；不能用第一个技能的 target —— 那是子目录） */
  const [skillsRoot, setSkillsRoot] = useState('')
  /** 便携箱提示词目录 .codex/prompts（「目录」按钮打开用；不存在时后端会先创建） */
  const [promptsDir, setPromptsDir] = useState('')
  const [importingSkills, setImportingSkills] = useState(false)
  const [skillReport, setSkillReport] = useState<be.CodexSkillImportReportDto | null>(null)

  // ---------- 包内 config.toml 编辑器 ----------
  /**
   * 拖动编辑器：直接读写 <包根>\.codex\config.toml。
   *
   * 为什么给这个入口：config.toml 是模型/供应商/提示词指向的唯一落点，
   * 用户改 model_provider、base_url、model 名都得进文件 —— 以前只能靠
   * 「透传本机」整体搬字段，或去资源管理器里手动翻目录。
   * 保存走 save_file_text（自动备份 .bak-edit-*），保存后重跑探针让
   * provider 徽标立刻反映新值。
   */
  const [cfgEdit, setCfgEdit] = useState<{ text: string; dirty: boolean } | null>(null)
  const [cfgSaving, setCfgSaving] = useState(false)

  /** 包内配置绝对路径（包根未知时不拼半个路径） */
  const configPath = runtime.root ? `${runtime.root}\\.codex\\config.toml` : ''

  const openConfigEditor = async () => {
    if (!be.IS_TAURI) {
      toast('浏览器预览无法读磁盘', 'warn')
      return
    }
    if (!configPath) {
      toast('包根还没读到，先点一次「重新自检」', 'warn')
      return
    }
    try {
      const t = await be.readFileText(configPath)
      setCfgEdit({ text: t, dirty: false })
    } catch (e) {
      toast(`读取 config.toml 失败：${String(e)}`, 'bad')
    }
  }

  const saveConfigEditor = async () => {
    if (!cfgEdit || !configPath) return
    setCfgSaving(true)
    try {
      await be.saveFileText(configPath, cfgEdit.text)
      setCfgEdit({ text: cfgEdit.text, dirty: false })
      toast('config.toml 已保存（原文件备份 .bak-edit-*）', 'ok')
      pushLog('[codex] config.toml 已保存，重启 codex 生效', 'ok')
      // provider / 字段名可能变了 —— 重跑探针让体检行的徽标跟着更新
      await refreshProbe()
      await refreshCodex()
    } catch (e) {
      toast(`保存失败：${String(e)}`, 'bad')
      pushLog(`[codex] config.toml 保存失败：${String(e)}`, 'err')
    } finally {
      setCfgSaving(false)
    }
  }

  const closeConfigEditor = () => {
    if (!cfgEdit) return
    if (cfgEdit.dirty) {
      confirm('config.toml 有未保存的修改，放弃并关闭？', () => setCfgEdit(null))
      return
    }
    setCfgEdit(null)
  }

  /** 拉取便携箱提示词 + 技能列表（进页面与每次操作后） */
  const refreshCodex = useCallback(async () => {
    if (!be.IS_TAURI) return
    try {
      const [ps, ss, root] = await Promise.all([
        be.listCodexPrompts(),
        be.listCodexSkills(),
        be.codexSkillsRoot(),
      ])
      setCodexPrompts(ps)
      setCodexSkills(ss)
      setSkillsRoot(root)
      // prompts 目录 = skills 根的兄弟目录（.codex/prompts）
      setPromptsDir(root.replace(/\\skills$/, '\\prompts').replace(/\/skills$/, '/prompts'))
      const act = ps.find((p) => p.active)
      setActivePrompt(act?.name ?? '')
      // 默认选中当前生效的那一份；没有则选第一份
      setPickedPrompt((cur) => cur || act?.name || ps[0]?.name || '')
    } catch (e) {
      pushLog(`[codex] 便携箱数据读取失败：${String(e)}`, 'err')
    }
  }, [pushLog])

  useEffect(() => {
    void refreshCodex()
  }, [refreshCodex])

  useEffect(() => {
    document.title = 'ALICE · Alice-codex'
  }, [])

  // 后端忙碌状态 = 本地 busy 或 store 的 probing
  const anyBusy = busy || probing

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const launchCli = () => withBusy(() => launchCodex('cli'))
  const launchDesktop = () => withBusy(() => launchCodex('desktop'))
  const stop = () => withBusy(() => stopCodex())
  // 强制清理：即使后端认为「没有运行中的实例」，也让它做一次包内归属清扫，
  // 收拾旧版/崩溃遗留的孤儿进程 —— 这就是「exe 在跑但停不掉」的兜底出口。
  const forceStop = () => withBusy(() => stopCodex(true))
  /*
   * 恢复出厂清理：清空会话/记忆/日志等运行数据（含 2.1GB 的 data/ 缓存），
   * 只保留 skills/、prompts/ 与关键配置。
   *
   * 双重确认：先弹确认框说明后果，用户点「确认清理」后再执行 ——
   * 后端还有一道 confirm_token 校验（防误触/防脚本误调用），两层缺一不可。
   * 执行完强制刷新体检，让「包根体积」徽标立刻反映清理效果。
   */
  const factoryReset = () => {
    confirm(
      '⚠ 将清空 codex 便携箱内的全部运行数据：会话记录、记忆、历史、日志与队列数据库、临时目录，并自动停止运行中的实例。\n\n仅保留：技能库（skills）、提示词（prompts）与关键配置（config.toml、auth.json、api_key.txt、AGENTS.md）。\n\n此操作不可恢复，确定继续？',
      () =>
        withBusy(async () => {
          try {
            const msg = await be.codexFactoryReset()
            toast(msg, 'ok')
            pushLog(`[codex] ${msg}`, 'warn')
            await refreshProbe()
            await refreshCodex()
          } catch (e) {
            toast(`清理失败：${String(e)}`, 'bad')
            pushLog(`[codex] 恢复出厂清理失败：${String(e)}`, 'err')
          }
        }),
    )
  }

  /*
   * 便携箱导入：包内没有 .codex 时的恢复入口。
   * 系统对话框选一个本机 codex 目录（必须含 config.toml）→
   * 后端整目录复制进包内 .codex（已有则拒绝）→ 刷新自检。
   */
  const importPortable = () => {
    if (!be.IS_TAURI) {
      toast('浏览器预览无法打开系统对话框', 'warn')
      return
    }
    withBusy(async () => {
      try {
        const picked = await be.pickImportSources('dir')
        if (!picked.length) return
        const msg = await be.codexImportPortable(picked[0])
        toast(msg, 'ok')
        pushLog(`[codex] ${msg}`, 'ok')
        await refreshProbe()
        await refreshCodex()
      } catch (e) {
        toast(`导入失败：${String(e)}`, 'bad')
        pushLog(`[codex] 便携箱导入失败：${String(e)}`, 'err')
      }
    })
  }
  // 换随机名重启：怀疑进程名已经被盯上时，一键换个新名字继续跑
  const rotate = () => withBusy(() => rotateAlias('cli'))
  const probe = () => withBusy(() => refreshProbe())

  /**
   * 便携箱提示词注入：把下拉选中的那一份写成唯一生效（改写 config.toml）。
   * 成功后重启中的 codex 需要重启才会读到新提示词 —— 界面上给出提示。
   */
  const injectPrompt = async () => {
    if (!pickedPrompt) {
      toast('先在下面选一份提示词', 'warn')
      return
    }
    if (pickedPrompt === activePrompt) {
      toast('这一份已经是当前生效的提示词', 'warn')
      return
    }
    await withBusy(async () => {
      try {
        const raw = await be.injectCodexPrompt(pickedPrompt)
        toast(`已注入：${raw}`, 'ok')
        pushLog(`[codex] 提示词已注入 → ${raw}（重启 codex 生效）`, 'ok')
        await refreshCodex()
      } catch (e) {
        toast(`注入失败：${String(e)}`, 'bad')
        pushLog(`[codex] 提示词注入失败：${String(e)}`, 'err')
      }
    })
  }

  /**
   * 便携箱技能导入（纯复制语义，v3）：选中的每个文件夹按原样整目录
   * 复制进 .codex/skills/<文件夹名>。不识别、不收集、不拆包、无结果弹窗。
   */
  const addCodexSkills = async () => {
    if (!be.IS_TAURI) {
      toast('浏览器预览无法打开系统对话框', 'warn')
      return
    }
    setImportingSkills(true)
    try {
      const paths = await be.pickImportSources('dir')
      if (!paths.length) {
        setImportingSkills(false)
        return
      }
      const r = await be.importSkillsToCodex(paths)
      if (r.imported.length) {
        toast(`已按原样复制 ${r.imported.length} 个文件夹到便携箱 skills`, 'ok')
        pushLog(`[codex] 便携箱技能导入 ${r.imported.length} 个文件夹（原样复制）`, 'ok')
      } else if (r.skipped.length) {
        toast(`导入失败：${r.skipped[0]}`, 'bad')
      }
      await refreshCodex()
    } catch (e) {
      toast(`导入失败：${String(e)}`, 'bad')
    } finally {
      setImportingSkills(false)
    }
  }

  /**
   * 便携箱提示词导入：系统对话框选 .md（可多选）→ 复制进 .codex/prompts。
   * 与技能导入同款交互；导入后刷新列表并自动选中第一份新提示词。
   */
  const addCodexPrompts = async () => {
    if (!be.IS_TAURI) {
      toast('浏览器预览无法打开系统对话框', 'warn')
      return
    }
    try {
      const files = await be.pickImportSources('file')
      if (!files.length) return
      const imported = await be.importPromptsToCodex(files)
      if (imported.length) {
        toast(`已导入 ${imported.length} 份提示词到便携箱`, 'ok')
        pushLog(`[codex] 便携箱提示词导入 ${imported.length} 份`, 'ok')
      } else {
        toast('没有可导入的 .md 文件', 'warn')
      }
      await refreshCodex()
    } catch (e) {
      toast(`导入失败：${String(e)}`, 'bad')
    }
  }

  /** 从便携箱移除一个技能（只删 .codex/skills 里的副本，软件库不受影响） */
  const removeSkill = (s: CodexSkillDto) => {
    confirm(
      `从便携箱移除技能「${s.name}」？\n路径：.codex/skills/${s.name}\n源技能库不受影响，可随时重新导入。`,
      async () => {
        try {
          await be.removeCodexSkill(s.name)
          toast(`已移除 ${s.name}`, 'warn')
          pushLog(`[codex] 便携箱技能移除 ${s.name}`, 'warn')
          await refreshCodex()
        } catch (e) {
          toast(`移除失败：${String(e)}`, 'bad')
        }
      },
    )
  }

  const okCount = useMemo(() => CHECK_LABELS.filter(([k]) => runtime.checks[k]).length, [runtime])

  // 体检项「提示词库」行已改为便携箱提示词选择器（见 CHECK_LABELS 循环内）。
  // 软件库来源统计仍由后端 scan_prompt_sources 提供，用于体检计数，这里不再展开。

  return (
    <div className="page anim-page">
      <Topbar
        kicker="RUNTIME / Alice-codex"
        title="Alice-codex 运行时"
        sub="用随包分发的 codex 运行：CODEX_HOME、APPDATA、TEMP 全部重定向到包内目录，桌面端使用独立 profile，拷到别的电脑也能用。"
        actions={
          <>
            <span className={`badge ${backendLive ? 'badge-ok' : 'badge-neutral'}`}>
              {backendLive ? '后端已连接' : '浏览器预览'}
            </span>
            <span className={`badge ${runtime.ready ? (runtime.running ? 'badge-accent' : 'badge-ok') : 'badge-neutral'}`}>
              {runtime.ready
                ? runtime.running
                  ? `运行中 · ${runtime.procCount && runtime.procCount > 1 ? `${runtime.procCount} 实例 · ` : ''}PID ${runtime.pid ?? '—'}`
                  : '已就绪'
                : '未就绪'}
            </span>
            {runtime.running && runtime.aliasName && (
              <span
                className="badge badge-neutral"
                title={`进程在系统里显示为 ${runtime.aliasName}.exe（每次启动重新随机），按 codex.exe 扫进程的工具认不出来`}
              >
                <Shuffle size={11} /> 随机名 {runtime.aliasName}
              </span>
            )}
            {/* 「独占保护」徽章已删除 —— 独占终止保护功能整体移除，
                进程现在可以被外部 taskkill 正常终止（见 runtime.rs finish_launch）。 */}
            {(runtime.strayPids?.length ?? 0) > 0 && (
              <span className="badge badge-bad" title={`包内残留进程：${(runtime.strayPids ?? []).join(', ')}`}>
                残留 {runtime.strayPids!.length} 个进程
              </span>
            )}
            <button className="btn" data-tour="runtime.actions" disabled={anyBusy} onClick={probe}>
              <RefreshCw size={13} /> {probing ? '自检中…' : '一键自检'}
            </button>
          </>
        }
      />
      {/*
        两栏布局：MASK 面板瘦身后（去掉两条能力边界长段落）左栏变短，
        原来 1.15fr / 1fr 会让左栏空出一截、右栏日志区被挤矮。
        改成等宽 + 右栏日志区可伸长，两块高度更接近。
      */}
      <div className="page-body runtime-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        <div className="col gap">
          {/* ---------- 体检 ---------- */}
          <div className="glass glass-iridescent glass-pad" data-tour="runtime.checks">
            <div className="panel-head">
              <span className="kicker">CHECKS / 运行体检 {okCount}/{CHECK_LABELS.length}</span>
              <span className="badge badge-neutral">
                技能 {codexSkills.length} · 提示词 {codexPrompts.length} · {runtime.runtimeMB} MB
              </span>
            </div>
            <div>
              {/* ---------- 便携箱缺失时的导入入口 ----------
                  codexHome 检查不过 = 包内没有可用的 .codex（典型：安装包没带
                  便携箱）。这时比起一堆红叉，用户需要的是一个直接可点的恢复
                  动作：选本机 codex 目录导进来。 */}
              {runtime.root && !runtime.checks.codexHome && (
                <div
                  className="glass glass-pad"
                  style={{ marginBottom: 12, border: '1px dashed var(--line-strong, #c77)' }}
                >
                  <div className="panel-head">
                    <span className="kicker">IMPORT / 便携箱导入</span>
                  </div>
                  <div className="sub" style={{ marginBottom: 8 }}>
                    包内没有检测到 codex 便携箱（.codex）。选择一个本机现成的 codex
                    目录（如 <code>C:\Users\你\.codex</code>，须含 config.toml）导入即可继续使用。
                    导入后其中的会话/记忆等运行数据会自动清空，配置与技能保留。
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={anyBusy} onClick={importPortable}>
                    <FolderPlus size={12} /> 选择本地 codex 目录并导入
                  </button>
                </div>
              )}
              {CHECK_LABELS.map(([key, label]) => {
                const ok = runtime.checks[key]

                /* 配置文件：展示包内 provider 名 + 编辑/透传/刷新 + 状态勾 */
                if (key === 'codexHome') {
                  return (
                    <div key={key} className="list-row">
                      <div className="run-row-main">
                        <span className="run-row-label">{label}</span>
                        <span className="mono sub run-row-note">
                          provider = {runtime.configProvider || '—'}
                        </span>
                      </div>
                      <div className="run-row-acts">
                        <button
                          className="btn btn-sm"
                          data-tour="runtime.config-edit"
                          disabled={anyBusy || !runtime.root}
                          title={
                            runtime.root
                              ? `编辑包内配置：${configPath}（保存自动备份 .bak-edit-*）`
                              : '包根还没读到，先点一次「重新自检」'
                          }
                          onClick={() => void openConfigEditor()}
                        >
                          <FilePenLine size={12} /> 编辑
                        </button>
                        <button
                          className="btn btn-sm"
                          data-tour="runtime.config-host"
                          disabled={anyBusy || !runtime.hostConfigExists}
                          title={
                            runtime.hostConfigExists
                              ? `把本机 ${runtime.hostConfigPath} 的模型/供应商字段透传到包内（保留包内 MCP 段，原文件先备份）`
                              : '本机 ~/.codex/config.toml 不存在'
                          }
                          onClick={() => void withBusy(() => syncConfigFromHost())}
                        >
                          <Download size={12} /> 透传本机
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={anyBusy}
                          title="重新读取包内 config.toml 的名称与字段"
                          onClick={() => void withBusy(() => probeEngine())}
                        >
                          <RefreshCw size={12} />
                        </button>
                        <CheckCircle2OrDashed ok={ok} />
                      </div>
                    </div>
                  )
                }

                /*
                 * 提示词选择（原「提示词库」来源切换）。
                 *
                 * 为什么只列 .codex/prompts：model_instructions_file 相对
                 * CODEX_HOME 解析，指向 _assets 下的软件库是无效配置；
                 * 而且便携箱目录才是「注入后能直接生效」的位置。
                 * 交互是两步：下拉选中 → 点「注入」才写 config（避免误触）。
                 */
                if (key === 'prompts') {
                  return (
                    <div key={key} className="list-row run-row-stack">
                      <div className="run-row-main">
                        <span className="run-row-label">提示词选择</span>
                        {activePrompt ? (
                          <span
                            className="badge badge-ok"
                            title={`config.toml 的 model_instructions_file 指向 ${activePrompt}`}
                          >
                            生效中 · {activePrompt}
                          </span>
                        ) : (
                          <span className="badge badge-warn" title="config.toml 还没指向任何提示词">
                            未指向
                          </span>
                        )}
                        <span className="badge badge-neutral">{codexPrompts.length} 份</span>
                        <span className="run-row-spacer" />
                        <CheckCircle2OrDashed ok={ok} />
                      </div>
                      <div className="run-row-acts run-row-acts-stretch">
                        <select
                          className="select"
                          value={pickedPrompt}
                          onChange={(e) => setPickedPrompt(e.target.value)}
                          title="选择要注入的提示词（来自便携箱 .codex/prompts）"
                        >
                          {codexPrompts.length === 0 && <option value="">（便携箱暂无提示词）</option>}
                          {codexPrompts.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                              {p.active ? '（生效中）' : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={anyBusy || !pickedPrompt || pickedPrompt === activePrompt}
                          title={
                            !pickedPrompt
                              ? '先选一份提示词'
                              : pickedPrompt === activePrompt
                                ? '这一份已生效'
                                : `把 ${pickedPrompt} 设为唯一生效的提示词（改写 config.toml，原配置先备份）`
                          }
                          onClick={() => void injectPrompt()}
                        >
                          <Download size={12} /> 注入
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={!pickedPrompt}
                          title="在资源管理器中打开这份提示词"
                          onClick={() => {
                            const p = codexPrompts.find((x) => x.name === pickedPrompt)
                            if (p) openFolder(p.path)
                          }}
                        >
                          <FolderOpen size={12} />
                        </button>
                        {/*
                         * 导入提示词 + 打开目录（用户要求）：
                         * 便携箱导入后 .codex/prompts 是空的，之前没有任何
                         * 往里放文件的入口（提示只能去「提示词」页绕一圈）。
                         * 现在：导入（选 .md 可多选）与打开目录都就地可用，
                         * 且打开前确保目录存在 —— 不会落到 explorer 默认视图。
                         */}
                        <button
                          className="btn btn-sm"
                          disabled={anyBusy}
                          title="选择 .md 文件（可多选）复制到便携箱 .codex/prompts"
                          onClick={() => void addCodexPrompts()}
                        >
                          <Plus size={12} /> 导入提示词
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          title="打开便携箱 .codex/prompts 目录（不存在会自动创建）"
                          onClick={() => {
                            if (promptsDir) openFolder(promptsDir)
                          }}
                        >
                          <FolderOpen size={12} /> 目录
                        </button>
                      </div>
                      {codexPrompts.length === 0 && (
                        <div className="run-row-note">
                          便携箱（.codex/prompts）还没有提示词 —— 点「导入提示词」选 .md 文件，或在「提示词」页从软件库复制。
                        </div>
                      )}
                    </div>
                  )
                }

                /* 其余项：一行一个勾 */
                return (
                  <div key={key} className="list-row">
                    <div className="run-row-main">
                      <span className="run-row-label">{label}</span>
                    </div>
                    <div className="run-row-acts">
                      {/* 技能库显示数量 */}
                      {key === 'skills' && (
                        /*
                         * 与右侧 BOX 面板同口径：只数有 SKILL.md 的真技能
                         * （countCodexSkills），不再是 dir_count 的一级目录数。
                         * 实测旧口径 308 vs 列表 305，空目录把数字撑大了，
                         * 用户以为两边数据不一致。
                         */
                        <span className="badge badge-neutral">{codexSkills.length} 个</span>
                      )}
                      <CheckCircle2OrDashed ok={ok} />
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="run-root" data-tour="runtime.root">
              <span className="kicker run-root-kicker">包根</span>
              <span className="mono run-root-path" title={runtime.root}>
                {runtime.root || '未读取'}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={!runtime.root}
                title="在资源管理器中打开包根目录"
                onClick={() => openFolder(runtime.root)}
              >
                <FolderOpen size={12} /> 打开
              </button>
            </div>
            <div className="run-actions" data-tour="runtime.launch">
              <div className="run-actions-row run-actions-row-run">
                <button className="btn btn-primary" disabled={anyBusy} onClick={launchCli}>
                  <Play size={13} /> 启动 CLI
                </button>
                <button className="btn btn-primary" disabled={anyBusy} onClick={launchDesktop}>
                  <Play size={13} /> 启动桌面端
                </button>
                <button
                  className="btn"
                  disabled={anyBusy || (!runtime.running && !(runtime.strayPids?.length ?? 0))}
                  onClick={stop}
                  title="终止跟踪中的运行体实例，并清扫包内残留进程"
                >
                  <Square size={13} /> 停止
                </button>
              </div>
              <div className="run-actions-row run-actions-row-tools">
                <button
                  className="btn btn-sm"
                  disabled={anyBusy}
                  onClick={rotate}
                  title="停掉当前实例并用一个全新的随机进程名重新启动（想立刻换掉可能已被盯上的名字时用）"
                >
                  <Shuffle size={12} /> 换随机名重启
                </button>
                <button
                  className="btn btn-sm"
                  disabled={anyBusy}
                  onClick={forceStop}
                  title="即使界面显示未运行，也强制做一次包内归属清扫（收拾旧版/崩溃遗留的孤儿进程）"
                >
                  <Square size={12} /> 强制清理
                </button>
                <button
                  className="btn btn-sm"
                  disabled={anyBusy}
                  onClick={() => withBusy(() => syncRuntime())}
                  title="重新读取后端真实进程状态"
                >
                  <RefreshCw size={12} /> 刷新状态
                </button>
                <button
                  className="btn btn-sm"
                  disabled={probing}
                  onClick={probe}
                  title="重跑全部体检项（与顶栏「一键自检」同一动作）"
                >
                  <RefreshCw size={12} /> 重新自检
                </button>
                <button
                  className="btn btn-sm"
                  disabled={anyBusy}
                  onClick={factoryReset}
                  title="清空 codex 便携箱内的会话/记忆/历史/缓存（有确认弹窗）"
                >
                  <Trash2 size={12} /> 清理数据
                </button>
              </div>
            </div>
          </div>

          {/* ---------- 随机进程名 ---------- */}
          {/*
            原 MASK 面板含「独占终止保护」状态行与两条能力边界说明，已全部删除。
            为什么整块重写而不是只删两行：原文案大段围绕 DACL 上锁展开，
            删掉那部分后剩下的句子会变成没有前文的碎片（“同时对进程对象收 DACL…”
            这类从句失去主语）。所以按“只讲随机名”重写一遍。
          */}
          <div className="glass glass-iridescent glass-pad" data-tour="runtime.mask">
            <div className="panel-head">
              <span className="kicker">MASK / 随机进程名</span>
              <span className={`badge ${runtime.running && runtime.aliasName ? 'badge-ok' : 'badge-neutral'}`}>
                {runtime.running && runtime.aliasName ? '已启用' : runtime.running ? '未启用' : '未运行'}
              </span>
            </div>
            <div className="sub" style={{ marginBottom: 10 }}>
              每次启动都在运行体目录建一个随机名硬链接直接拉起，进程在系统里显示的
              就是这个名字（如 <span className="mono">wz7f3a91c2.exe</span>），
              按 <span className="mono">codex.exe</span> 扫进程的清理工具认不出来。
            </div>
            <div className="list-row">
              <span style={{ flex: 1 }}>当前随机名</span>
              <span className="mono sub" style={{ fontSize: 11 }}>
                {runtime.aliasName ? `${runtime.aliasName}.exe` : '—'}
              </span>
              {runtime.aliasName ? (
                <CheckCircle2 size={15} className="text-ok" />
              ) : (
                <CircleDashed size={15} className="text-faint" />
              )}
            </div>
            <div className="sub" style={{ marginTop: 8, fontSize: 11, opacity: 0.75 }}>
              进程可被外部 taskkill / 任务管理器正常终止；alice 退出时由 Job Object
              回收整棵子树，不会留孤儿。
            </div>
          </div>

          {/*
            原「EXEC / 执行一条」面板已删除（用户要求）。
            后端 launchCodex('exec') 分支保留 —— 只删 UI，以后想恢复
            也不用动后端。
          */}
        </div>

        <div className="col gap">
          {/* ---------- 便携箱技能库（原 IO 导入导出面板重做） ---------- */}
          {/*
            原 IO 面板的「导出/粘贴导入 JSON」操作的是 localStorage 里的
            mock 数据（store.exportBundle），与磁盘无关，属于摆设 —— 整块删除。
            新面板管理便携箱真实生效的技能目录 .codex/skills：
              · 文件夹批量导入：与技能库页同一套交互（系统对话框多选文件夹，
                递归找 SKILL.md，zip 自动解压），同名先备份
              · 列表展示已装技能 + 逐个移除
          */}
          <div className="glass glass-iridescent glass-pad" data-tour="runtime.box">
            <div className="panel-head">
              <span className="kicker">BOX / 便携箱技能库</span>
              <span className="badge badge-neutral">{codexSkills.length} 个技能</span>
            </div>
            <div className="sub" style={{ marginBottom: 10 }}>
              便携箱技能目录 <span className="mono">.codex/skills</span>
              ，codex 启动时直接从这里读。批量导入与技能库页同款：选文件夹（可多选），
              自动识别含 <span className="mono">SKILL.md</span> 的技能目录，压缩包自动解压。
            </div>
            <div className="row gap" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary btn-sm"
                disabled={!be.IS_TAURI || importingSkills}
                title="打开系统对话框选择技能文件夹（可多选）"
                onClick={() => void addCodexSkills()}
              >
                <FolderPlus size={12} /> {importingSkills ? '导入中…' : '选文件夹导入'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                title={skillsRoot ? `打开便携箱技能目录：${skillsRoot}` : '打开便携箱技能目录'}
                onClick={() => {
                  // 打开技能库根目录 .codex/skills（不是第一个技能的子目录）
                  if (skillsRoot) openFolder(skillsRoot)
                }}
              >
                <FolderOpen size={12} /> 打开目录
              </button>
            </div>

            {codexSkills.length === 0 ? (
              <div className="sub">便携箱还没有技能 —— 点上方「选文件夹导入」。</div>
            ) : (
              <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {codexSkills.map((s) => (
                  <div key={s.target} className="pick-skill">
                    <div className="pick-skill-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row gap" style={{ alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 700, fontSize: 11.5 }}>{s.title || s.name}</span>
                          {!s.valid && <span className="badge badge-warn">无 SKILL.md</span>}
                          <span className="mono sub" style={{ fontSize: 9 }}>{s.files}文件</span>
                        </div>
                        <div className="side-skill-desc" style={{ maxHeight: 28, overflow: 'hidden' }}>
                          {s.description || '（无 description）'}
                        </div>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => openFolder(s.target)} title="打开技能目录">
                        <FolderOpen size={11} />
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeSkill(s)} title="从便携箱移除（源技能库不受影响）">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---------- 运行日志 ---------- */}
          <div className="glass glass-iridescent glass-pad" style={{ flex: 1 }} data-tour="runtime.log">
            <div className="panel-head">
              <span className="kicker">LOG / 运行日志</span>
              <span className="badge badge-neutral">{logs.length} 条</span>
            </div>
            {logs.length === 0 ? (
              <div className="sub">暂无日志。启动、自检与执行输出会显示在这里。</div>
            ) : (
              <div className="runtime-log">
                {logs.map((l: LogLine, i: number) => (
                  <div key={i} className="runtime-log-line">
                    <span className="runtime-log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
                    <span className={`runtime-log-text log-${l.kind}`}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 便携箱技能导入：纯复制语义，无结果弹窗（用户要求）——只 toast 摘要 */}

      {/*
        包内 config.toml 编辑器（右侧抽屉，与技能页 SKILL.md 编辑器同一套外壳：
        .drawer-overlay + .drawer + .drawer-head/.drawer-editor/.drawer-foot）。
        体检行的「编辑」按钮打开它；保存走 save_file_text（自动备份 .bak-edit-*），
        保存后重跑探针，体检行的 provider 值立刻反映新内容。
      */}
      {cfgEdit && (
        <div className="drawer-overlay" onClick={closeConfigEditor}>
          <div
            className="drawer glass glass-strong"
            data-tour="runtime.config"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <div>
                <span className="kicker">EDIT / config.toml</span>
                <div className="h2">包内 codex 配置</div>
                <div className="mono sub" style={{ fontSize: 10, wordBreak: 'break-all' }}>
                  {configPath}
                </div>
              </div>
              <div className="row gap">
                {cfgEdit.dirty && (
                  <span className="badge badge-warn" data-tour="runtime.config-dirty">
                    未保存
                  </span>
                )}
                <button
                  className="btn"
                  onClick={() => openFolder(configPath)}
                  title="在资源管理器中定位这份配置"
                >
                  <FolderOpen size={13} />
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!cfgEdit.dirty || cfgSaving}
                  onClick={() => void saveConfigEditor()}
                >
                  <Save size={12} /> {cfgSaving ? '保存中…' : '保存'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  data-tour="runtime.config-close"
                  onClick={closeConfigEditor}
                  title="关闭"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <textarea
              className="textarea drawer-editor"
              value={cfgEdit.text}
              onChange={(e) => setCfgEdit({ text: e.target.value, dirty: true })}
              spellCheck={false}
            />
            <div className="drawer-foot">
              <span className="mono sub" style={{ fontSize: 10 }}>
                {cfgEdit.text.length} 字符 · {cfgEdit.text.split('\n').length} 行 · provider{' '}
                {runtime.configProvider || '—'}
              </span>
              <span className="sub" style={{ fontSize: 10.5 }}>
                保存后重启 codex 生效；原文件自动备份 <span className="mono">.bak-edit-*</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {confirmNode}
    </div>
  )
}
