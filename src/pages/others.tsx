import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUp,
  Check,
  ChevronRight,
  File as FileIcon,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Pencil,
  RefreshCw,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { Topbar, EmptyState } from '@/components/topbar'
import { Modal, useConfirm } from '@/components/modal'
import * as be from '@/lib/tauri'
import type { OtherEntryDto } from '@/lib/tauri'

/**
 * 左栏树的一个递归层。
 *
 * 拆成独立组件而不是在主组件里内联递归：JSX 里写递归需要把渲染函数
 * 定义在组件外（或在内部再声明一个函数组件），后者每次 render 都会
 * 重建组件类型、导致整棵子树卸载重挂 —— 折叠状态会闪。
 */
function TreeNodeList({
  nodes,
  depth,
  cwd,
  expanded,
  onToggle,
  onOpen,
}: {
  nodes: be.OtherNodeDto[]
  depth: number
  cwd: string | null
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (n: be.OtherNodeDto) => void
}) {
  const norm = (s: string) => s.replace(/[\\/]+/g, '\\').toLowerCase()
  return (
    <>
      {nodes.map((n) => {
        const hasKids = n.children.length > 0
        const open = expanded.has(n.path)
        const isCur = !!cwd && norm(cwd) === norm(n.path)
        // 当前目录的祖先链也要标出来（浅色提示），否则深层的看不到在哪个大类下
        const isAncestor = !!cwd && norm(cwd).startsWith(norm(n.path) + '\\')
        return (
          <div key={n.path}>
            <div
              className={`others-tnode${isCur ? ' is-on' : ''}${isAncestor ? ' is-ancestor' : ''}`}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {/* 展开箭头：没有子项时占位，保持左侧对齐 */}
              {hasKids ? (
                <button
                  className="others-tarrow"
                  title={open ? '折叠' : '展开'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggle(n.path)
                  }}
                >
                  <ChevronRight size={12} className={open ? 'is-open' : ''} />
                </button>
              ) : (
                <span className="others-tarrow is-empty" />
              )}

              <button
                className="others-tlabel"
                title={n.note.trim() ? `备注：${n.note}` : n.path}
                onClick={() => onOpen(n)}
              >
                <FolderTree size={13} />
                <span className="others-tname">{n.name}</span>
                {n.files > 0 ? <span className="others-tcount">{n.files}</span> : null}
              </button>
            </div>

            {n.note.trim() ? (
              <div className="others-tnote" style={{ paddingLeft: 24 + depth * 14 }}>
                {n.note}
              </div>
            ) : null}

            {hasKids && open ? (
              <TreeNodeList
                nodes={n.children}
                depth={depth + 1}
                cwd={cwd}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        )
      })}
    </>
  )
}

/**
 * 其他文件：第三方注入素材的文件管理器。
 *
 * ══ 它管的是什么（与「提示词」页的分工）════════════════════════════════
 * 预设组里除了「提示词组」「技能组」，还有一类**第三方文件**条目：
 * 用户自备的素材（云记忆、规则、任意要跟着一起注入过去的文件/夹），
 * 落点由用户在「目标」页逐条指定。
 *
 * 早先这些素材只能自己开资源管理器丢进 `_assets/other/`，界面上看不见、
 * 也无法归类 —— 素材一多就分不清哪个是给哪个客户端的。这一页补上：
 *   · 平铺列出 others 根下的条目（目录在前）
 *   · 每个条目能写**备注**，用来分类/说明用途
 *   · 就近搜索备注与文件名
 *   · 新建文件夹 / 导入文件 / 导入文件夹 / 重命名 / 删除
 *
 * ══ 两点设计取舍 ═══════════════════════════════════════════════════════
 * ① 备注**不改文件名**。注入时复制的是原始文件名，改名会让脚本里写死的
 *    引用全部失效。所以备注外挂在同目录 `.alice-notes.json`，素材本身
 *    一个字节不动。
 * ② 只列**当前一层**，不递归。素材通常按用途分一层文件夹；平铺更好认，
 *    要深入就双击进去 —— 与资源管理器的心智一致。
 */
export function Others() {
  const { openFolder, pushLog } = useStore()
  const { toast } = useApp()
  const { confirm, confirmNode } = useConfirm()

  const [items, setItems] = useState<OtherEntryDto[]>([])
  const [loading, setLoading] = useState(false)
  /**
   * 左栏的文件夹树（用户要求「做成真正的树形目录」）。
   *
   * ══ 为什么不做成逐层懒加载 ═══════════════════════════════════════════
   * 左栏是导航，用户需要一眼看到**整棵结构**才能判断素材怎么归类。
   * 逐层展开会有明显的"点了才加载"延迟，也看不出全貌。
   * others 是用户自备目录，规模通常几十~几百项，一次取完没压力。
   */
  const [tree, setTree] = useState<be.OtherNodeDto[]>([])
  /** 展开的文件夹路径集合（默认全展开：素材少时全展开最好用） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 当前所在目录（null = 根） */
  const [cwd, setCwd] = useState<string | null>(null)
  const [rootPath, setRootPath] = useState('')
  const [filter, setFilter] = useState('')
  /** 正在编辑备注的条目 rel */
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  /** 新建文件夹弹窗 */
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  /** 重命名弹窗 */
  const [renameTarget, setRenameTarget] = useState<OtherEntryDto | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const refresh = useCallback(
    async (dir: string | null = cwd) => {
      if (!be.IS_TAURI) return
      setLoading(true)
      try {
        // 左栏树 + 右栏列表一起刷，保证两边不会不同步
        const [list, t] = await Promise.all([
          be.othersList(dir ?? undefined),
          be.othersTree(),
        ])
        setItems(list)
        setTree(t)
        /*
         * 展开状态：把树里**所有**节点并进 expanded（merge，不是替换）。
         *
         * ══ 为什么是 merge（真机踩过）══════════════════════════════════════
         * 首版写的是「只在首次（size===0）全展开」。于是页面加载后再新建
         * 子目录 → refresh 拿到新树，但 size 已非 0，新节点没被加进去 ——
         * 树看起来「只有一层、没有展开箭头」，像是渲染坏了，实际只是
         * 新节点默认折叠了。
         * merge 让新增节点默认展开；用户手动折叠过的节点仍能保持折叠
         * （因为它已经在集合里，折叠只是临时从 UI 隐藏）。
         */
        setExpanded((prev) => {
          const next = new Set(prev)
          const walk = (ns: typeof t) => {
            for (const n of ns) {
              next.add(n.path)
              walk(n.children)
            }
          }
          walk(t)
          return next
        })
      } catch (e) {
        /*
         * 目录读不到（被外部删掉/改名）= 当前目录已经不存在。
         * 这时**自动退回根目录**并提示，而不是把用户卡在一个空列表上 ——
         * 否则界面看起来像「我的素材全没了」，实际只是 cwd 失效。
         */
        if (dir) {
          try {
            const rootList = await be.othersList()
            setItems(rootList)
            setTree(await be.othersTree())
            setCwd(null)
            toast('原目录已不存在，已回到 others 根目录', 'warn')
          } catch {
            toast(`读取失败：${String(e)}`, 'bad')
            setItems([])
          }
        } else {
          toast(`读取失败：${String(e)}`, 'bad')
          setItems([])
        }
      } finally {
        setLoading(false)
      }
    },
    [cwd, toast],
  )

  // 首次进页：拿根目录路径并列出
  useEffect(() => {
    void (async () => {
      try {
        setRootPath(await be.othersRootPath())
      } catch {
        /* 浏览器预览下无后端，忽略 */
      }
      // 初始就在根：这一趟同时把左栏（文件夹树）填好
      await refresh(null)
    })()
    // 只在挂载时跑一次；换目录由 openDir 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * 窗口重新获得焦点时刷新。
   *
   * 素材经常是用户在**外面**（资源管理器、另一个终端）拷进来的；
   * 不刷新的话界面停在旧快照上，用户会以为「放进去了但这里看不到」。
   * 这个页面本身也要写盘（导入/改名/删除），所以刷新只读文件系统、
   * 不动任何状态。
   */
  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  const openDir = (e: OtherEntryDto) => {
    setCwd(e.path)
    setFilter('')
    void refresh(e.path)
  }

  /** 回到根（左栏「全部素材」） */
  const goRoot = () => {
    setCwd(null)
    setFilter('')
    void refresh(null)
  }

  /** 回到上一级；已在根就什么都不做 */
  const goUp = () => {
    if (!cwd) return
    const norm = (s: string) => s.replace(/[\\/]+$/, '')
    const parent = norm(cwd).slice(0, Math.max(norm(cwd).lastIndexOf('\\'), norm(cwd).lastIndexOf('/')))
    if (!parent || norm(parent).toLowerCase() === norm(rootPath).toLowerCase()) {
      goRoot()
    } else {
      setCwd(parent)
      void refresh(parent)
    }
  }

  const saveNote = async (e: OtherEntryDto) => {
    try {
      await be.othersSetNote(e.rel, noteDraft)
      toast(noteDraft.trim() ? '备注已保存' : '备注已清除', 'ok')
      setEditingNote(null)
      await refresh()
    } catch (err) {
      toast(`保存失败：${String(err)}`, 'bad')
    }
  }

  const doMkdir = async () => {
    try {
      await be.othersMkdir(cwd, mkdirName)
      toast(`已新建「${mkdirName.trim()}」`, 'ok')
      setMkdirOpen(false)
      setMkdirName('')
      await refresh()
    } catch (e) {
      toast(`新建失败：${String(e)}`, 'bad')
    }
  }

  const doRename = async () => {
    if (!renameTarget) return
    try {
      await be.othersRename(renameTarget.path, renameDraft)
      toast(`已重命名为「${renameDraft.trim()}」`, 'ok')
      setRenameTarget(null)
      await refresh()
    } catch (e) {
      toast(`重命名失败：${String(e)}`, 'bad')
    }
  }

  const doImport = async (kind: 'file' | 'dir') => {
    if (!be.IS_TAURI) {
      toast('浏览器预览无法打开系统对话框', 'warn')
      return
    }
    try {
      const picked = await be.pickImportSources(kind)
      if (!picked.length) return
      const done = await be.othersImport(cwd, picked)
      toast(`已导入 ${done.length} 项`, 'ok')
      pushLog(`[others] 导入 ${done.length} 项到 others`, 'ok')
      await refresh()
    } catch (e) {
      // 部分成功也走这里：后端把成功数与失败项一起写进错误文本
      toast(`导入：${String(e)}`, 'warn')
      await refresh()
    }
  }

  const doDelete = (e: OtherEntryDto) => {
    confirm(
      `确定删除${e.isDir ? '文件夹' : '文件'}「${e.name}」？${e.isDir ? '\n\n里面的内容会一起删掉。' : ''}${
        e.note ? `\n备注「${e.note}」也会清除。` : ''
      }`,
      () => {
        void (async () => {
          try {
            await be.othersDelete(e.path)
            toast(`已删除「${e.name}」`, 'ok')
            await refresh()
          } catch (err) {
            toast(`删除失败：${String(err)}`, 'bad')
          }
        })()
      },
    )
  }

  /**
   * 面包屑里显示的相对路径。
   *
   * ══ 为什么不能直接 replace（真机踩过）═══════════════════════════════
   * 首版写的是 `cwd.replace(rootPath, '')` 再砍掉开头的分隔符 ——
   * 于是根目录本身会残留一个前导 `\`，拼出来就是
   * `OTHERS /hook脚本 / hook脚本`（根名与叶名重复、还带个孤立斜杠）。
   * 正确做法是按分隔符切成段、过滤掉「等于根名」和空段，再 join。
   */
  const crumb = useMemo(() => {
    if (!cwd) return '根目录'
    const norm = (s: string) => s.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
    const base = norm(rootPath || '')
    const cur = norm(cwd)
    let rest = cur
    if (base && cur.toLowerCase().startsWith(base.toLowerCase())) {
      rest = cur.slice(base.length)
    }
    const segs = rest
      .split('\\')
      .map((s) => s.trim())
      .filter((s) => s && s.toLowerCase() !== 'others')
    return segs.length ? segs.join(' / ') : '根目录'
  }, [cwd, rootPath])


  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (e) => e.name.toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q),
    )
  }, [items, filter])

  const stats = useMemo(() => {
    const dirs = items.filter((e) => e.isDir).length
    const noted = items.filter((e) => e.note.trim()).length
    const bytes = items.reduce((s, e) => s + e.size, 0)
    return { dirs, files: items.length - dirs, noted, mb: bytes / 1024 / 1024 }
  }, [items])

  const fmtSize = (n: number) => {
    if (n <= 0) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }
  const fmtTime = (ms: number) =>
    ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') : '—'

  return (
    <div className="page">
      <Topbar
        kicker="OTHERS / 第三方注入素材"
        title="其他文件"
        sub="管理第三方注入用的素材（文件或文件夹）。写备注分类，供「目标」页的预设组按「第三方文件」引用。"
        actions={
          <>
            <button className="btn btn-sm" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={12} /> 刷新
            </button>
            <button
              className="btn btn-sm"
              disabled={!rootPath}
              title={rootPath ? `在资源管理器中打开：${rootPath}` : '包根还没读到'}
              onClick={() => void openFolder(rootPath)}
            >
              <FolderOpen size={12} /> 目录
            </button>
          </>
        }
      />

      {/*
        ══ 布局：左侧分类栏 + 右侧列表（用户要求）════════════════════════
        首版是「工具条在上、列表铺满」的纵向结构。用户反馈「看着不够明白」——
        因为**文件夹层级是全文最核心的信息，却被塞在标题旁边的一行小字里**，
        扫一眼根本看不出自己在哪一级、有哪些分类。
        改成左右分栏后：
          · 左边 = 分类栏，文件夹名用**大字号**竖排，一眼看清有哪些分类
          · 右边 = 当前选中分类下的条目列表
        这正是资源管理器的读法，不需要额外学习。
      */}
      <div className="others-split">
        {/* ---------- 左：分类栏 ---------- */}
        <aside className="glass glass-iridescent glass-pad others-rail">
          <div className="panel-head">
            <span className="kicker">FOLDERS / 分类</span>
            {cwd ? (
              <button className="btn btn-ghost btn-sm" title="返回上一级" onClick={goUp}>
                <ArrowUp size={11} /> 上一级
              </button>
            ) : null}
          </div>

          {/* 根目录：永远在第一位，作为「全部/顶层」入口 */}
          <button className={`others-folder${!cwd ? ' is-on' : ''}`} onClick={goRoot}>
            <FolderTree size={15} />
            <span className="others-folder-name">全部素材</span>
            <span className="others-folder-n">{items.length}</span>
          </button>

          {/* 树形目录：递归渲染，带缩进与展开箭头。
              当前所在目录（含其祖先）自动展开并高亮，用户一眼知道自己在哪。 */}
          <div className="others-tree">
            <TreeNodeList
              nodes={tree}
              depth={0}
              cwd={cwd}
              expanded={expanded}
              onToggle={(p) =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(p)) next.delete(p)
                  else next.add(p)
                  return next
                })
              }
              onOpen={(n) => {
                setCwd(n.path)
                setFilter('')
                // 展开被点的这一级，方便继续往下走
                setExpanded((prev) => new Set(prev).add(n.path))
                void refresh(n.path)
              }}
            />
            {!tree.length && (
              <div className="sub" style={{ fontSize: 10.5, padding: '4px 2px' }}>
                还没有子文件夹。点下面「新建文件夹」建分类。
              </div>
            )}
          </div>

          <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setMkdirOpen(true)}>
            <FolderPlus size={12} /> 新建文件夹
          </button>

          <div className="sub" style={{ marginTop: 10, fontSize: 10.5, lineHeight: 1.7 }}>
            素材实体在 <code>_assets/others/</code>。备注只用于分类，不会改名、也不会被注入。
          </div>
        </aside>

        {/* ---------- 右：内容列表 ---------- */}
        <section className="glass glass-iridescent glass-pad others-main">
          {/*
            标题区：把「当前在哪个分类」做成**大号标题**（用户反馈
            「看不清点进去是哪个文件夹」）。
            原先这里是一行 11px 的 kicker，和右边徽章挤在同一行，
            扫一眼根本看不出层级。现在：面包屑小字在上、分类名大字在下，
            与列表头形成主次分明的两层。
          */}
          <div className="others-head">
            <div className="others-head-text">
              <span className="kicker others-crumb">
                OTHERS {cwd ? `/ ${crumb}` : '/ 全部素材'}
              </span>
              <h2 className="others-title">
                {cwd ? <FolderTree size={19} /> : null}
                {cwd ? crumb.split(' / ').pop() : '全部素材'}
              </h2>
            </div>
            <div className="others-head-side">
              <span className="badge badge-neutral">
                {shown.length} 项{filter ? `（筛自 ${items.length}）` : ''}
              </span>
              <span className="badge badge-neutral">
                目录 {stats.dirs} · 文件 {stats.files} · 已备注 {stats.noted}
                {stats.mb > 0 ? ` · ${stats.mb.toFixed(1)} MB` : ''}
              </span>
            </div>
          </div>

          <div className="row gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <button className="btn btn-sm" onClick={() => void doImport('file')}>
              <Upload size={12} /> 导入文件
            </button>
            <button className="btn btn-sm" onClick={() => void doImport('dir')}>
              <Upload size={12} /> 导入文件夹
            </button>
            <button className="btn btn-sm" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={12} /> 刷新
            </button>
            <input
              className="input"
              style={{ width: 220, marginLeft: 'auto' }}
              placeholder="搜索文件名 / 备注…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          {loading && !items.length ? (
            <div className="sub">读取中…</div>
          ) : !shown.length ? (
            <EmptyState
              icon={<FolderTree size={22} />}
              title={items.length ? '没有匹配的条目' : '这个分类还是空的'}
              hint={
                items.length
                  ? '换个关键词，或清空搜索框。'
                  : '用上面的「导入文件 / 导入文件夹」把素材复制进来（复制不是移动，原文件留在原处）；要建子分类就点左边「新建文件夹」。'
              }
            />
          ) : (
            <div className="others-rows">
              {shown.map((e) => (
                <div key={e.path} className="others-row">
                  <span className="others-row-icon">{e.isDir ? <FolderTree size={14} /> : <FileIcon size={14} />}</span>

                  <span className="others-row-main">
                    {e.isDir ? (
                      <button className="others-row-name is-link" title="打开这个文件夹" onClick={() => openDir(e)}>
                        {e.name}
                      </button>
                    ) : (
                      <span className="others-row-name">{e.name}</span>
                    )}

                    {editingNote === e.rel ? (
                      <span className="row gap" style={{ marginTop: 5 }}>
                        <input
                          className="input"
                          style={{ width: 300 }}
                          autoFocus
                          placeholder="备注（例如：给 Codex 的云记忆）"
                          value={noteDraft}
                          onChange={(ev2) => setNoteDraft(ev2.target.value)}
                          onKeyDown={(ev2) => {
                            if (ev2.key === 'Enter') void saveNote(e)
                            if (ev2.key === 'Escape') setEditingNote(null)
                          }}
                        />
                        <button className="btn btn-primary btn-sm" onClick={() => void saveNote(e)}>
                          <Check size={11} /> 保存
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingNote(null)}>
                          <X size={11} /> 取消
                        </button>
                      </span>
                    ) : (
                      <span className="row gap" style={{ marginTop: 5, flexWrap: 'wrap' }}>
                        {e.note.trim() ? (
                          <span className="badge badge-ok">
                            <Tag size={10} /> {e.note}
                          </span>
                        ) : (
                          <span className="sub" style={{ fontSize: 10.5 }}>
                            未备注
                          </span>
                        )}
                        <span className="sub" style={{ fontSize: 10.5 }}>
                          {e.isDir ? '文件夹' : fmtSize(e.size)} · {fmtTime(e.modified)}
                        </span>
                        <button
                          className="btn btn-ghost btn-sm"
                          title={e.note.trim() ? `改备注：${e.note}` : '给这条写备注（用于分类）'}
                          onClick={() => {
                            setEditingNote(e.rel)
                            setNoteDraft(e.note || '')
                          }}
                        >
                          <Pencil size={11} /> {e.note.trim() ? '改备注' : '加备注'}
                        </button>
                      </span>
                    )}
                  </span>

                  <span className="others-row-acts">
                    {e.isDir && (
                      <button className="btn btn-sm" title="打开这个文件夹" onClick={() => openDir(e)}>
                        <FolderOpen size={11} /> 打开
                      </button>
                    )}
                    <button
                      className="btn btn-sm"
                      title="重命名（备注会跟着迁移）"
                      onClick={() => {
                        setRenameTarget(e)
                        setRenameDraft(e.name)
                      }}
                    >
                      <Pencil size={11} />
                    </button>
                    <button className="btn btn-sm" title="删除这条（连带其备注）" onClick={() => doDelete(e)}>
                      <Trash2 size={11} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ---------- 新建文件夹 ---------- */}
      {mkdirOpen && (
        <Modal title="新建文件夹" onClose={() => setMkdirOpen(false)} width={460}>
          <div className="sub" style={{ marginBottom: 10 }}>
            建在 <code>{crumb === '根目录' ? 'others 根目录' : crumb}</code> 下。
            建议按用途命名（如 <code>codex-memory</code>、<code>cursor-rules</code>），再用备注写清给谁用。
          </div>
          <input
            className="input"
            style={{ width: '100%' }}
            autoFocus
            placeholder="文件夹名"
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doMkdir()}
          />
          <div className="row gap" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn btn-primary btn-sm" disabled={!mkdirName.trim()} onClick={() => void doMkdir()}>
              <FolderPlus size={12} /> 创建
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setMkdirOpen(false)}>
              取消
            </button>
          </div>
        </Modal>
      )}

      {/* ---------- 重命名 ---------- */}
      {renameTarget && (
        <Modal title="重命名" onClose={() => setRenameTarget(null)} width={460}>
          <div className="sub" style={{ marginBottom: 10 }}>
            改的是磁盘上的真名。<b>备注会跟着迁移</b>，但如果你在别处按文件名引用了它，记得同步。
          </div>
          <input
            className="input"
            style={{ width: '100%' }}
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doRename()}
          />
          <div className="row gap" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={!renameDraft.trim() || renameDraft.trim() === renameTarget.name}
              onClick={() => void doRename()}
            >
              <Check size={12} /> 确认
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setRenameTarget(null)}>
              取消
            </button>
          </div>
        </Modal>
      )}

      {confirmNode}
    </div>
  )
}
