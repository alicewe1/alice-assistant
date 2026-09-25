import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CloudState,
  LogLine,
  PromptTemplate,
  RunSession,
  RuntimeState,
  SkillPackage,
  TargetProfile,
  TargetVersion,
} from '@/types/domain'
import {
  newSession,
  seedCloud,
  seedPrompts,
  seedRuntime,
  seedSkills,
  seedTargets,
  seedVersions,
} from '@/lib/mock'
import { useApp } from '@/lib/app-context'
import * as be from '@/lib/tauri'
import type { ClientEntryDto } from '@/lib/tauri'
import { getClientSpec, effectiveVersion } from '@/lib/inject-spec'
import { loadSkillPick, saveSkillPick, skillKey } from '@/lib/skill-pick'
import type { PickMap } from '@/lib/skill-pick'

interface StoreCtx {
  targets: TargetProfile[]
  versions: TargetVersion[]
  skills: SkillPackage[]
  prompts: PromptTemplate[]
  runtime: RuntimeState
  cloud: CloudState
  logs: LogLine[]
  sessions: RunSession[]
  activeTargetId: string | null
  activeVersionId: string | null
  activeTarget: TargetProfile | null
  activeVersion: TargetVersion | null
  /** 后端是否真实可用（Tauri 窗口内为 true） */
  backendLive: boolean
  /**
   * 客户端清单（profiles/<客户端>/）+ 各自工作路径 + 注入状态。
   *
   * 放在 store 里而不是各组件自己持有：左栏（TargetRail）和目标页
   * 都需要它，各自维护一份会导致「装完了左栏状态不变」——
   * 因为安装发生在目标页，刷新的只是它自己那份。
   */
  clients: ClientEntryDto[]
  /** 重新拉取客户端清单（安装/卸载后调用，两处一起更新） */
  reloadClients: () => Promise<void>
  setActiveTarget: (id: string | null) => void
  setActiveVersion: (id: string | null) => void
  saveTarget: (t: TargetProfile) => void
  deleteTarget: (id: string) => void
  installVersion: (
    targetId: string,
    versionId: string,
    choiceFile?: string,
    withSkills?: boolean,
    skillFilter?: string[] | null,
  ) => Promise<void>
  uninstallTarget: (targetId: string) => Promise<void>
  saveVersion: (v: TargetVersion) => void
  deleteVersion: (id: string) => void
  saveSkill: (s: SkillPackage) => void
  deleteSkill: (id: string) => void
  toggleSkill: (id: string) => void
  savePrompt: (p: PromptTemplate) => void
  deletePrompt: (id: string) => void
  /** 真后端：引擎探针 */
  probeEngine: () => Promise<void>
  probing: boolean
  /** 真后端：启动 codex（cli / exec / desktop） */
  launchCodex: (mode: 'cli' | 'exec' | 'desktop', task?: string) => Promise<void>
  /**
   * 停止运行体。
   * force=true 时即使没有跟踪实例也做「包内归属清扫」，
   * 用来收拾上一次崩溃/旧版残留的孤儿进程（这才是「停不掉」的兜底口）。
   */
  stopCodex: (force?: boolean) => Promise<void>
  /**
   * 换一个随机镜像名重启（停止 → 用新随机名拉起同一模式）。
   * 想立刻甩掉可能已经盯上当前进程名的清理工具时用。
   */
  rotateAlias: (mode?: 'cli' | 'exec' | 'desktop') => Promise<void>
  /** 主动同步后端真实运行状态（含未跟踪的残留进程探测） */
  syncRuntime: () => Promise<void>
  /** 真后端：打开路径 */
  openFolder: (path: string) => Promise<void>
  setRuntime: (r: RuntimeState) => void
  pushLog: (text: string, kind?: LogLine['kind']) => void
  setCloud: (c: CloudState) => void
  /** 提示词/技能勾选（技能库页与安装筛选共用同一份） */
  skillPick: PickMap
  setSkillPick: (packId: string, name: string, on: boolean) => void
  setSkillPickMany: (packId: string, names: string[], on: boolean) => void
  /**
   * 导入导出只针对提示词与技能库。
   * MCP 的导出已移除：MCP 配置是**注入到客户端 config.toml 的服务器定义**，
   * 不是可搬运的素材，导出成 JSON 没有实际用途（导入侧也无人消费）。
   */
  exportBundle: (what: 'prompts' | 'skills') => string
  importBundle: (what: 'prompts' | 'skills', json: string) => void
  /** 把本机 ~/.codex/config.toml 的模型/供应商字段透传到包内（保留包内 MCP 段） */
  syncConfigFromHost: () => Promise<void>
  /** 探针刷新（体检项里的「刷新图标」用它重读 config 并展示 provider 名） */
  refreshProbe: () => Promise<void>
  startSession: (targetId: string, versionId: string) => RunSession
  appendMessage: (sessionId: string, role: RunSession['messages'][number]['role'], content: string) => void
  endSession: (sessionId: string, status: RunSession['status']) => void
  deleteSession: (sessionId: string) => void
}

const Ctx = createContext<StoreCtx | null>(null)

export function useStore(): StoreCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('StoreProvider missing')
  return v
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 阶段三迁 Tauri fs */
  }
}

let seq = 1
function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const { toast } = useApp()
  const [targets, setTargets] = useState(() => load('a6-targets', seedTargets))
  const [versions, setVersions] = useState(() => load('a6-versions', seedVersions))
  const [skills, setSkills] = useState(() => load('a6-skills', seedSkills))
  const [prompts, setPrompts] = useState(() => load('a6-prompts', seedPrompts))
  const [runtime, setRuntime] = useState(() => load('a6-runtime', seedRuntime))
  const [cloud, setCloud] = useState(() => load('a6-cloud', seedCloud))
  const [logs, setLogs] = useState<LogLine[]>([])
  const [sessions, setSessions] = useState<RunSession[]>(() => load('a6-sessions', []))
  const [activeTargetId, setActiveTargetId] = useState<string | null>(() => load('a6-at', 'codex'))
  const [activeVersionId, setActiveVersionId] = useState<string | null>(() => load('a6-av', null))
  const [backendLive, setBackendLive] = useState(false)
  const [probing, setProbing] = useState(false)
  /** 客户端清单（左栏 + 目标页共用一份，避免状态漂移） */
  const [clients, setClients] = useState<ClientEntryDto[]>([])

  /**
   * 探针函数的 ref：syncConfigFromHost（定义在下方）需要在透传成功后重新自检，
   * 但 probeEngine 声明位置更靠后。用 ref 打破声明顺序依赖，
   * 避免把 probeEngine 整体上移（它会引用更多未声明的 state）。
   */
  const probeEngineRef = useRef<(() => Promise<void>) | null>(null)
  /** 上一轮状态查询看到的「未跟踪残留」指纹：连续两轮一致才报警（见 syncRuntime） */
  const prevStrayRef = useRef<string | null>(null)

  const reloadClients = useCallback(async () => {
    if (!be.IS_TAURI) return
    try {
      setClients(await be.clientsList())
    } catch {
      /* 读不到就留空 */
    }
  }, [])
  /**
   * 技能勾选（跨页共享）：技能库页改这里，目标页安装时按它生成 skillFilter。
   * 单放一份 state 而不是各自存 localStorage，避免两页数据漂移。
   */
  const [skillPick, setSkillPickState] = useState<PickMap>(loadSkillPick)
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime

  useEffect(() => save('a6-targets', targets), [targets])
  useEffect(() => save('a6-versions', versions), [versions])
  useEffect(() => save('a6-skills', skills), [skills])
  useEffect(() => save('a6-prompts', prompts), [prompts])
  useEffect(() => save('a6-runtime', runtime), [runtime])
  useEffect(() => save('a6-cloud', cloud), [cloud])
  useEffect(() => save('a6-sessions', sessions.slice(-30)), [sessions])
  useEffect(() => save('a6-at', activeTargetId), [activeTargetId])
  useEffect(() => save('a6-av', activeVersionId), [activeVersionId])

  // 技能勾选变化即落盘：切页/重启后保持选择
  const setSkillPick = useCallback((packId: string, name: string, on: boolean) => {
    setSkillPickState((m) => {
      const next = { ...m, [skillKey(packId, name)]: on }
      saveSkillPick(next)
      return next
    })
  }, [])

  const setSkillPickMany = useCallback((packId: string, names: string[], on: boolean) => {
    setSkillPickState((m) => {
      const next = { ...m }
      for (const n of names) next[skillKey(packId, n)] = on
      saveSkillPick(next)
      return next
    })
  }, [])

  const pushLog = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLogs((l) => [...l.slice(-299), { ts: Date.now(), text, kind }])
  }, [])

  // ---------- 后端接入：先探测，再订阅事件 ----------
  // 顺序很重要：探测放最前且各自独立 catch。
  // 踩过的坑：事件订阅（listen）在权限缺失时会 reject，
  // 若写成 await listen(...) 后再 probe，一次 reject 会让整个 async 块中断，
  // 探针永远不会执行，页面就一直显示种子数据。
  useEffect(() => {
    if (!be.IS_TAURI) return
    let alive = true
    const unsubs: Array<() => void> = []

    const probe = async () => {
      try {
        const rep = await be.engineProbe()
        if (!alive) return
        setBackendLive(true)
        setRuntime((r) => ({
          ...r,
          ready: rep.ok,
          root: rep.root,
          counts: {
            skills: rep.counts.skills,
            prompts: rep.counts.prompts,
          },
          runtimeMB: rep.runtime_mb,
          hasKey: rep.has_key,
          promptSources: rep.prompt_sources ?? [],
          configProvider: rep.config_provider ?? '',
          hostConfigExists: rep.host_config_exists ?? false,
          hostConfigPath: rep.host_config_path ?? '',
          checks: {
            codexHome: rep.checks.find((c) => c.key === 'codexHome')?.ok ?? false,
            codexExe: rep.checks.find((c) => c.key === 'codexExe')?.ok ?? false,
            desktopExe: rep.checks.find((c) => c.key === 'desktopExe')?.ok ?? false,
            skills: rep.checks.find((c) => c.key === 'skills')?.ok ?? false,
            prompts: rep.checks.find((c) => c.key === 'prompts')?.ok ?? false,
            tools: rep.checks.find((c) => c.key === 'tools')?.ok ?? false,
          },
        }))
        pushLog(`后端已连接 · 运行体 ${rep.root}`, 'ok')
        pushLog(
          `探针：codex ${rep.codex_version || '未探测到'} · 技能 ${rep.counts.skills} · 提示词 ${rep.counts.prompts} · MCP 依赖 ${rep.counts.mcp_libs} 项 · ${rep.runtime_mb} MB`,
          'ok',
        )
      } catch (e) {
        if (!alive) return
        pushLog(`后端探测失败：${String(e)}`, 'err')
      }
    }

    const subscribe = async () => {
      try {
        unsubs.push(
          await be.onRuntimeLog((text, kind) => {
            pushLog(text, (kind as LogLine['kind']) ?? 'info')
          }),
        )
      } catch (e) {
        pushLog(`日志事件订阅失败：${String(e)}`, 'warn')
      }
      try {
        unsubs.push(
          await be.onRuntimeStatus((status) => {
            setRuntime((r) => ({ ...r, running: status === 'running' }))
          }),
        )
      } catch (e) {
        pushLog(`状态事件订阅失败：${String(e)}`, 'warn')
      }
    }

    /*
     * 启动探针延后到首帧之后。
     *
     * 为什么不能立即跑：探针要读磁盘（首次算体积仍要遍历几万个文件，
     * 实测 0.8~2.4s，见 runtime.rs 的 SIZE_DIRS 注释）。它虽然是 async
     * command 不占主线程，但**首次**会吃满磁盘队列 —— 用户恰好在这时候
     * 点第一下，点击响应就明显变钝。
     * 用 requestAnimationFrame 双帧 + 空闲回调，让首帧先画出来、
     * 界面先可交互，再把探针放出去。
     */
    const kick = () => {
      if (!alive) return
      void probe()
      void subscribe()
    }
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback
    if (typeof idle === 'function') {
      idle(kick, { timeout: 1200 })
    } else {
      window.setTimeout(kick, 300)
    }

    return () => {
      alive = false
      for (const u of unsubs) u()
    }
  }, [pushLog])

  const probeEngine = useCallback(async () => {
    setProbing(true)
    pushLog('正在自检运行体 …', 'info')
    try {
      // deep=true：这是用户主动点的自检，值得花那 ~100ms 去读版本号
      const rep = await be.engineProbe(true)
      setBackendLive(true)
      setRuntime((r) => ({
        ...r,
        ready: rep.ok,
        root: rep.root,
        counts: {
          skills: rep.counts.skills,
          prompts: rep.counts.prompts,
        },
        runtimeMB: rep.runtime_mb,
        hasKey: rep.has_key,
        checks: {
          codexHome: rep.checks.find((c) => c.key === 'codexHome')?.ok ?? false,
          codexExe: rep.checks.find((c) => c.key === 'codexExe')?.ok ?? false,
          desktopExe: rep.checks.find((c) => c.key === 'desktopExe')?.ok ?? false,
          skills: rep.checks.find((c) => c.key === 'skills')?.ok ?? false,
          prompts: rep.checks.find((c) => c.key === 'prompts')?.ok ?? false,
          tools: rep.checks.find((c) => c.key === 'tools')?.ok ?? false,
        },
      }))
      const pass = rep.checks.filter((c) => c.ok).length
      pushLog(
        `自检完成：${pass}/${rep.checks.length} 项通过` +
          (rep.codex_version ? ` · ${rep.codex_version}` : '') +
          (rep.adb_version ? ` · ${rep.adb_version}` : ''),
        rep.ok ? 'ok' : 'warn',
      )
      for (const c of rep.checks) {
        if (!c.ok) pushLog(`未通过：${c.label} — ${c.detail}`, 'warn')
      }
      toast(rep.ok ? '自检通过，运行体可用' : `自检有 ${rep.checks.length - pass} 项未通过`, rep.ok ? 'ok' : 'warn')
    } catch (e) {
      setBackendLive(false)
      pushLog(`自检失败（后端不可用）：${String(e)}`, 'err')
      toast('后端不可用 —— 这是浏览器预览模式', 'warn')
    } finally {
      setProbing(false)
    }
  }, [pushLog, toast])

  // 让 syncConfigFromHost（上方已调用过）拿到探针；此处 probeEngine 已就绪
  probeEngineRef.current = probeEngine

  const launchCodex = useCallback(
    async (mode: 'cli' | 'exec' | 'desktop', task?: string) => {
      pushLog(`启动请求：${mode}${task ? ` · ${task.slice(0, 40)}` : ''}`, 'info')
      try {
        const r = await be.codexLaunch(mode, task)
        if (r.ok) {
          // 旧实现写 running: mode !== 'desktop' —— 于是启动桌面端后「停止」按钮
          // 永远 disabled（它按 running 判定），Electron 那一大串后代也就没人能停。
          // 三种模式都是运行体，一律置 running。
          setRuntime((rt) => ({
            ...rt,
            running: true,
            pid: r.pid,
            procCount: r.count ?? 1,
            aliasName: r.aliasName ?? '',
            // 独占终止保护已移除：后端恒回 false，这里固定 false 以保持一致
            guarded: false,
          }))
          const name = r.aliasName ? ` · 随机名 ${r.aliasName}` : ''
          pushLog(r.pid ? `已启动 (PID ${r.pid})${name}` : '已启动', 'ok')
        } else {
          pushLog(`启动失败：${r.error}`, 'err')
          toast(`启动失败：${r.error}`, 'bad')
        }
      } catch (e) {
        pushLog(`后端调用失败：${String(e)}`, 'err')
        toast('后端不可用（浏览器预览模式）', 'warn')
      }
    },
    [pushLog, toast],
  )

  const stopCodex = useCallback(
    async (force = false) => {
      try {
        const r = await be.codexStop()
        if (r.ok) {
          setRuntime((s) => ({
            ...s,
            running: false,
            pid: null,
            procCount: 0,
            strayPids: [],
            aliasName: '',
            guarded: false,
          }))
          pushLog(r.pids && r.pids.length ? `已停止，清理进程 ${r.pids.join(', ')}` : '已停止', 'ok')
        } else {
          // 没跟踪到实例时后端会回这个错；force 请求就是「清扫残留」的出口
          pushLog(`停止：${r.error}${force ? '（已请求归属清扫）' : ''}`, 'warn')
          setRuntime((s) => ({ ...s, running: false, pid: null }))
        }
        // 无论结果如何都以后端真实状态为准：句柄可能早失效，只有扫描说实话
        const st = await be.codexStatus().catch(() => null)
        if (st) {
          const still: number[] = st.pids ?? []
          if (still.length) {
            pushLog(`仍有包内进程存活：${still.join(', ')}（可再点一次「强制清理」）`, 'err')
            toast(`仍有 ${still.length} 个进程未退出`, 'bad')
          }
          setRuntime((s) => ({
            ...s,
            running: !!st.ok || still.length > 0,
            pid: st.pid,
            procCount: st.count ?? 0,
            strayPids: still,
          }))
        }
      } catch (e) {
        pushLog(`停止失败：${String(e)}`, 'err')
      }
    },
    [pushLog, toast],
  )

  /**
   * 换随机名重启：想在怀疑被按名盯上时立刻换一个新镜像名。
   * 后端会先用预留句柄停掉当前实例，再用新随机名拉起。
   */
  const rotateAlias = useCallback(
    async (mode: 'cli' | 'exec' | 'desktop' = 'cli') => {
      pushLog(`正在更换随机名并重启（${mode}）…`, 'info')
      try {
        const r = await be.codexAliasRotate(mode)
        if (r.ok) {
          setRuntime((s) => ({
            ...s,
            running: true,
            pid: r.pid,
            procCount: r.count ?? 1,
            aliasName: r.aliasName ?? '',
            guarded: false,
          }))
          pushLog(`已换名重启：新随机名 ${r.aliasName || '—'}`)
        } else {
          pushLog(`换名失败：${r.error}`, 'err')
          toast(`换名失败：${r.error}`, 'bad')
        }
      } catch (e) {
        pushLog(`换名调用失败：${String(e)}`, 'err')
      }
    },
    [pushLog, toast],
  )

  /** 轮询后端真实状态：让「运行中」不再依赖内存里的 Child 句柄 */
  const syncRuntime = useCallback(async () => {
    try {      const st = await be.codexStatus()
      const stray: number[] = st.pids ?? []
      setRuntime((s) => ({
        ...s,
        // pid 在跑、或存在残留孤儿，都算「需要清理」的状态
        running: !!st.ok || stray.length > 0,
        pid: st.pid,
        procCount: st.count ?? 0,
        strayPids: stray,
      }))
      // 「未跟踪的残留」要连续两轮都看到才提示。
      //
      // 为什么：自动重建（被外部杀掉后换名重启）有一个几百毫秒的窗口 ——
      // 旧进程已退出、新进程刚起来还没登记进槽位，这一瞬间状态查询会把它
      // 算成「未跟踪」。只采样一次就报警会把正常重建刷成残留告警（实测出现过）。
      // 连续两轮都还在，才说明是真的没人管的孤儿。
      if (st.error === '检测到未跟踪的残留进程') {
        const key = [...stray].sort((a, b) => a - b).join(',')
        if (prevStrayRef.current === key) {
          pushLog(`检测到包内残留进程：${stray.join(', ')} —— 点「停止」收掉`, 'warn')
          prevStrayRef.current = null // 报过就重置，避免持续刷屏
        } else {
          prevStrayRef.current = key
        }
      } else {
        prevStrayRef.current = null
      }
    } catch {
      /* 后端不可用（浏览器预览）时忽略 */
    }
  }, [pushLog])

  // 每 5 秒同步一次真实进程状态：程序崩溃/被外部杀掉后界面能自动跟上，
  // 也能第一时间暴露「停不掉的残留进程」。
  useEffect(() => {
    if (!be.IS_TAURI) return
    const t = window.setInterval(() => void syncRuntime(), 5000)
    return () => window.clearInterval(t)
  }, [syncRuntime])

  const openFolder = useCallback(
    async (path: string) => {
      try {
        const r = await be.openPath(path)
        if (!r.ok) toast(`打开失败：${r.error}`, 'bad')
      } catch {
        toast('浏览器预览模式无法打开本地路径', 'warn')
      }
    },
    [toast],
  )

  const activeTarget = useMemo(() => targets.find((t) => t.id === activeTargetId) ?? null, [targets, activeTargetId])
  const activeVersion = useMemo(() => versions.find((v) => v.id === activeVersionId) ?? null, [versions, activeVersionId])

  const setActiveTarget = useCallback(
    (id: string | null) => {
      setActiveTargetId(id)
      if (id) {
        const first = versions.find((v) => v.targetId === id)
        setActiveVersionId(first?.id ?? null)
      }
    },
    [versions],
  )

  const saveTarget = useCallback((t: TargetProfile) => {
    setTargets((list) => {
      const i = list.findIndex((x) => x.id === t.id)
      const next = { ...t, updatedAt: Date.now() }
      if (i === -1) return [...list, next]
      const copy = [...list]
      copy[i] = next
      return copy
    })
  }, [])

  const deleteTarget = useCallback(
    (id: string) => {
      setTargets((l) => l.filter((t) => t.id !== id))
      setVersions((l) => l.filter((v) => v.targetId !== id))
      if (activeTargetId === id) {
        setActiveTargetId(null)
        setActiveVersionId(null)
      }
      toast('目标已删除', 'warn')
    },
    [activeTargetId, toast],
  )

  /** 真写入：把提示词包注入目标配置文件（标记块，幂等，自动备份） */
  const installVersion = useCallback(
    async (
      targetId: string,
      versionId: string,
      choiceFile?: string,
      withSkills = true,
      skillFilter?: string[] | null,
    ) => {
      const spec = getClientSpec(targetId)
      if (!spec) {
        toast(`未找到客户端规格：${targetId}`, 'bad')
        return
      }
      const ver = spec.versions.find((v) => v.id === versionId) ?? effectiveVersion(spec, versionId)
      if (!ver) {
        toast('未找到该版本', 'bad')
        return
      }

      // 先乐观标记（失败会回滚）
      setTargets((l) =>
        l.map((x) => (x.id === targetId ? { ...x, installedVersionId: versionId, updatedAt: Date.now() } : x)),
      )
      pushLog(`[inject] 开始安装 ${spec.name} · ${ver.label}`, 'info')

      if (!be.IS_TAURI) {
        pushLog(`[预览] ${spec.name} → ${spec.injectTargets.map((t) => t.path).join(' / ')}（浏览器模式不写文件）`, 'warn')
        toast('预览模式：未写真实文件', 'warn')
        return
      }

      try {
        const rep = await be.injectInstall(spec, ver, choiceFile ?? null, withSkills, skillFilter ?? null)
        for (const s of rep.steps) pushLog(`[inject] ${s}`, 'info')
        if (rep.ok) {
          pushLog(
            `[inject] 完成：技能 ${rep.skillsInstalled.length} 个（跳过未变 ${rep.skillsSkipped}）`,
            'ok',
          )
          toast('注入完成', 'ok')
        } else {
          // 失败回滚
          setTargets((l) => l.map((x) => (x.id === targetId ? { ...x, installedVersionId: null } : x)))
          pushLog(`[inject] 失败：${rep.error}`, 'err')
          toast(`注入失败：${rep.error}`, 'bad')
        }
      } catch (e) {
        setTargets((l) => l.map((x) => (x.id === targetId ? { ...x, installedVersionId: null } : x)))
        pushLog(`[inject] 后端调用失败：${String(e)}`, 'err')
        toast('后端不可用（浏览器预览模式）', 'warn')
      }
    },
    [pushLog, toast],
  )

  const uninstallTarget = useCallback(
    async (targetId: string) => {
      const spec = getClientSpec(targetId)
      if (!spec) return
      if (be.IS_TAURI) {
        try {
          const rep = await be.injectUninstall(spec, true)
          for (const s of rep.steps) pushLog(`[inject] ${s}`, 'info')
          pushLog(`[inject] ${spec.name} 卸载完成`, 'warn')
        } catch (e) {
          pushLog(`[inject] 卸载失败：${String(e)}`, 'err')
          toast(`卸载失败：${String(e)}`, 'bad')
          return
        }
      } else {
        pushLog(`[预览] 卸载 ${spec.name}`, 'warn')
      }
      setTargets((l) =>
        l.map((x) => (x.id === targetId ? { ...x, installedVersionId: null, updatedAt: Date.now() } : x)),
      )
      toast('已卸载还原（用户自有内容保留）', 'warn')
    },
    [pushLog, toast],
  )

  const saveVersion = useCallback((v: TargetVersion) => {
    setVersions((list) => {
      const i = list.findIndex((x) => x.id === v.id)
      const next = { ...v, updatedAt: Date.now() }
      if (i === -1) return [...list, next]
      const copy = [...list]
      copy[i] = next
      return copy
    })
  }, [])

  const deleteVersion = useCallback(
    (id: string) => {
      setVersions((l) => l.filter((v) => v.id !== id))
      setSkills((l) => l.map((s) => ({ ...s, versionIds: s.versionIds.filter((v) => v !== id) })))
      setPrompts((l) => l.map((p) => ({ ...p, versionIds: p.versionIds.filter((v) => v !== id) })))
      setTargets((l) => l.map((t) => (t.installedVersionId === id ? { ...t, installedVersionId: null } : t)))
      if (activeVersionId === id) setActiveVersionId(null)
      toast('版本已删除，关联引用已清理', 'warn')
    },
    [activeVersionId, toast],
  )

  const saveSkill = useCallback((s: SkillPackage) => {
    setSkills((list) => {
      const i = list.findIndex((x) => x.id === s.id)
      const next = { ...s, updatedAt: Date.now() }
      if (i === -1) return [...list, next]
      const copy = [...list]
      copy[i] = next
      return copy
    })
  }, [])

  const deleteSkill = useCallback(
    (id: string) => {
      setSkills((l) => l.filter((s) => s.id !== id))
      setVersions((l) => l.map((v) => ({ ...v, skillIds: v.skillIds.filter((s) => s !== id) })))
      toast('技能已删除并从所有版本解绑', 'warn')
    },
    [toast],
  )

  const toggleSkill = useCallback((id: string) => {
    setSkills((l) => l.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  }, [])

  const savePrompt = useCallback((p: PromptTemplate) => {
    setPrompts((list) => {
      const i = list.findIndex((x) => x.id === p.id)
      const next = { ...p, updatedAt: Date.now() }
      if (i === -1) return [...list, next]
      const copy = [...list]
      copy[i] = next
      return copy
    })
  }, [])

  const deletePrompt = useCallback((id: string) => {
    setPrompts((l) => l.filter((p) => p.id !== id))
  }, [])

  const exportBundle = useCallback(
    (what: 'prompts' | 'skills') => {
      const data = what === 'prompts' ? prompts : skills
      pushLog(`[export] ${what} 导出 ${data.length} 项`, 'ok')
      return JSON.stringify({ kind: what, exportedAt: Date.now(), items: data }, null, 2)
    },
    [prompts, skills, pushLog],
  )

  const importBundle = useCallback(
    (what: 'prompts' | 'skills', json: string) => {
      try {
        const parsed = JSON.parse(json) as { kind?: string; items?: unknown[] }
        if (!Array.isArray(parsed.items)) throw new Error('缺少 items 数组')
        if (parsed.kind && parsed.kind !== what) throw new Error(`类型不匹配：文件是 ${parsed.kind}`)
        if (what === 'prompts') {
          const items = parsed.items as PromptTemplate[]
          setPrompts((list) => {
            const map = new Map(list.map((p) => [p.id, p]))
            for (const it of items) map.set(it.id, it)
            return [...map.values()]
          })
        } else {
          const items = parsed.items as SkillPackage[]
          setSkills((list) => {
            const map = new Map(list.map((s) => [s.id, s]))
            for (const it of items) map.set(it.id, it)
            return [...map.values()]
          })
        }
        pushLog(`[import] ${what} 导入 ${parsed.items.length} 项`, 'ok')
        toast(`导入成功：${parsed.items.length} 项`, 'ok')
      } catch (e) {
        pushLog(`[import] 失败：${String(e)}`, 'err')
        toast(`导入失败：${String(e)}`, 'bad')
      }
    },
    [pushLog, toast],
  )

  /**
   * 透传本机 config.toml 的模型/供应商字段到包内。
   *
   * 后端只同步白名单字段（model / model_provider / 上下文窗口 / [model_providers.*]），
   * 包内的 MCP 段与 plugins 段原样保留 —— 本机那份带 `C:\Users\<你>\...` 绝对路径，
   * 整份覆盖会让包内配置指向本机。写入前后端自动备份为 config.toml.bak-<时间戳>。
   */
  const syncConfigFromHost = useCallback(async () => {
    if (!be.IS_TAURI) {
      pushLog('[config] 浏览器预览模式：未写入真实文件', 'warn')
      toast('浏览器预览无法透传配置', 'warn')
      return
    }
    try {
      const msg = await be.syncConfigFromHost()
      pushLog(`[config] ${msg}`, 'ok')
      toast('已透传本机模型配置', 'ok')
      // 同步后重读，让体检项立刻显示新的 provider 名
      await probeEngineRef.current?.()
    } catch (e) {
      pushLog(`[config] 透传失败：${String(e)}`, 'err')
      toast(`透传失败：${String(e)}`, 'bad')
    }
  }, [pushLog, toast])

  const startSession = useCallback((targetId: string, versionId: string) => {
    const s = newSession(targetId, versionId)
    s.status = 'running'
    setSessions((l) => [...l, s])
    return s
  }, [])

  const appendMessage = useCallback(
    (sessionId: string, role: RunSession['messages'][number]['role'], content: string) => {
      setSessions((l) =>
        l.map((s) => (s.id === sessionId ? { ...s, messages: [...s.messages, { role, content, ts: Date.now() }] } : s)),
      )
    },
    [],
  )

  const endSession = useCallback((sessionId: string, status: RunSession['status']) => {
    setSessions((l) => l.map((s) => (s.id === sessionId ? { ...s, status, endedAt: Date.now() } : s)))
  }, [])

  const deleteSession = useCallback((sessionId: string) => {
    setSessions((l) => l.filter((s) => s.id !== sessionId))
  }, [])

  const value = useMemo(
    () => ({
      targets, versions, skills, prompts, runtime, cloud, logs, sessions,
      activeTargetId, activeVersionId, activeTarget, activeVersion, backendLive,
      clients, reloadClients,
      setActiveTarget, setActiveVersion: setActiveVersionId,
      saveTarget, deleteTarget, installVersion, uninstallTarget,
      saveVersion, deleteVersion,
      saveSkill, deleteSkill, toggleSkill,
      savePrompt, deletePrompt,
      probeEngine, probing, launchCodex, stopCodex, rotateAlias, syncRuntime, openFolder,
      setRuntime, pushLog, setCloud,
          skillPick, setSkillPick, setSkillPickMany,
      exportBundle, importBundle, syncConfigFromHost, refreshProbe: probeEngine,
      startSession, appendMessage, endSession, deleteSession,
    }),
    [
      targets, versions, skills, prompts, runtime, cloud, logs, sessions,
      activeTargetId, activeVersionId, activeTarget, activeVersion, backendLive,
      clients, reloadClients,
      setActiveTarget, saveTarget, deleteTarget, installVersion, uninstallTarget,
      saveVersion, deleteVersion, saveSkill, deleteSkill, toggleSkill,
      savePrompt, deletePrompt, probeEngine, probing, launchCodex, stopCodex, rotateAlias, syncRuntime, openFolder,
      pushLog,
      skillPick, setSkillPick, setSkillPickMany,
      exportBundle, importBundle, syncConfigFromHost, probeEngine,
      startSession, appendMessage, endSession, deleteSession,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export { genId }
