import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  FileText,
  FolderOpen,
  FolderPlus,
  Info,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { Topbar, EmptyState } from '@/components/topbar'
import { Modal, useConfirm } from '@/components/modal'
import { Switch } from '@/components/switch'
import { WarnTip } from '@/components/warn-tip'
import { DupSkillPicker } from '@/components/dup-skill-picker'
import { InjectProgressDialog } from '@/components/inject-progress-dialog'
import { CUSTOM_TARGET_ID } from '@/components/target-rail'
import { isSkillOn } from '@/lib/skill-pick'
import { findSkillDuplicates, resolveSkillChoice } from '@/lib/skill-dup'
import type { SkillDuplicate } from '@/lib/skill-dup'
import * as be from '@/lib/tauri'
import type { ClientEntryDto, PromptItemDto, ProfileEntryDto, SkillItemDto, SkillPackDto, TargetStatusDto, VersionBundleDto } from '@/lib/tauri'

const CLIENT_LABEL: Record<string, string> = {
  codex: 'Codex 破甲',
  zcode: 'ZCode 破甲',
  cursor: 'Cursor 破甲',
  claude: 'Claude 破甲',
  workbuddy: 'WorkBuddy 破甲（国际版）',
  dsh: 'DeepSeek Harness 破甲',
  _custom: '自定义版本',
}

export function Targets() {
  const {
    pushLog,
    openFolder,
    setActiveTarget,
    activeTargetId,
    skillPick,
    clients,
    reloadClients,
  } = useStore()
  const { toast } = useApp()
  const { confirm, confirmNode } = useConfirm()

  const [profiles, setProfiles] = useState<ProfileEntryDto[]>([])
  const [loading, setLoading] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)
  /** 提示词组多选一的选中项（预设组挂了多份提示词时用） */
  const [promptIdx, setPromptIdx] = useState(0)
  const [withSkills] = useState(true)
  const [busy, setBusy] = useState(false)
  /** 当前操作类型：install | uninstall —— 决定进度弹窗的文案 */
  const [opKind, setOpKind] = useState<'install' | 'uninstall'>('install')
  /** 进度弹窗开关。安装/卸载完成后保持显示，由用户点关闭 */
  const [progOpen, setProgOpen] = useState(false)
  /**
   * 进度弹窗的待办清单。
   *
   * 由前端在点按钮时构造（那时 client/manifest 数据都在手上），
   * 不依赖后端事件 —— 后端事件是边做边发，等弹窗挂载时前面几步早发完了。
   */
  const [progPlan, setProgPlan] = useState<{ key: string; label: string }[]>([])
  /**
   * 当前预设组的原始 injectTargets（含 dir 型第三方）。
   * 进度清单要按它算出「会做哪些事」，所以单独存一份。
   */
  const [manifestTargets, setManifestTargets] = useState<
    Array<{ path?: string; mode?: string; label?: string }>
  >([])
  const [status, setStatus] = useState<TargetStatusDto[]>([])
  const [bundle, setBundle] = useState<VersionBundleDto | null>(null)

  // 新建预设组
  const [editor, setEditor] = useState<null | {
    manifest: Record<string, unknown>
    isNew: boolean
  }>(null)
  /** 编辑器素材库（提示词组 / 技能组从这两个库里选，不再走资源管理器挑单文件） */
  const [promptLib, setPromptLib] = useState<PromptItemDto[]>([])
  const [allPacks, setAllPacks] = useState<SkillPackDto[]>([])

  /**
   * 客户端清单来自 store（与左栏共用一份）。
   *
   * 之前这里自己维护一份，于是「安装完刷新」只刷到本页这份，
   * 左栏那份纹丝不动 —— 用户看到的就是「左栏注入状态不实时更新」。
   * 现在统一读 store，两处永远一致。
   */
  const [addClient, setAddClient] = useState<null | { id: string; workDir: string }>(null)

  /**
   * 技能库勾选（本次安装的最终结果）。
   *   null  = 还没动过 → 用预设组声明的技能组
   *   数组  = 用户动过 → 完全按这个装（取消预设包也能真的跳过）
   * 切换预设组时重置回 null，避免把上一个组的选择带过去。
   */
  const [packPick, setPackPick] = useState<string[] | null>(null)

  /** 技能库清单：进页面就加载（安装面板的技能库区块要用） */
  useEffect(() => {
    if (!be.IS_TAURI) return
    let alive = true
    void (async () => {
      try {
        const pk = await be.scanShippedSkillPacks()
        if (alive) setAllPacks(pk)
      } catch {
        /* 读不到就不显示技能库，不影响其它功能 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 客户端清单（含工作路径 + 注入状态）：store 里统一维护
  useEffect(() => {
    void reloadClients()
  }, [reloadClients])

  const sel = useMemo(() => profiles.find((p) => p.id === selId) ?? null, [profiles, selId])

  /** 当前生效的技能库勾选（未动过则等于预设声明的技能组） */
  const effectivePacks = packPick ?? sel?.skillPacks ?? []

  /**
   * 安装面板要显示的技能包：**只列本预设组勾选的那些**。
   * 早先这里铺的是 allPacks（整个技能库），用户一下看到十几个包，
   * 与「预设组」语义也不符 —— 没勾的包不该出现在这一栏。
   */
  const presetPacks = useMemo(() => {
    const ids = sel?.skillPacks ?? []
    return ids
      .map((id) => allPacks.find((p) => p.id === id))
      .filter((p): p is SkillPackDto => !!p)
  }, [allPacks, sel])

  const togglePack = (id: string) =>
    setPackPick((cur) => {
      const list = (cur ?? sel?.skillPacks ?? []).slice()
      const i = list.indexOf(id)
      if (i >= 0) list.splice(i, 1)
      else list.push(id)
      return list
    })

  /** 用户为每个重名技能选的来源（技能名 → 包 id）。声明提前，切换预设时要重置 */
  const [pickDup, setPickDup] = useState<Record<string, string>>({})

  // 切换预设组时重置技能库勾选与重名来源选择，免得把上一组的选择带过去
  useEffect(() => {
    setPackPick(null)
    // 重名来源也要清：不同预设组的技能包组合不同，上一组的「某技能取哪个包」
    // 在新组里可能指向一个根本不存在的包
    setPickDup({})
  }, [selId])

  const declaredPacksKey = useMemo(
    () => JSON.stringify(sel?.skillPacks ?? []),
    [sel],
  )

  /**
   * manifest 声明的技能组变化（编辑器保存 / 外部修改 + 刷新）→ 勾选快照作废。
   *
   * packPick 只在 selId 变化时重置的话，会藏着一个更阴的坑：
   * 用户点过芯片后 packPick 定格成当时的声明快照；之后 manifest 里删掉某个包
   * （芯片列表不再显示它），packPick 里却还留着 —— 每次安装都作为
   * skillPacksOverride 整表覆盖后端，被删的包无声装回，界面上毫无提示。
   * 声明一变就作废回 null：null = 后端按 manifest 装，永远正确。
   */
  useEffect(() => {
    setPackPick(null)
  }, [declaredPacksKey])

  /**
   * 左栏目标 = profiles 的过滤维度。
   * 之前这里把全部客户端的版本铺在一起（按 client 分组），左栏点了目标也不影响中栏，
   * 现在改成：只显示当前选中目标的版本清单，左栏切目标 → 中栏清单整体换掉。
   * 自定义版本（client=_custom）不挂在任何内置目标下，单独在「自定义」分组里出现。
   */
  const curClient = activeTargetId || 'codex'
  const shownProfiles = useMemo(() => {
    const list = profiles.filter((p) => (p.client || '_custom') === curClient)
    return [...list].sort((a, b) => Number(b.recommended) - Number(a.recommended))
  }, [profiles, curClient])
  const curLabel = CLIENT_LABEL[curClient] ?? curClient
  /** 当前客户端在左栏清单里的那条记录（含注入状态） */
  const curClientEntry = useMemo(
    () => clients.find((c) => c.id === curClient) ?? null,
    [clients, curClient],
  )

  const refresh = useCallback(async () => {
    if (!be.IS_TAURI) return
    setLoading(true)
    try {
      const list = await be.profilesList()
      setProfiles(list)
      if (!selId && list.length) {
        const rec = list.find((p) => p.client === (activeTargetId || 'codex') && p.recommended)
        setSelId(rec?.id ?? list[0].id)
      }
    } catch (e) {
      pushLog(`[profiles] 扫描失败：${String(e)}`, 'err')
    } finally {
      setLoading(false)
    }
  }, [selId, activeTargetId, pushLog])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 左侧目标切换 → 中栏清单跟着换：自动选中该目标下推荐/第一个版本。
   * 依赖 curClient 而不是 activeTargetId，自定义分组也走同一条路径。
   */
  useEffect(() => {
    if (!profiles.length) return
    const list = profiles.filter((p) => (p.client || '_custom') === curClient)
    if (list.some((p) => p.id === selId)) return
    const rec = list.find((p) => p.recommended) ?? list[0]
    setSelId(rec?.id ?? null)
    // 用后端算出的默认索引，而不是死写 0
    setPromptIdx(rec?.defaultPromptIndex ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curClient, profiles])

  /**
   * 索引兜底：提示词组**长度会变**（后端会把文件已删除的项剔除），
   * 若 promptIdx 还停在旧位置上，界面就会读到 undefined ——
   * 表现为「提示词」那一行空白、状态徽标错乱。
   * 这里在列表变化后把越界索引拉回 0（后端过滤后列表恒非空时默认第一份）。
   */
  useEffect(() => {
    if (!sel) return
    if (promptIdx >= sel.prompts.length) setPromptIdx(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, sel?.prompts.length])

  /**
   * 拉取当前预设组的全部落点状态（提示词 / 技能 / 第三方 / 模块）。
   *
   * 状态查询必须带上全部落点，否则界面只会显示提示词那一行。
   * 早先这里 skillSync 写死 []、也没有 thirdParty ——
   * 于是「注入位置没有显示技能和第三方的」。
   * 与后端 manifest_to_spec 保持同一套拆分规则：mode=dir 的目标是
   * 第三方文件夹对，不进 injectTargets。
   */
  const loadStatus = useCallback(async (p: ProfileEntryDto) => {
    if (!be.IS_TAURI) {
      setStatus([])
      return
    }
    try {
      const { manifest } = await be.profileGet(p.id)
      const all = ((manifest.injectTargets as unknown[]) ?? []) as Array<{
        mode?: string
        path?: string
        sourceDir?: string
      }>
      const promptTargets = all.filter((t) => t.mode !== 'dir')
      // 存一份原始清单：进度弹窗按它算「会做哪些事」
      setManifestTargets(
        all as Array<{ path?: string; mode?: string; label?: string }>,
      )
      const thirdParty = all
        .filter((t) => t.mode === 'dir' && (t.path ?? '').trim())
        .map((t) => ({
          source: t.sourceDir ?? '',
          dest: t.path ?? '',
          // 备注要一路传到后端再回来，界面的标签才显示得出用户写的名字
          label: (t as { label?: string }).label ?? '',
          readonly: Boolean((t as { readonly?: boolean }).readonly),
        }))
      const st = await be.injectStatus({
        id: p.client,
        name: p.label,
        legacyScript: '',
        versions: [],
        injectTargets: promptTargets,
        skillSync: (manifest.skillSync as unknown[]) ?? [],
        moduleSync: (manifest.moduleSync as string | undefined) ?? null,
        thirdParty,
      })
      setStatus(st)
    } catch {
      setStatus([])
    }
  }, [])

  // 选中版本变化 → 重载状态与内容
  useEffect(() => {
    if (!sel) {
      setStatus([])
      setBundle(null)
      return
    }
    let alive = true
    void (async () => {
      await loadStatus(sel)
      if (!alive) return
    })()
    return () => {
      alive = false
    }
  }, [sel, loadStatus])

  // 版本内容（技能包清单，供技能查重与安装面板用）
  useEffect(() => {
    if (!sel || !be.IS_TAURI) {
      setBundle(null)
      return
    }
    let alive = true
    void (async () => {
      try {
        const { manifest } = await be.profileGet(sel.id)
        // 复用 version_bundle：构造临时 spec。
        // 必须剔除 dir 型（第三方文件夹对）—— 它是目录不是提示词落点，
        // 而且后端 WriteMode 用它当哨兵；混进来会让整条命令反序列化失败。
        const all = ((manifest.injectTargets as unknown[]) ?? []) as Array<{ mode?: string }>
        const spec = {
          id: sel.client,
          name: sel.label,
          legacyScript: '',
          versions: [],
          injectTargets: all.filter((t) => t.mode !== 'dir'),
          skillSync: manifest.skillSync ?? [],
          moduleSync: manifest.moduleSync,
        }
        const ver = {
          id: sel.id,
          label: sel.label,
          desc: sel.desc,
          file: sel.promptFile,
          recommended: sel.recommended,
          // 技能组：新字段优先，老 assetPack 兜底
          skillPacks: sel.skillPacks.length
            ? sel.skillPacks
            : (manifest.skills as { assetPack?: string } | null)?.assetPack
              ? [(manifest.skills as { assetPack: string }).assetPack]
              : [],
        }
        const b = await be.versionBundle(spec, ver)
        if (!alive) return
        setBundle(b)
        // 勾选状态不在这里重置：与「技能库」页共用 store 里的 skillPick（缺省=全勾选），
        // 用户在技能库页取消过的技能，这里也保持取消，不会被重扫覆盖。
      } catch (e) {
        pushLog(`[profiles] 读取版本内容失败：${String(e)}`, 'err')
      }
    })()
    return () => {
      alive = false
    }
  }, [sel, pushLog])

  /**
   * 构造安装的待办清单（key 必须与后端 emit 的完全一致，否则点不亮）。
   *
   * 后端 install 的 key 规则：
   *   "prompt"              提示词解析
   *   "target:<manifest里的 path>"   每个提示词落点
   *   "skill:<包名>"        每个技能包（模块库随包一起复制，不单列）
   *   "third:<dest>"        每条第三方（**最后一步**执行）
   * 这里全部按同样的规则生成，所以弹窗一挂载就能画出完整列表。
   *
   * 顺序与后端一致：提示词 → 技能 → 第三方。
   *
   * 写成纯函数（参数显式传入）是为了让「切换预设后立刻点安装」也能
   * 现场用刚读到的 manifest 算一份，不必等 state 更新。
   */
  const buildInstallPlanFrom = useCallback(
    (
      targets: Array<{ path?: string; mode?: string; label?: string }>,
      packs: string[],
    ) => {
      const out: { key: string; label: string }[] = [{ key: 'prompt', label: '读取提示词' }]
      for (const t of targets) {
        if (String(t.mode ?? '') === 'dir') continue
        out.push({ key: `target:${t.path}`, label: `提示词 → ${t.path}` })
      }
      for (const id of packs) {
        out.push({ key: `skill:${id}`, label: `技能包 ${id}（含模块库）` })
      }
      // 第三方排在最后：包套包时先铺好内层，再放外层
      for (const t of targets) {
        if (String(t.mode ?? '') !== 'dir') continue
        const who = String(t.label ?? '').trim() || '第三方'
        out.push({ key: `third:${t.path}`, label: `第三方「${who}」→ ${t.path}` })
      }
      return out
    },
    [],
  )


  const doInstall = async () => {
    if (!sel) return
    setBusy(true)
    setOpKind('install')

    /**
     * 总是先拉一次新鲜 manifest —— 安装的全部输入以磁盘上的声明为准。
     *
     * 组件里的 sel.skillPacks / packPick 都可能是过期快照：
     * profiles 列表是页面加载时扫的，packPick 是用户点芯片那一刻定格的。
     * manifest（skillPacks）是唯一权威，任何时刻与它冲突的旧数据都必须让位，
     * 否则已从声明里删掉的包会被 skillPacksOverride 整表覆盖着无声装回。
     */
    let declaredPacks: string[] = []
    let manifestTargetsFresh = manifestTargets
    try {
      const { manifest } = await be.profileGet(sel.id)
      // 新字段 skillPacks 优先；老字段 skills.assetPack 兜底 —— 与后端
      // effective_skill_packs 保持同一套解析规则。
      const legacy = manifest.skills as { assetPack?: string } | null | undefined
      declaredPacks =
        (manifest.skillPacks as string[] | undefined) ??
        (legacy?.assetPack ? [legacy.assetPack] : [])
      manifestTargetsFresh = ((manifest.injectTargets as unknown[]) ?? []) as Array<{
        path?: string
        mode?: string
        label?: string
      }>
      setManifestTargets(manifestTargetsFresh)
    } catch {
      /* 读不到 manifest：退回组件内的声明快照，至少不让按钮直接失效 */
      declaredPacks = sel.skillPacks ?? []
    }

    /**
     * 剪枝 override：只保留 manifest 仍声明的包。
     *   · packPick = null（没动过芯片）→ 不传，后端按 manifest 装
     *   · 动过 → 保留「取消勾选」语义（差集仍是声明的子集），
     *     丢掉声明已删除的幻影包；剪完为空就传 []（后端语义：一个都不装）
     */
    const overridePacks = packPick
      ? packPick.filter((id) => declaredPacks.includes(id))
      : null

    /** 计划清单与后端同源：都按「新鲜声明 + 剪枝结果」算，展示与行为永远一致 */
    const planPacks: string[] = overridePacks ?? declaredPacks
    const plan = buildInstallPlanFrom(manifestTargetsFresh, planPacks)
    setProgPlan(plan)
    // 打开进度弹窗（完成后会停在结果页，由用户关闭）
    setProgOpen(true)
    /**
     * 让出一帧再调用后端 —— 修「第一个事件丢失」的竞态。
     * 弹窗是 React 异步挂载的：setProgOpen(true) 之后组件还没渲染完，
     * 而它内部的 `inject:progress` 监听器要等 effect 跑起来才挂上。
     * 后端第一步「解析提示词」几乎瞬间就发事件，赶在监听器之前 ——
     * 于是那行永远收不到结果，最后被兜底成「无需处理」（实测就是这样）。
     *
     * 等两帧（requestAnimationFrame 嵌套）确保弹窗已挂载并挂好监听器，
     * 再真正发起安装。这点延迟（约 32ms）用户无感。
     */
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    )
    try {
      /**
       * 提示词来源：提示词组多选一（默认第一份）。
       * 传绝对路径，后端不再自己按目录猜。
       */
      const chosenPrompt = sel.prompts[Math.min(promptIdx, Math.max(0, sel.prompts.length - 1))]
      const cf = chosenPrompt ? (chosenPrompt.asset ?? chosenPrompt.file ?? chosenPrompt.path ?? null) : null
      /**
       * 勾选 → skillFilter：把勾上的技能名交给后端做「只装这些」。
       *   · 全勾 → null（不传名单，走最快路径）
       *   · 全不选 → []（后端据此装 0 个，别再被当成「全部」）
       *   · 部分勾 → 勾选名单
       *
       * 关键：名单必须只含**会被装的包**（effectivePacks）里的技能。
       * 早先用 allSkills（bundle 里全部包）过滤，被取消的包也被算进名单，
       * 而后端 sync_skills 是按名字匹配的 —— 名单里没有的技能一律不装，
       * 于是「取消 A 包」会把 B 包里同名的技能也一并拦掉，属于静默漏装。
       */
      let filter: string[] | null = null
      if (withSkills && allSkills.length > 0) {
        // 底表用 planPacks（新鲜声明 + 剪枝），不能用 effectivePacks ——
        // 后者可能还带着过期快照里已被 manifest 删掉的包
        const enabled = new Set(planPacks)
        const inScope = allSkills.filter((s) => enabled.has(s.packId))
        const on = inScope.filter((s) => isSkillOn(skillPick, s.packId, s.name)).map((s) => s.name)
        if (on.length !== inScope.length) filter = on
      }
      /**
       * 技能组 → 实际要装的包：
       *   · packPick 为 null（没动过）= 不传，用预设声明的技能组
       *   · 动过 = 传剪枝后的 overridePacks（含取消预设包的情况，
       *     但绝不含 manifest 已删除的包 —— 那是这次 bug 的根因）
       *
       * skillSourceMap（第 7 个参数）= 重名技能的来源选择。
       * 必须传 —— 后端逐个包遍历，重名技能会在多个包里都存在；
       * 不带这张表就会把两份都装进去（后者覆盖前者），
       * 用户在「技能库」弹窗里选的来源等于白选。
       */
      const rep = await be.profileInstall(
        sel.id,
        cf,
        promptIdx,
        withSkills,
        filter,
        overridePacks,
        Object.keys(pickDup).length ? pickDup : null,
      )
      for (const s of rep.steps) pushLog(`[inject] ${s}`, 'info')
      if (rep.ok) {
        pushLog(
          `[inject] 完成：技能 ${rep.skillsInstalled.length} 个（跳过 ${rep.skillsSkipped}）`,
          'ok',
        )
        toast('注入完成', 'ok')
      } else {
        pushLog(`[inject] 失败：${rep.error}`, 'err')
        toast(`注入失败：${rep.error}`, 'bad')
      }
      // 安装后立刻重拉落点状态：早先只刷新清单（refresh），
      // 右下角弹「注入完成」而右侧状态还是旧的 —— 用户看到的就是「状态不刷新」。
      if (sel) await loadStatus(sel)
      // 左栏/顶部的「已注入/未注入」也要跟着更新
      void reloadClients()
    } catch (e) {
      pushLog(`[inject] 调用失败：${String(e)}`, 'err')
      toast('后端不可用', 'warn')
    } finally {
      setBusy(false)
      if (sel) void refresh()
    }
  }

  const doUninstall = () => {
    if (!sel) return
    setOpKind('uninstall')
    /**
     * 卸载的待办清单 —— 顺序必须与后端执行顺序一致。
     *
     * 后端是「后进先出」，与安装顺序（提示词 → 技能 → 第三方）完全相反：
     *   **提示词文件 → 技能 → 第三方**
     * 先还原提示词、再清技能、最后清第三方。
     * 这样同目录场景（第三方落点 == 技能落点）不会互相误删：
     * 技能先只删自己的技能目录，第三方再只删自己放进去的条目。
     */
    const live = status.filter((s) => s.ok || s.injected)
    const order = (k: string) => (k === 'prompt' ? 0 : k === 'skills' ? 1 : 2)
    setProgPlan(
      [...live]
        .sort((a, b) => order(a.kind) - order(b.kind))
        .map((s) => ({
          key:
            s.kind === 'prompt'
              ? `file:${s.path}`
              : s.kind === 'thirdParty'
                ? `third:${s.path}`
                : s.kind,
          label:
            s.kind === 'prompt'
              ? `移除 ${s.path}`
              : s.kind === 'skills'
                ? '清理技能'
                : `移除第三方 ${s.path}`,
        })),
    )
    setProgOpen(true)
    confirm(
      `卸载「${sel.label}」？将删除注入内容并把原文件（含原技能目录）从 -bak 改回原名。` +
        `若你改过注入后的文件，会按字节数比对识别并保留不动。`,
      async () => {
        setBusy(true)
        /**
         * 与安装侧同理：先让弹窗挂载好监听器，再发起卸载。
         * 卸载第一步（清第三方）也可能瞬间发事件，否则那行会丢。
         */
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        )
        try {
          const { manifest } = await be.profileGet(sel.id)
          const all = ((manifest.injectTargets as unknown[]) ?? []) as Array<{
            mode?: string
            path?: string
          }>
          const rep = await be.injectUninstall(
            {
              id: sel.client,
              name: sel.label,
              legacyScript: '',
              versions: [],
              // dir 型是第三方文件夹对，不是提示词落点 —— 与安装侧保持同一套拆分
              injectTargets: all.filter((t) => t.mode !== 'dir'),
              skillSync: (manifest.skillSync as unknown[]) ?? [],
              moduleSync: (manifest.moduleSync as string | undefined) ?? null,
              thirdParty: [],
            },
            true,
          )
          for (const s of rep.steps) pushLog(`[inject] ${s}`, 'info')
          if (rep.ok) {
            toast('已卸载还原', 'warn')
          } else {
            pushLog(`[inject] 卸载有未处理项：${rep.error}`, 'err')
            toast(`卸载未完全成功：${rep.error}`, 'bad')
          }
          await loadStatus(sel)
          // 左栏/顶部的「已注入/未注入」也要跟着更新
          void reloadClients()
        } catch (e) {
          toast(`卸载失败：${String(e)}`, 'bad')
        } finally {
          setBusy(false)
          void refresh()
        }
      },
    )
  }

  // ---------- 编辑器素材库：提示词组 ----------
  useEffect(() => {
    if (!editor || !be.IS_TAURI) return
    let alive = true
    void (async () => {
      try {
        const ps = await be.scanPrompts()
        if (alive) setPromptLib(ps)
      } catch {
        /* 读不到就留空，编辑器仍可用 */
      }
    })()
    return () => {
      alive = false
    }
  }, [editor])

  /** 提示词条目的稳定 key（用于判断是否已勾选） */
  const promptKeyOf = (p: { asset?: string | null; file?: string | null; path?: string | null }) =>
    p.asset || p.path || p.file || ''

  /** 提示词库条目 → manifest.prompts 条目 */
  const itemToPrompt = (
    it: PromptItemDto,
  ): { name: string; asset?: string; file?: string; path?: string } => {
    // source 是「_assets/prompts」「.codex/prompts」这类标签；优先用 asset 相对路径
    const rel = it.path.includes('_assets')
      ? it.path.split('_assets')[1].replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : ''
    return rel
      ? { name: it.file, asset: rel }
      : { name: it.file, path: it.path }
  }

  /** 当前编辑器里已选的提示词组 */
  const editorPrompts = useMemo(() => {
    const arr = (editor?.manifest.prompts as Record<string, unknown>[] | undefined) ?? []
    if (arr.length) return arr as { name?: string; asset?: string; file?: string; path?: string }[]
    // 兼容老 manifest：没有 prompts 时用 prompt 单份兜底显示
    const one = editor?.manifest.prompt as { asset?: string; file?: string; path?: string } | undefined
    return one && promptKeyOf(one) ? [{ name: (one.asset || one.file || one.path || '').split('/').pop(), ...one }] : []
  }, [editor])

  /**
   * 当前编辑器里已选的技能包。
   *
   * 关键：读的时候要和老字段统一 —— 老 manifest 只写 skills.assetPack。
   * 之前「显示读老字段、勾选写新数组」两套基准不一致，点一下就丢老值，
   * 于是 codex-pro 被写成 skillPacks:[122,12]（它真正的包是 codex-skills-pro-v1）。
   * 现在读写都走这个函数，基准永远一致。
   */
  const editorPacks = useMemo(() => {
    const arr = (editor?.manifest.skillPacks as string[] | undefined) ?? []
    if (arr.length) return arr
    const legacy = (editor?.manifest.skills as { assetPack?: string } | undefined)?.assetPack
    return legacy ? [legacy] : []
  }, [editor])

  /** 写入技能组：同时更新新数组与老字段，避免任一侧读到旧值 */
  const writePacks = (s: NonNullable<typeof editor>, next: string[]) => {
    const first = next[0]
    return {
      ...s,
      manifest: {
        ...s.manifest,
        skillPacks: next,
        // 保留老字段并与新值保持一致（外部脚本/回滚路径仍可能读它）
        skills: first ? { ...((s.manifest.skills as object) ?? {}), assetPack: first } : null,
      },
    }
  }

  /** 提示词注入位置（injectTargets 里非 dir 的） */
  const promptTargets = useMemo(
    () =>
      ((editor?.manifest.injectTargets as Record<string, unknown>[]) ?? []).filter(
        (t) => String(t.mode ?? '') !== 'dir',
      ),
    [editor],
  )

  /** 技能注入位置（skillSync） */
  const skillTargets = useMemo(
    () => ((editor?.manifest.skillSync as Record<string, unknown>[]) ?? []),
    [editor],
  )

  /** 写回 injectTargets：promptTargets 是过滤后的视图，合并时要保住 dir 型项 */
  const commitTargets = (
    nextPrompt: Record<string, unknown>[],
    manifest: Record<string, unknown>,
  ): Record<string, unknown> => {
    const dirs = ((manifest.injectTargets as Record<string, unknown>[]) ?? []).filter(
      (t) => String(t.mode ?? '') === 'dir',
    )
    return { ...manifest, injectTargets: [...nextPrompt, ...dirs] }
  }

  const updateTarget = (view: Record<string, unknown>[], i: number, patch: Record<string, unknown>) => {
    setEditor((s) => {
      if (!s) return s
      const next = view.map((t, j) => (j === i ? { ...t, ...patch } : t))
      return { ...s, manifest: commitTargets(next, s.manifest) }
    })
  }

  const removeTarget = (view: Record<string, unknown>[], i: number) => {
    setEditor((s) => {
      if (!s) return s
      const next = view.filter((_, j) => j !== i)
      return { ...s, manifest: commitTargets(next, s.manifest) }
    })
  }

  const addTarget = (kind: 'prompt') => {
    void kind
    setEditor((s) => {
      if (!s) return s
      const next = [...promptTargets, { path: '', fileName: 'AGENTS.md' }]
      return { ...s, manifest: commitTargets(next, s.manifest) }
    })
  }

  const updateSkillSync = (i: number, dest: string) => {
    setEditor((s) => {
      if (!s) return s
      const arr = [...((s.manifest.skillSync as Record<string, unknown>[]) ?? [])]
      arr[i] = { ...arr[i], dest }
      return { ...s, manifest: { ...s.manifest, skillSync: arr } }
    })
  }

  const removeSkillSync = (i: number) => {
    setEditor((s) => {
      if (!s) return s
      const arr = ((s.manifest.skillSync as Record<string, unknown>[]) ?? []).filter((_, j) => j !== i)
      return { ...s, manifest: { ...s.manifest, skillSync: arr } }
    })
  }

  const addSkillSync = () => {
    setEditor((s) => {
      if (!s) return s
      const arr = [...((s.manifest.skillSync as Record<string, unknown>[]) ?? []), { dest: '' }]
      return { ...s, manifest: { ...s.manifest, skillSync: arr } }
    })
  }

  /**
   * 当前编辑器所属客户端的工作路径。
   *
   * 所有「打开资源管理器」的按钮都用它作初始目录 ——
   * 用户明确要求「默认打开界面为当前客户端工作路径，不用再繁琐地从 C 盘或其他盘点」。
   * 取不到时返回 undefined，对话框退回系统默认位置。
   */
  const clientWorkDir = useMemo(() => {
    const c = String(editor?.manifest.client ?? '')
    return clients.find((x) => x.id === c)?.workDir || undefined
  }, [clients, editor])

  /**
   * `_assets/other/` 的绝对路径 —— 第三方素材（云记忆等）的约定存放处。
   * 用户在这里自建文件夹放云记忆文件，预设组按「第三方文件」引用它。
   * 选源对话框默认从这里打开，省得用户去翻 _assets。
   */
  const [otherDir, setOtherDir] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!be.IS_TAURI) return
    let alive = true
    void (async () => {
      try {
        const root = await be.runtimeRoot()
        if (alive && root) setOtherDir(`${root.replace(/[\\/]+$/, '')}\\_assets\\other`)
      } catch {
        /* 取不到就让对话框用系统默认位置 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /**
   * 资源管理器选**文件** → 填进提示词注入位置。
   *
   * 提示词落点是文件（~/.codex/AGENTS.md），早先这里调的是选文件夹的
   * pickOneFolder，弹出来的是「选择文件夹」对话框 —— 用户根本选不到文件。
   * 现在走选文件对话框；文件还不存在时用 fileName 作默认名，
   * 用户可以在目标目录里直接确认新建。初始目录 = 客户端工作路径。
   */
  const pickFileInto = async (view: Record<string, unknown>[], i: number, fileName: string) => {
    try {
      const f = await be.pickOneFile('选择提示词注入文件（写入这个文件）', fileName, clientWorkDir)
      if (!f) return
      updateTarget(view, i, { path: f })
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  /** 资源管理器选文件夹 → 填进技能注入位置 */
  const pickFolderIntoSkillSync = async (i: number) => {
    try {
      const dir = await be.pickOneFolder('选择技能注入位置（技能目录将复制到这里）', clientWorkDir)
      if (!dir) return
      updateSkillSync(i, dir)
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  const toggleEditorPrompt = (it: PromptItemDto) => {
    setEditor((s) => {
      if (!s) return s
      const cur = ((s.manifest.prompts as Record<string, unknown>[]) ?? []).slice()
      const key = promptKeyOf(itemToPrompt(it))
      const idx = cur.findIndex((p) => promptKeyOf(p as { asset?: string }) === key)
      if (idx >= 0) cur.splice(idx, 1)
      else cur.push(itemToPrompt(it))
      // 同步 prompt 单份字段：老引擎与回退路径都读它
      const first = cur[0] as { asset?: string; file?: string; path?: string } | undefined
      return {
        ...s,
        manifest: {
          ...s.manifest,
          prompts: cur,
          prompt: first ? { asset: first.asset, file: first.file, path: first.path } : s.manifest.prompt,
        },
      }
    })
  }

  const toggleEditorPack = (id: string) => {
    setEditor((s) => {
      if (!s) return s
      // 以 editorPacks（含老字段回退）为基准，避免丢掉老定义
      const cur = editorPacks.slice()
      const i = cur.indexOf(id)
      if (i >= 0) cur.splice(i, 1)
      else cur.push(id)
      return writePacks(s, cur)
    })
  }

  /** 第三方文件夹对：源目录 → 注入目录。
   *  存进 injectTargets 的 dir 型条目（path=注入目录, sourceDir=源目录）。
   *  后端 manifest_to_spec 把它摘成 ClientSpec.thirdParty，
   *  安装时由 copy_dir_merge 整包原样复制到注入目录 —— 不参与提示词注入。 */
  const thirdPartyPairs = useMemo(
    () =>
      ((editor?.manifest.injectTargets as Record<string, unknown>[]) ?? []).filter(
        (t) => String(t.mode ?? '') === 'dir',
      ),
    [editor],
  )

  const commitThirdParty = (s: NonNullable<typeof editor>, next: Record<string, unknown>[]) => {
    const prompt = ((s.manifest.injectTargets as Record<string, unknown>[]) ?? []).filter(
      (t) => String(t.mode ?? '') !== 'dir',
    )
    return { ...s, manifest: { ...s.manifest, injectTargets: [...prompt, ...next] } }
  }

  const updateThirdParty = (i: number, patch: Record<string, unknown>) => {
    setEditor((s) => {
      if (!s) return s
      const next = thirdPartyPairs.map((t, j) => (j === i ? { ...t, ...patch } : t))
      return commitThirdParty(s, next)
    })
  }

  const removeThirdParty = (i: number) => {
    setEditor((s) => {
      if (!s) return s
      return commitThirdParty(
        s,
        thirdPartyPairs.filter((_, j) => j !== i),
      )
    })
  }

  const addThirdParty = () => {
    setEditor((s) => {
      if (!s) return s
      const next = [...thirdPartyPairs, { path: '', mode: 'dir', sourceDir: '', kind: 'auto' }]
      return commitThirdParty(s, next)
    })
  }

  /**
   * 用 **Windows 资源管理器**选第三方**源文件夹**。
   *
   * 为什么分两个按钮而不是一个：Windows 原生对话框的「选文件夹」模式
   * （FOS_PICKFOLDERS）和「选文件」模式互斥，**无法在一个窗口里同时选两者**。
   * 所以给两个明确按钮，用户点哪个就是哪个 —— 比「先弹文件夹、取消再弹文件」
   * 那种连续弹窗清楚得多。
   *
   * 初始目录固定为 _assets/other（第三方素材约定存放处）。
   */
  const pickThirdPartySourceDir = async (i: number) => {
    try {
      const dir = await be.pickOneFolder('选择第三方源文件夹', otherDir)
      if (!dir) return
      updateThirdParty(i, { sourceDir: dir, kind: 'dir' })
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  /** 用 **Windows 资源管理器**选第三方**源文件** */
  const pickThirdPartySourceFile = async (i: number) => {
    try {
      const f = await be.pickOneFile('选择第三方源文件', undefined, otherDir)
      if (!f) return
      updateThirdParty(i, { sourceDir: f, kind: 'file' })
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  /** 用 **Windows 资源管理器**选**落点文件夹**（会放到该目录下，保留源文件名） */
  const pickThirdPartyDestDir = async (i: number) => {
    try {
      const dir = await be.pickOneFolder('选择落点文件夹', clientWorkDir)
      if (!dir) return
      updateThirdParty(i, { path: dir })
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  /**
   * 用 **Windows 资源管理器**选**落点文件**。
   *
   * 落点常常还不存在（首次安装时的 ~/.workbuddy-ai/MEMORY.md），
   * 原生对话框里点不到它 —— 用户可以在对话框的文件名栏直接敲名字后确定。
   * 另外输入框本身也能手写路径。
   */
  const pickThirdPartyDestFile = async (i: number) => {
    try {
      const f = await be.pickOneFile('选择落点文件（可直接在文件名栏输入新名字）', undefined, clientWorkDir)
      if (!f) return
      updateThirdParty(i, { path: f })
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  /**
   * 新建预设：在**当前选中的客户端**下落一个空白预设组。
   *
   * 早先是写死落到 profiles/_custom/，还预填了一条空注入位置 ——
   * 结果用户一建就冒出一个「自定义版本 · 找不到提示词」的废条目。
   * 现在归属当前客户端（左栏选中的那个），字段全部留空由用户填，
   * 保存后才真正落盘。
   */
  const newCustom = () => {
    // 当前客户端 = 左栏选中的；没选中就取该栏第一个
    const client = activeTargetId || clients[0]?.id || 'codex'
    if (client === CUSTOM_TARGET_ID) {
      toast('请先在左侧选一个客户端（自定义分组不能挂预设组）', 'warn')
      return
    }
    const id = `${client}-custom-${Date.now().toString(36)}`
    setEditor({
      isNew: true,
      manifest: {
        id,
        client,
        label: '新预设',
        desc: '',
        recommended: false,
        prompts: [],
        skillPacks: [],
        injectTargets: [],
        skillSync: [],
        moduleSync: null,
      },
    })
    // 确保左栏停在当前客户端，保存后能立刻看到新条目
    setActiveTarget(client)
  }

  /**
   * 打开编辑：读回该版本的 manifest 填进表单。
   * 内置版本（_assets 引用）也能改 —— profile_save 对已存在的 id 就地更新，
   * 不会挪目录，所以改完仍指向原来的素材。
   */
  const editProfile = async (p: ProfileEntryDto) => {
    try {
      const { manifest } = await be.profileGet(p.id)
      setEditor({ isNew: false, manifest: manifest as Record<string, unknown> })
    } catch (e) {
      toast(`读取清单失败：${String(e)}`, 'bad')
    }
  }

  const saveEditor = async () => {
    if (!editor) return
    setBusy(true)
    try {
      const dir = await be.profileSave(editor.manifest, null)
      toast(`已保存到 ${dir}`, 'ok')
      setEditor(null)
      // 新建的归属当前客户端：把左栏切到那个客户端，否则刚建完看不到它。
      // 编辑已有版本时保持当前左侧目标，避免改个内置版本反被跳走。
      if (editor.isNew) {
        const c = String(editor.manifest.client ?? '')
        if (c) setActiveTarget(c)
      }
      void refresh()
    } catch (e) {
      toast(`保存失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  const delProfile = (p: ProfileEntryDto) => {
    confirm(
      `删除版本「${p.label}」？\n${p.custom ? '将同时删除它自己的目录（含其中的提示词与技能）' : '仅删除清单，_assets 素材保留'}`,
      async () => {
        try {
          await be.profileDelete(p.id, p.custom)
          toast('已删除', 'warn')
          if (selId === p.id) setSelId(null)
          void refresh()
        } catch (e) {
          toast(`删除失败：${String(e)}`, 'bad')
        }
      },
    )
  }

  /**
   * 技能查重：多个技能包里出现同名技能时，列出来让用户决定用哪一份。
   * pickDup 存「技能名 → 选中的包 id」，未选则默认取第一个包。
   *
   * **只核实真正会装的技能**，两层勾选都要过：
   *   1) 包级 —— effectivePacks 里没有这个包 → 整包跳过
   *   2) 技能级 —— isSkillOn 为 false 的单个技能 → 它不会装，也就不算冲突
   *
   * 少了第 2 层时：用户在技能库里单独取消掉某个技能，查重列表里
   * 那一项仍然算「重名」，得让用户白白选一次来源 —— 而那份根本不会装。
   * 早先只看包级，就是这个毛病。
   */
  const duplicates: SkillDuplicate[] = useMemo(() => {
    const enabled = new Set(effectivePacks)
    const packs = (bundle?.packs ?? [])
      .filter((p) => enabled.has(p.id))
      .map((p) => ({
        ...p,
        // 只把勾上的技能交给查重函数
        skills: p.skills.filter((s) => isSkillOn(skillPick, p.id, s.name)),
      }))
    return findSkillDuplicates(packs)
  }, [bundle, effectivePacks, skillPick])

  /** 技能 + 所属包（同一技能名可能出现在多个包里，筛选要按包区分） */
  const allSkills: (SkillItemDto & { packId: string })[] = useMemo(
    () => (bundle?.packs ?? []).flatMap((p) => p.skills.map((s) => ({ ...s, packId: p.id }))),
    [bundle],
  )
  /**
   * 实际会装的技能数。
   *
   * 必须同时看两层勾选：
   *   · 包级 —— effectivePacks 里没有这个包 → 整包跳过，里面技能全不算
   *   · 技能级 —— isSkillOn 的逐技能开关
   * 早先只看技能级，于是用户在弹窗里取消一个整包，数量纹丝不动（68/68），
   * 看起来像「没实时更新」。
   */
  const effectiveSkillCount = useMemo(() => {
    const enabled = new Set(effectivePacks)
    return allSkills.filter((s) => enabled.has(s.packId) && isSkillOn(skillPick, s.packId, s.name)).length
  }, [allSkills, effectivePacks, skillPick])
  const anyInjected = status.some((s) => s.injected)

  /**
   * 「技能库」弹窗：展开看本预设组勾选的技能包 + 重名技能怎么取。
   * 安装面板平时只显示芯片（一行放不下太多包），细节收到弹窗里。
   */
  const [skillDlg, setSkillDlg] = useState(false)

  return (
    <div className="page anim-page">
      <Topbar
        kicker="TARGETS / 目标"
        /*
         * 注入状态用**彩色实心标签**呈现。
         *
         * 早先写成一行灰字「注入状态：已注入（xxx）」，用户反馈
         * 「就一个干瘪的灰字，不明显」—— 已注入是本页最该一眼看到的状态，
         * 现在做成绿底白字（未注入为灰底）的胶囊标签 + 预设组名。
         */
        title={curLabel}
        subNode={
          curClientEntry ? (
            <span className="row gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`inject-pill${curClientEntry.injected ? ' on' : ''}`}>
                {curClientEntry.injected ? '已注入' : '未注入'}
              </span>
              {curClientEntry.injected && curClientEntry.installedLabel && (
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {curClientEntry.installedLabel}
                </span>
              )}
              <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>
                · {shownProfiles.length} 个预设组
              </span>
            </span>
          ) : (
            <>{shownProfiles.length} 个版本</>
          )
        }
        actions={
          <>
            {/* 「已读磁盘」与「当前预设组：已注入」两个绿色徽章已删除 ——
                用户反馈「太丑」，且与副标题里的注入状态重复。
                副标题现在用醒目的彩色标签承载这个信息。 */}
            <button className="btn" data-tour="targets.actions" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={13} /> {loading ? '扫描中…' : '重新扫描'}
            </button>
            {sel && anyInjected && (
              <button className="btn btn-danger" disabled={busy} onClick={doUninstall}>
                {busy && opKind === 'uninstall' ? '还原中…' : (
                  <>
                    <RotateCcw size={13} /> 卸载还原
                  </>
                )}
              </button>
            )}
            <button className="btn btn-primary" onClick={newCustom}>
              <Plus size={13} /> 新建预设组
            </button>
          </>
        }
      />

      {profiles.length === 0 ? (
        <div className="page-body">
          <EmptyState
            icon={<Package size={34} />}
            title={loading ? '扫描中…' : '未发现版本清单'}
            hint="检查 resources/profiles/ 下是否有 <客户端>/<版本>/manifest.json"
          />
        </div>
      ) : (
        <div className="page-body tgt-workspace">
          {/* ========== 左：当前目标的版本清单（随左侧目标栏切换） ========== */}
          <div className="tgt-col">
            <div className="glass glass-iridescent glass-pad tgt-card" data-tour="targets.profiles">
              <div className="panel-head">
                <span className="kicker">PROFILES / {shownProfiles.length}</span>
                <span className="badge badge-neutral">{curLabel}</span>
              </div>
              <div className="tgt-scroll">
                {shownProfiles.length === 0 ? (
                  <div className="sub" style={{ padding: '8px 4px' }}>
                    {be.IS_TAURI
                      ? `「${curLabel}」下还没有版本清单，可用「新建预设组」加一个。`
                      : '浏览器预览无法读磁盘'}
                  </div>
                ) : (
                  shownProfiles.map((p) => (
                    <div
                      key={p.id}
                      data-tour={p.id === shownProfiles[0]?.id ? 'targets.profile-first' : undefined}
                      className={`card-row${selId === p.id ? ' selected' : ''}`}
                      onClick={() => {
                        setSelId(p.id)
                        // 默认落在「第一份能解析到的」提示词上（后端算好的索引）
                        setPromptIdx(p.defaultPromptIndex ?? 0)
                        if (p.client && p.client !== '_custom') setActiveTarget(p.client)
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row gap" style={{ alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 800, fontSize: 12.5 }}>{p.label}</span>
                          {p.custom && <span className="badge badge-neutral">自定义</span>}
                          {/*
                            警告图标：鼠标停留显示具体原因。
                            用 portal 气泡（WarnTip）而不是纯 CSS absolute ——
                            卡片列表的祖先有 overflow，absolute 气泡会被裁掉。
                          */}
                          {!p.promptOk && (
                            <WarnTip>
                              <b>提示词文件缺失</b>
                              <br />
                              {p.promptItems.some((it) => !it.ok)
                                ? p.promptItems.map((it, i) =>
                                    it.ok ? null : (
                                      <span key={i}>
                                        第 {i + 1} 份：{it.key}
                                        <br />
                                      </span>
                                    ),
                                  )
                                : p.promptFile || '（未配置提示词）'}
                              <span style={{ opacity: 0.75 }}>
                                把文件补到 _assets/ 下，或在「编辑预设组」里换一份。
                              </span>
                            </WarnTip>
                          )}
                        </div>
                        <div className="sub" style={{ fontSize: 11 }}>{p.desc}</div>
                        {/* 预设 = 提示词 + 技能库 的组合，这里直观展示两个来源 */}
                        <div className="preset-pair">
                          <span className="preset-part" title={p.promptFile}>
                            <FileText size={9} />
                            {p.promptFile.split('/').pop() || '无提示词'}
                          </span>
                          <span className="preset-plus">+</span>
                          {p.skillsOk ? (
                            <span className="preset-part" title={p.skillsDir ?? ''}>
                              <Package size={9} />
                              {p.skillsDir?.split('\\').slice(-2)[0] ?? '技能库'} · {p.skillCount}
                            </span>
                          ) : (
                            <span className="preset-part dim">不装技能</span>
                          )}
                        </div>
                      </div>
                      <div className="rail-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          title="编辑这个预设组"
                          onClick={(e) => {
                            e.stopPropagation()
                            void editProfile(p)
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          title="删除这个版本"
                          onClick={(e) => {
                            e.stopPropagation()
                            delProfile(p)
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* ========== 中：安装 ========== */}
          <div className="tgt-col">
            {!sel ? (
              <div className="glass glass-iridescent glass-pad tgt-card">
                <EmptyState icon={<Info size={30} />} title="选择左侧版本" hint="查看它的注入点与内容" />
              </div>
            ) : (
              <div className="glass glass-iridescent glass-pad tgt-card sticky">
                <div className="panel-head">
                  <div className="panel-kicker">
                    <span className="kicker">INSTALL / 安装</span>
                    <div className="row gap" style={{ alignItems: 'baseline' }}>
                      <h2 className="h2">{sel.label}</h2>
                      <span className="badge badge-neutral">
                        已勾选 {effectiveSkillCount}/{allSkills.length}
                      </span>
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => void be.profileOpenDir(sel.id)}>
                    <FolderOpen size={12} />
                  </button>
                </div>

                {/* 提示词组多选一：预设组挂了多份提示词时，注入前选一份 */}
                {/*
                  提示词组多选一：预设组挂了多份提示词时，注入前选一份。
                  缺失的那几份标红 —— 否则用户点了一份不存在的，安装时才报错。
                */}
                {sel.prompts.length > 1 && (
                  <div style={{ marginBottom: 12 }}>
                    <span className="kicker">PROMPTS / 提示词组（多选一）</span>
                    <div className="skill-chips" style={{ marginTop: 6 }}>
                      {sel.prompts.map((p, i) => {
                        const st = sel.promptItems[i]
                        const bad = st ? !st.ok : false
                        return (
                          <button
                            key={i}
                            className={`chip${promptIdx === i ? ' chip-on' : ''}${bad ? ' chip-bad' : ''}`}
                            title={
                              (p.asset ?? p.path ?? p.file ?? '') +
                              (bad ? '（文件不存在）' : '')
                            }
                            onClick={() => setPromptIdx(i)}
                          >
                            {bad && <AlertTriangle size={10} style={{ verticalAlign: '-1px', marginRight: 3 }} />}
                            {p.name || (p.asset ?? p.file ?? p.path ?? '').split('/').pop()}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/*
                  提示词状态：按**当前选中的那一份**显示存在性。
                  早先这里用的是整组的 promptOk（任意一份能解析就算 true），
                  而路径显示的是第一份 —— 于是 codex-pro 出现
                  「路径写 prompts/破甲助手专业版v1.md（缺失）、状态却写文件存在」，
                  因为组里第 3 份恰好存在。两者必须取自同一条记录。
                */}
                <div className="cfg-row" data-tour="targets.prompt">
                  <div className="cfg-copy">
                    <div className="cfg-title">提示词</div>
                    <div className="cfg-desc mono" style={{ fontSize: 10.5 }}>
                      {(() => {
                        const it = sel.promptItems[promptIdx]
                        if (it) return it.key || '（未配置）'
                        const p = sel.prompts[promptIdx]
                        return p ? (p.asset ?? p.file ?? p.path ?? '（未配置）') : sel.promptFile || '（未配置）'
                      })()}
                    </div>
                    {(() => {
                      const it = sel.promptItems[promptIdx]
                      return it?.ok && it.resolved && it.resolved !== it.key ? (
                        <div className="cfg-desc mono" style={{ fontSize: 9.5, color: 'var(--faint)' }}>
                          实际路径 {it.resolved}
                        </div>
                      ) : null
                    })()}
                  </div>
                  {(() => {
                    const it = sel.promptItems[promptIdx]
                    const ok = it ? it.ok : sel.promptOk
                    return (
                      <span className={`badge ${ok ? 'badge-ok' : 'badge-bad'}`}>
                        {ok ? '文件存在' : '找不到'}
                      </span>
                    )
                  })()}
                </div>

                <div className="cfg-row" data-tour="targets.skills">
                  <div className="cfg-copy">
                    <div className="cfg-title">技能库</div>
                    <div className="cfg-desc">
                      {sel.skillsOk
                        ? `已勾选 ${effectiveSkillCount} / ${allSkills.length} 个技能`
                        : '本预设组未声明技能组'}
                    </div>
                  </div>
                </div>

                {/*
                  技能库芯片：只显示本预设组勾选的技能包（没勾的就不显示），
                  避免一次铺开整个技能库。芯片本身就是开关，点一下可跳过。
                */}
                {presetPacks.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div className="row gap" style={{ alignItems: 'center' }}>
                      <span className="kicker" style={{ flex: 1 }}>
                        SKILLS / 本预设组技能（可取消勾选）
                      </span>
                      {/* 打开弹窗：重名技能怎么取、逐包细节都在里面 */}
                      <button
                        className="btn btn-sm"
                        title="打开技能库：重名技能选择、逐包技能明细"
                        onClick={() => setSkillDlg(true)}
                      >
                        <Package size={12} /> 技能库
                        {duplicates.length > 0 && (
                          <span className="badge badge-accent" style={{ marginLeft: 5 }}>
                            重名 {duplicates.length}
                          </span>
                        )}
                      </button>
                    </div>
                    <div className="skill-chips" style={{ marginTop: 6 }}>
                      {presetPacks.map((p) => {
                        const on = effectivePacks.includes(p.id)
                        return (
                          <button
                            key={p.id}
                            className={`chip${on ? ' chip-on' : ''}`}
                            title={`${p.skills.length} 技能`}
                            onClick={() => togglePack(p.id)}
                          >
                            {p.id}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/*
                  激活词已按用户要求**整体移除**（黄色标签不要再出现）。
                  它是历史提示词体系的概念，与当前注入链路无关，显示出来
                  只会让界面多一个没人用的黄块。
                */}

                <div className="cfg-row">
                  <div className="cfg-copy">
                    <div className="cfg-title">清单目录</div>
                    <div className="cfg-desc mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>{sel.dir}</div>
                  </div>
                </div>

                {/*
                  安装按钮只按**当前选中那份**提示词是否可用来启用。
                  早先用整组 promptOk：第一份缺文件时按钮仍然可点，
                  点下去后端报「找不到提示词文件」—— 现在直接禁用并说明原因。
                */}
                {(() => {
                  const cur = sel.promptItems[promptIdx]
                  const curOk = cur ? cur.ok : sel.promptOk
                  return (
                    <>
                      <button
                        className="btn btn-primary"
                        data-tour="targets.install-btn"
                        style={{ width: '100%', marginTop: 14, padding: '10px 0' }}
                        disabled={busy || !curOk}
                        onClick={() => void doInstall()}
                      >
                        {busy && opKind === 'install' ? '注入中…' : `安装 ${sel.label}`}
                      </button>
                      {!curOk && (
                        <div
                          className="sub"
                          style={{ fontSize: 10.5, marginTop: 8, textAlign: 'center', color: 'var(--bad)' }}
                        >
                          选中的提示词文件不存在：{cur?.key || sel.promptFile}
                          <br />
                          换一份（上面带红色警告的芯片），或到「提示词」页补上这个文件。
                        </div>
                      )}
                    </>
                  )
                })()}
                <div className="sub" style={{ fontSize: 10.5, marginTop: 8, textAlign: 'center' }}>
                  注入前自动备份 · 原文件改名为 -bak · 卸载时还原
                </div>
              </div>
            )}
          </div>

          {/* ========== 右：注入点 + 版本内容 ========== */}
          <div className="tgt-col">
            <div className="glass glass-iridescent glass-pad tgt-card" data-tour="targets.points">
              <div className="panel-head">
                {/*
                  标题改成**纯文字**，不再是可点击的折叠开关。
                  用户反馈那个箭头「多余」——注入位置是本面板的主内容，
                  没必要折叠；「内容」视图（提示词正文 + 逐技能勾选）
                  改成右侧一个明确的按钮，语义比「点标题切换」清楚。
                */}
                <div className="panel-kicker">
                  <span className="kicker">POINTS / 注入位置 {status.length}</span>
                </div>
              </div>

              <div className="tgt-scroll">
                {/* 注入位置：提示词 / 技能 / 第三方 三类落点。
                    「内容」视图（提示词正文预览 + 逐技能勾选）已按用户要求移除 ——
                    这里只做落点状态展示，不再内嵌预览。 */}
                {status.length === 0 ? (
                  <div className="sub">{be.IS_TAURI ? '正在读取…' : '浏览器预览无法读磁盘'}</div>
                ) : (
                  <>
                    <div className="row gap" style={{ marginBottom: 8 }}>
                      <button
                          className="btn btn-ghost btn-sm"
                          disabled={loading}
                          onClick={() => void refresh()}
                        >
                          <RefreshCw size={11} /> 刷新状态
                        </button>
                      </div>
                      {status.map((s, i) => {
                        const isDir = s.kind !== 'prompt'
                        const okLabel = !s.ok
                          ? isDir
                            ? '未落盘'
                            : '未注入'
                          : s.kind === 'skills'
                            ? '已装技能'
                            : s.kind === 'thirdParty'
                              ? '已放置'
                              : '已注入'
                        return (
                          <div key={i} className="inj-point">
                            <div className="inj-point-head">
                              <span className={`dot ${s.ok ? 'dot-ok' : 'dot-idle'}`} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="row gap" style={{ alignItems: 'baseline' }}>
                                  {/*
                                    名字标签保持中性灰。
                                    曾经让它跟随注入状态变绿，但右侧已有状态标签
                                    （已注入 / 已装技能 / 已放置 / 未注入），
                                    同一行两处表达同一件事是冗余 —— 用户要求改回。
                                  */}
                                  <span className="badge badge-neutral" style={{ flex: 'none' }}>
                                    {/* 第三方条目优先显示用户写的备注，没写才退回「第三方」 */}
                                    {s.kind === 'thirdParty' && s.label
                                      ? s.label
                                      : s.kind === 'prompt'
                                        ? '提示词'
                                        : s.kind === 'skills'
                                          ? '技能'
                                          : '第三方'}
                                  </span>
                                  <span className="inj-point-path mono">{s.path}</span>
                                </div>
                                <div className="inj-point-meta">
                                  {s.kind === 'prompt' ? (
                                    <>
                                      {s.exists ? `${s.fileLen} 字节` : '文件不存在（安装时新建）'}
                                      {s.ok ? ' · 已整份接管' : ''}
                                    </>
                                  ) : s.exists ? (
                                    s.kind === 'skills'
                                      ? `${s.itemCount} 个技能`
                                      : `${s.itemCount} 项内容`
                                  ) : (
                                    '目录不存在（安装时新建）'
                                  )}
                                  {/* 备注已经当标签显示了，这里就不再重复一次源路径 */}
                                  {s.kind === 'thirdParty' && s.label ? '' : s.label ? ` · 源 ${s.label}` : ''}
                                </div>
                              </div>
                              <span className={`badge ${s.ok ? 'badge-ok' : 'badge-neutral'}`}>
                                {okLabel}
                              </span>
                              <button className="btn btn-ghost btn-sm" onClick={() => openFolder(s.path)}>
                                <FolderOpen size={11} />
                              </button>
                            </div>
                            {s.backup && (
                              <div className="mono sub" style={{ fontSize: 9.5, padding: '0 4px 8px 24px', wordBreak: 'break-all' }}>
                                {s.kind === 'skills' ? '原技能已改名 → ' : '备份 '}
                                {s.backup}
                              </div>
                            )}
                          </div>
                        )
                      })}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 预设组编辑器 */}
      {editor && (
        <Modal
          title={editor.isNew ? '新建预设组' : `编辑预设组 · ${String(editor.manifest.label ?? '')}`}
          onClose={() => setEditor(null)}
          width={720}
        >
          <div className="form-col">
            <div className="sub">
              {editor.isNew ? (
                <>
                  新预设组存在 <code>profiles/_custom/</code> 下。勾选提示词组与技能组、
                  填注入位置，即可固化成一个可复用的预设组。
                </>
              ) : (
                <>
                  正在编辑 <code>{String(editor.manifest.id ?? '')}</code>（
                  {String(editor.manifest.client ?? '')}）。改动就地写回该预设组的 manifest.json；
                  提示词组与技能组直接引用 <code>_assets/</code> 里的库。
                </>
              )}
            </div>

            <div className="form-2col">
              <label className="field">
                <span>预设组名称</span>
                <input
                  className="input"
                  value={String(editor.manifest.label ?? '')}
                  onChange={(e) => setEditor({ ...editor, manifest: { ...editor.manifest, label: e.target.value } })}
                />
              </label>
            </div>

            <label className="field">
              <span>说明</span>
              <input
                className="input"
                value={String(editor.manifest.desc ?? '')}
                onChange={(e) => setEditor({ ...editor, manifest: { ...editor.manifest, desc: e.target.value } })}
              />
            </label>

            {/* 提示词来源：从提示词库多选（不再走资源管理器挑文件） */}
            <div className="field">
              <span>提示词组（可多选，注入时多选一）</span>
              <div className="tgt-scroll" style={{ maxHeight: 190, border: '1px solid var(--hairline)', borderRadius: 'var(--r-sm)', padding: '4px 8px' }}>
                {promptLib.length === 0 && <div className="sub" style={{ fontSize: 11 }}>提示词库为空</div>}
                {promptLib.map((it) => {
                  const on = editorPrompts.some((p) => promptKeyOf(p) === promptKeyOf(itemToPrompt(it)))
                  return (
                    <div key={it.path} className="pick-skill-row" style={{ padding: '5px 4px' }}>
                      <Switch
                        on={on}
                        onChange={() => toggleEditorPrompt(it)}
                        label={it.file}
                        size="sm"
                      />
                      <div style={{ flex: 1, minWidth: 0 }} onClick={() => toggleEditorPrompt(it)}>
                        <div className="row gap" style={{ alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 700, fontSize: 11.5 }}>{it.file}</span>
                          <span className="mono sub" style={{ fontSize: 9 }}>
                            {it.source} · {(it.size / 1024).toFixed(1)}K
                          </span>
                        </div>
                        <div className="side-skill-desc">{it.preview || '（无预览）'}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="sub" style={{ fontSize: 10.5 }}>
                已选 {editorPrompts.length} 份。安装时在「PROMPTS / 提示词组」里多选一（默认第一份）。
              </div>
            </div>

            {/* 技能来源：技能包多选 */}
            <div className="field">
              <span>技能组（可多选，逐包勾选技能）</span>
              <div className="tgt-scroll" style={{ maxHeight: 210, border: '1px solid var(--hairline)', borderRadius: 'var(--r-sm)', padding: '4px 8px' }}>
                {allPacks.length === 0 && <div className="sub" style={{ fontSize: 11 }}>技能库为空</div>}
                {allPacks.map((p) => {
                  const on = editorPacks.includes(p.id)
                  /**
                   * 已勾技能数 —— 必须按「技能库」页的实际勾选算，不能显示磁盘总数。
                   *
                   * 早先这里写的是 `p.skills.length`（该包在磁盘上的全部技能数），
                   * 与勾选状态无关 —— 于是用户在技能库页把某个包全取消勾选后，
                   * 这里照样显示「59 技能」，看起来像没生效。
                   * 现在显示「已勾 X / 共 Y」，并在全不选时把整行变灰。
                   */
                  const pickedInPack = p.skills.filter((s) => isSkillOn(skillPick, p.id, s.name)).length
                  const nonePicked = on && p.skills.length > 0 && pickedInPack === 0
                  return (
                    <div
                      key={p.id}
                      className="pick-skill-row"
                      style={{ padding: '5px 4px', opacity: on && !nonePicked ? 1 : 0.55 }}
                    >
                      <Switch on={on} onChange={() => toggleEditorPack(p.id)} label={p.title || p.id} size="sm" />
                      <div style={{ flex: 1, minWidth: 0 }} onClick={() => toggleEditorPack(p.id)}>
                        <div className="row gap" style={{ alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 700, fontSize: 11.5 }}>{p.title || p.id}</span>
                          <span
                            className={`mono ${nonePicked ? 'text-warn' : 'sub'}`}
                            style={{ fontSize: 9 }}
                            title={nonePicked ? '这个包里的技能在「技能库」页被全部取消勾选了' : ''}
                          >
                            {nonePicked ? `已勾 0 / ${p.skills.length}（全取消）` : `已勾 ${pickedInPack} / ${p.skills.length}`}
                          </span>
                        </div>
                        <div className="mono sub" style={{ fontSize: 9.5, wordBreak: 'break-all' }}>{p.id}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="sub" style={{ fontSize: 10.5 }}>
                已选 {editorPacks.length} 个技能包。
                {(() => {
                  // 勾了包但包内技能被全取消 → 明确提示，否则用户以为装不上是 bug
                  const zero = allPacks.filter(
                    (p) => editorPacks.includes(p.id) && p.skills.length > 0 && p.skills.filter((s) => isSkillOn(skillPick, p.id, s.name)).length === 0,
                  )
                  return zero.length > 0 ? (
                    <span className="text-warn">
                      {' '}
                      其中 {zero.length} 个包里的技能在「技能库」页被全部取消勾选，安装时不会装入任何技能。
                    </span>
                  ) : (
                    ' 安装后到「技能库」页逐包勾选具体技能。'
                  )
                })()}
              </div>
            </div>

            {/* 提示词注入位置 */}
            <div className="field">
              <span>提示词注入位置</span>
              <div className="sub" style={{ fontSize: 10.5, marginBottom: 4 }}>
                提示词正文整份写到这个文件。安装时原文件自动改名为 <code>文件名-bak</code>，
                新的写进去；卸载时删除注入内容并把原名改回来。
              </div>
              {promptTargets.map((t, i) => (
                <div key={i} className="row gap" style={{ marginBottom: 6 }}>
                  <input
                    className="input mono"
                    style={{ flex: 1 }}
                    placeholder="~/.codex/AGENTS.md"
                    value={String(t.path ?? '')}
                    onChange={(e) => updateTarget(promptTargets, i, { path: e.target.value })}
                  />
                  <button
                    className="btn"
                    title="用资源管理器选提示词文件（如 AGENTS.md）"
                    onClick={() => void pickFileInto(promptTargets, i, String(t.fileName ?? 'AGENTS.md'))}
                  >
                    <FolderOpen size={13} />
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeTarget(promptTargets, i)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                className="btn btn-sm"
                onClick={() => addTarget('prompt')}
              >
                <FolderPlus size={12} /> 添加提示词位置
              </button>
            </div>

            {/* 技能注入位置 */}
            <div className="field">
              <span>技能注入位置</span>
              <div className="sub" style={{ fontSize: 10.5, marginBottom: 4 }}>
                技能目录复制到哪里（客户端读 skills 的目录）。安装时原目录自动改名为{' '}
                <code>目录名-bak</code>，新技能放进去；卸载时还原原名。
              </div>
              {skillTargets.map((t, i) => (
                <div key={i} className="row gap" style={{ marginBottom: 6 }}>
                  <span className="badge badge-neutral" style={{ flex: 'none' }}>目录</span>
                  <input
                    className="input mono"
                    style={{ flex: 1 }}
                    placeholder="~/.codex/skills"
                    value={String(t.dest ?? '')}
                    onChange={(e) => updateSkillSync(i, e.target.value)}
                  />
                  <button
                    className="btn"
                    title="用资源管理器选文件夹"
                    onClick={() => void pickFolderIntoSkillSync(i)}
                  >
                    <FolderOpen size={13} />
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeSkillSync(i)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button className="btn btn-sm" onClick={addSkillSync}>
                <FolderPlus size={12} /> 添加技能位置
              </button>
            </div>

            {/*
              第三方文件：用户自选「源（文件或文件夹）→ 落点」的条目。
              云记忆场景：在 _assets/other/ 下自建文件夹放 memory 文件，
              这里引用它并放到客户端读云记忆的位置，可勾「只读」防客户端篡改。
            */}
            <div className="field">
              <span>第三方文件（源 → 落点，可多个）</span>
              <div className="sub" style={{ fontSize: 10.5, marginBottom: 4 }}>
                源可以是**文件或文件夹**：文件直接放到落点；文件夹整包合并过去。
                云记忆建议放在 <code>_assets/other/</code> 下自建目录里。
                勾「只读」可防止客户端改写云记忆。
              </div>
              {thirdPartyPairs.map((t, i) => {
                const kind = String(t.kind ?? 'auto')
                const srcPath = String(t.sourceDir ?? '')
                const isFileSrc = kind === 'file'
                return (
                  <div
                    key={i}
                    style={{
                      position: 'relative',
                      border: '1px solid var(--hairline)',
                      borderRadius: 'var(--r-sm)',
                      padding: '8px 10px',
                      marginBottom: 8,
                    }}
                  >
                    {/*
                      删除按钮放在卡片右上角。
                      之前它挤在「落点」那一行的末尾，紧挨着两个资源管理器
                      按钮，看起来像落点行的一部分（用户反馈「位置太怪」）。
                    */}
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ position: 'absolute', top: 6, right: 6 }}
                      title="移除这条第三方"
                      onClick={() => removeThirdParty(i)}
                    >
                      <X size={13} />
                    </button>

                    {/* 备注：用户自己写的说明（右侧留出删除按钮的位置） */}
                    <div className="row gap" style={{ alignItems: 'center', marginBottom: 6, paddingRight: 30 }}>
                      <span className="badge badge-neutral" style={{ flex: 'none' }}>备注</span>
                      <input
                        className="input"
                        style={{ flex: 1 }}
                        placeholder="给这条起个名字（如：云记忆）"
                        value={String(t.label ?? '')}
                        onChange={(e) => updateThirdParty(i, { label: e.target.value })}
                      />
                    </div>

                    {/*
                      源：Windows 资源管理器原生对话框。
                      两个按钮 —— 原生对话框无法同时选文件与文件夹
                      （FOS_PICKFOLDERS 与文件选择互斥），所以分开给。
                    */}
                    <div className="row gap" style={{ alignItems: 'center', marginBottom: 6 }}>
                      <span className="badge badge-neutral" style={{ flex: 'none' }}>
                        {isFileSrc ? '源文件' : '源文件夹'}
                      </span>
                      <input
                        className="input mono"
                        style={{ flex: 1 }}
                        placeholder={isFileSrc ? '_assets/other/memory/default_memory.md' : '_assets/other/memory'}
                        value={srcPath}
                        onChange={(e) => updateThirdParty(i, { sourceDir: e.target.value })}
                      />
                      <button
                        className="btn"
                        title="资源管理器选源文件夹"
                        onClick={() => void pickThirdPartySourceDir(i)}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        className="btn"
                        title="资源管理器选源文件"
                        onClick={() => void pickThirdPartySourceFile(i)}
                      >
                        <FileText size={13} />
                      </button>
                    </div>

                    {/* 落点：同样是资源管理器，文件夹 / 文件各一个按钮 */}
                    <div className="row gap" style={{ alignItems: 'center', marginBottom: 6 }}>
                      <span className="badge badge-neutral" style={{ flex: 'none' }}>落点</span>
                      <input
                        className="input mono"
                        style={{ flex: 1 }}
                        placeholder="~/.workbuddy-ai/memory/default_memory.md"
                        value={String(t.path ?? '')}
                        onChange={(e) => updateThirdParty(i, { path: e.target.value })}
                      />
                      <button
                        className="btn"
                        title="资源管理器选落点文件夹（放到该目录下，保留源文件名）"
                        onClick={() => void pickThirdPartyDestDir(i)}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        className="btn"
                        title="资源管理器选落点文件（可在文件名栏直接输入新名字）"
                        onClick={() => void pickThirdPartyDestFile(i)}
                      >
                        <FileText size={13} />
                      </button>
                    </div>

                    {/* 行为选项 */}
                    <div className="row gap" style={{ alignItems: 'center' }}>
                      <select
                        className="select"
                        style={{ width: 110 }}
                        value={kind}
                        onChange={(e) => updateThirdParty(i, { kind: e.target.value })}
                        title="源类型。auto = 按源的实际类型自动判断"
                      >
                        <option value="auto">自动识别</option>
                        <option value="file">当作文件</option>
                        <option value="dir">当作文件夹</option>
                      </select>
                      <Switch
                        on={Boolean(t.readonly)}
                        onChange={(v) => updateThirdParty(i, { readonly: v })}
                        label="只读"
                        size="sm"
                      />
                      <span className="sub" style={{ fontSize: 10 }}>
                        只读 = 放置后设为只读属性，防止客户端篡改
                      </span>
                    </div>
                  </div>
                )
              })}
              <button className="btn btn-sm" onClick={addThirdParty}>
                <FolderPlus size={12} /> 添加第三方文件
              </button>
            </div>

            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEditor(null)}>取消</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void saveEditor()}>
                <Save size={13} /> 保存预设组
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/*
        技能库弹窗：重名技能选择 + 逐包技能明细。
        从安装面板的「技能库」按钮进来，平时不占安装面板空间。
      */}
      {skillDlg && sel && (
        <Modal
          title={`技能库 · ${sel.label}`}
          onClose={() => setSkillDlg(false)}
          width={620}
        >
          <div className="form-col">
            {/* 重名技能：同名技能在多个包里都存在，让用户选一份，避免静默用错 */}
            <div className="field">
              <span>重名技能（{duplicates.length}）</span>
              <div className="sub" style={{ fontSize: 11, marginBottom: 6 }}>
                同名技能在多个包里都存在。点行内展开选来源；或在上面选好一个来源后「应用到全部」。
              </div>
              {duplicates.length > 0 && (
                <DupSkillPicker
                  duplicates={duplicates}
                  pick={pickDup}
                  onPick={(name, packId) => setPickDup((m) => ({ ...m, [name]: packId }))}
                  onApplyAll={(packId) => {
                    const next: Record<string, string> = { ...pickDup }
                    for (const d of duplicates) next[d.name] = packId
                    setPickDup(next)
                  }}
                />
              )}
            </div>

            {/* 逐包技能明细：每包有多少技能、已勾多少 */}
            <div className="field">
              <span>逐包明细</span>
              <div className="tgt-scroll" style={{ maxHeight: 220, border: '1px solid var(--hairline)', borderRadius: 'var(--r-sm)', padding: '6px 8px' }}>
                {presetPacks.length === 0 && <div className="sub" style={{ fontSize: 11 }}>本预设组未声明技能包</div>}
                {presetPacks.map((p) => {
                  const on = effectivePacks.includes(p.id)
                  const onCount = p.skills.filter((s) => isSkillOn(skillPick, p.id, s.name)).length
                  return (
                    <div key={p.id} className="pick-skill-row" style={{ padding: '6px 4px' }}>
                      <Switch on={on} onChange={() => togglePack(p.id)} label={p.id} size="sm" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row gap" style={{ alignItems: 'baseline' }}>
                          <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{p.id}</span>
                          <span className="badge badge-neutral">
                            已勾 {onCount} / {p.skills.length}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="sub" style={{ fontSize: 10.5 }}>
                取消勾选整包可跳过；单包里具体勾哪些技能在右侧「内容」视图里逐个勾。
              </div>
            </div>

            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setSkillDlg(false)}>
                完成
              </button>
            </div>
          </div>
        </Modal>
      )}

      {progOpen && (
        <InjectProgressDialog
          phase={opKind}
          title={sel?.label ?? (opKind === 'install' ? '注入' : '还原')}
          plan={progPlan}
          running={busy}
          onClose={() => setProgOpen(false)}
        />
      )}
      {confirmNode}
    </div>
  )
}
