import { useCallback, useEffect, useRef, useState } from 'react'
import { Boxes, FolderOpen, FolderPlus, GripVertical, Pencil, Trash2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { EmptyState } from '@/components/topbar'
import { Modal, useConfirm } from '@/components/modal'
import * as be from '@/lib/tauri'
import type { ClientEntryDto } from '@/lib/tauri'
import type { PageId } from '@/components/topnav'

/** 自定义版本的伪目标 id：不对应任何内置客户端，只用来筛 profiles/_custom */
export const CUSTOM_TARGET_ID = '_custom'

/** 内置客户端的展示名（profiles/ 下已有目录，但名字更友好） */
const CLIENT_LABEL: Record<string, string> = {
  codex: 'Codex 破甲',
  zcode: 'ZCode 破甲',
  cursor: 'Cursor 破甲',
  claude: 'Claude 破甲',
  workbuddy: 'WorkBuddy 破甲（国际版）',
  dsh: 'DeepSeek Harness 破甲',
}

/** 长按多久进入拖动（毫秒）。太短会误触，太长手感迟钝 */
const HOLD_MS = 180

/**
 * 常驻目标侧栏（左侧）：只在「目标 / 会话」页固定显示。
 *
 * 列表来源是**磁盘上的 profiles/<客户端>/ 目录**（后端 clients_list），
 * 不再用前端写死的种子数据 —— 这样用户自己加的客户端能立刻出现在这里，
 * 且每一行显示的就是它真实的工作路径（~/.xxx），点「打开资源管理器」时
 * 对话框也从这里开始，不用从 C 盘一层层点进去。
 */
export function TargetRail({ page }: { page: PageId }) {
  const { versions, activeTargetId, setActiveTarget, backendLive, clients, reloadClients } = useStore()
  const { toast } = useApp()
  const { confirm, confirmNode } = useConfirm()

  const [adding, setAdding] = useState<null | { id: string; workDir: string }>(null)
  /** 正在改工作路径的客户端：null = 未在编辑 */
  const [editing, setEditing] = useState<null | { id: string; workDir: string }>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 拖动排序状态。
   *   dragId   —— 正在被拖的客户端 id（长按后才有值）
   *   overIdx  —— 当前落点插入位置（用于画插入指示线）
   *   dx/dy    —— 拖起后鼠标相对起点的位移，用来做「跟手」位移
   *   fromIdx  —— 起始索引，配合 dy 计算目标位置
   */
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const [dy, setDy] = useState(0)
  const [settling, setSettling] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const holdTimer = useRef<number | null>(null)
  const startY = useRef(0)
  const dragIdRef = useRef<string | null>(null)
  const movedRef = useRef(false)

  // 清单来自 store（与目标页共用一份）；进页面时拉一次
  const load = reloadClients
  useEffect(() => {
    void load()
  }, [load, page])

  /**
   * 用 Windows 资源管理器选客户端工作路径。
   *
   * 手敲 `C:\Users\xxx\.mycli` 既慢又容易错，直接开系统选文件夹对话框。
   * 初始目录不强制指定 —— 系统对话框会记住上次位置，用户选过一次后
   * 下次就落在同一处，比每次硬指定更好用。
   */
  const pickWorkDir = async () => {
    try {
      const dir = await be.pickOneFolder('选择客户端工作路径（配置文件所在目录）')
      if (!dir) return
      setAdding((s) => (s ? { ...s, workDir: dir } : s))
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  /** 编辑工作路径时选新目录 */
  const pickEditDir = async () => {
    try {
      const dir = await be.pickOneFolder(
        '选择新的客户端工作路径（将改写该客户端全部预设组的注入位置）',
        editing?.workDir || undefined,
      )
      if (!dir) return
      setEditing((s) => (s ? { ...s, workDir: dir } : s))
    } catch (e) {
      toast(`选择失败：${String(e)}`, 'bad')
    }
  }

  /**
   * 保存客户端配置：后端写 `profiles/<客户端>/<客户端>.json`（工作路径权威记录），
   * 并在路径变化时同步该客户端全部预设组的落点，改完刷新清单。
   */
  const saveWorkdir = async () => {
    if (!editing) return
    const cur = clients.find((c) => c.id === editing.id)
    if (!editing.workDir.trim() || editing.workDir === cur?.workDir) {
      setEditing(null)
      return
    }
    setBusy(true)
    try {
      const n = await be.clientConfigSave({
        id: editing.id,
        label: cur?.label ?? editing.id,
        workDir: editing.workDir,
        notes: '',
      })
      toast(
        n > 0
          ? `已写入客户端配置，并同步 ${n} 个预设组的注入位置 → ${editing.workDir}`
          : `已写入客户端配置 → ${editing.workDir}`,
        'ok',
      )
      setEditing(null)
      await load()
    } catch (e) {
      toast(`修改失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  // 首次拿到客户端清单时，若当前选中的不存在，自动切到第一个
  useEffect(() => {
    if (!clients.length) return
    if (activeTargetId && clients.some((c) => c.id === activeTargetId)) return
    if (activeTargetId === CUSTOM_TARGET_ID) return
    setActiveTarget(clients[0].id)
  }, [clients, activeTargetId, setActiveTarget])

  /** 每行的高度（含间距），用于把像素位移换算成索引位移 */
  const rowH = () => {
    const first = listRef.current?.querySelector<HTMLElement>('.rail-row[data-client]')
    return first ? first.getBoundingClientRect().height + 6 : 62
  }

  const endDrag = useCallback(
    async (commit: boolean) => {
      if (holdTimer.current) {
        window.clearTimeout(holdTimer.current)
        holdTimer.current = null
      }
      const id = dragIdRef.current
      const target = overIdx
      dragIdRef.current = null
      setDragId(null)
      setOverIdx(null)
      setDy(0)

      if (!commit || !id || target === null) return
      const from = clients.findIndex((c) => c.id === id)
      if (from < 0) return
      // 插入位置换算成「移除后」的落点：往后移要减 1
      const to = target > from ? target - 1 : target
      if (to === from) return

      const next = clients.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)

      /*
       * 持久化顺序后重拉清单。
       *
       * 清单现在住在 store 里（与目标页共用一份），不能在这里 setState 本地副本 ——
       * 那样两边又会出现「一个变了另一个没变」。保存完让 store 重读，
       * 排序和注入状态一起刷新。
       * 落位动效由 CSS transition 负责，重拉回来的顺序就是最终顺序。
       */
      setSettling(true)
      window.setTimeout(() => setSettling(false), 220)
      try {
        await be.clientsOrderSave(next.map((c) => c.id))
        await reloadClients()
      } catch (e) {
        toast(`排序保存失败：${String(e)}`, 'bad')
      }
    },
    [clients, overIdx, toast, reloadClients],
  )

  /** 长按开始拖动 */
  const onRowPointerDown = (e: React.PointerEvent, c: ClientEntryDto) => {
    // 只响应左键/触摸主键；按钮上的按下不触发拖动
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    startY.current = e.clientY
    movedRef.current = false
    dragIdRef.current = null
    if (holdTimer.current) window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      dragIdRef.current = c.id
      setDragId(c.id)
      setOverIdx(clients.findIndex((x) => x.id === c.id))
      // 万一浏览器已经选了一段文字，立刻清掉，避免「选中态 + 拖动」同时存在
      window.getSelection()?.removeAllRanges()
      try {
        navigator.vibrate?.(12)
      } catch {
        /* 桌面端没有振动，忽略 */
      }
    }, HOLD_MS)
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragIdRef.current) {
        // 还没进入拖动：位移过大说明是普通滚动/点击，取消长按
        if (Math.abs(e.clientY - startY.current) > 8 && holdTimer.current) {
          window.clearTimeout(holdTimer.current)
          holdTimer.current = null
        }
        return
      }
      movedRef.current = true
      setDy(e.clientY - startY.current)
      const h = rowH()
      const from = clients.findIndex((c) => c.id === dragIdRef.current)
      const shift = Math.round((e.clientY - startY.current) / h)
      const idx = Math.max(0, Math.min(clients.length, from + shift))
      setOverIdx(idx)
    }
    const onUp = () => void endDrag(true)
    const onCancel = () => void endDrag(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [clients, endDrag])

  // 拖动中禁掉文本选择，避免拖着拖着把文字刷蓝
  useEffect(() => {
    if (!dragId) return
    const prev = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.userSelect = prev
    }
  }, [dragId])

  // 用户要求（2026-09-22）：Agent 会话页不显示左侧目标栏 —— 会话已与目标/版本解耦。
  const show = page === 'targets'
  if (!show) return null

  const create = async () => {
    if (!adding) return
    const id = adding.id.trim()
    if (!id) {
      toast('请填客户端名（会作为 profiles/<名字> 目录名）', 'warn')
      return
    }
    setBusy(true)
    try {
      const dir = await be.clientCreate(id, adding.workDir.trim() || null)
      toast(`已添加客户端：${dir}`, 'ok')
      setAdding(null)
      await load()
      setActiveTarget(id)
    } catch (e) {
      toast(`添加失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  const remove = (c: ClientEntryDto) => {
    confirm(`删除客户端「${c.id}」？将连同它下面 ${c.profileCount} 个预设组一起删除。`, async () => {
      try {
        await be.clientDelete(c.id)
        toast(`已删除客户端 ${c.id}`, 'warn')
        await load()
        if (activeTargetId === c.id) setActiveTarget(clients.find((x) => x.id !== c.id)?.id ?? null)
      } catch (e) {
        toast(`删除失败：${String(e)}`, 'bad')
      }
    })
  }

  return (
    <aside className="target-rail glass-iridescent" data-tour="rail.clients">
      <div className="target-rail-head">
        <span className="kicker">CLIENTS</span>
        <span className="badge badge-neutral">{clients.length}</span>
      </div>
      <div className="target-rail-list" ref={listRef} data-tour="rail.list">
        {clients.map((c, i) => {
          const count = versions.filter((v) => v.targetId === c.id).length
          const dragging = dragId === c.id
          const from = dragId ? clients.findIndex((x) => x.id === dragId) : -1
          // 拖起后其余行做「让位」位移，落点处画一条插入线
          let shiftPx = 0
          if (dragId && !dragging && overIdx !== null && from >= 0) {
            const h = rowH()
            if (from < overIdx && i >= from && i < overIdx) shiftPx = -h
            else if (from > overIdx && i >= overIdx && i < from) shiftPx = h
          }
          const showLine = dragId && overIdx === i
          return (
            <div
              key={c.id}
              data-client={c.id}
              className={
                `rail-row${c.id === activeTargetId ? ' selected' : ''}` +
                `${dragging ? ' rail-dragging' : ''}${settling ? ' rail-settling' : ''}`
              }
              style={{
                transform: dragging
                  ? `translateY(${dy}px) scale(1.02)`
                  : shiftPx
                    ? `translateY(${shiftPx}px)`
                    : undefined,
                zIndex: dragging ? 5 : undefined,
              }}
              onClick={() => {
                if (movedRef.current) return
                setActiveTarget(c.id)
              }}
              onPointerDown={(e) => onRowPointerDown(e, c)}
              // 禁掉浏览器原生拖拽，否则长按会被「拖拽元素/拖选文字」抢走。
              // 文字选择由 CSS 的 user-select:none 负责（React 没有 onSelectStart 属性）。
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              title={`${c.workDir || `profiles/${c.id}`}（长按可拖动排序）`}
            >
              {showLine && <span className="rail-drop-line" />}
              <GripVertical size={12} className="rail-grip" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="rail-name">{CLIENT_LABEL[c.id] ?? c.label ?? c.id}</div>
                <div className="rail-path mono">{c.workDir || `profiles/${c.id}`}</div>
                {/* 注入状态：一眼看出这个客户端装没装、装的是哪个预设组 */}
                <div className="rail-state">
                  <span className={`dot ${c.injected ? 'dot-ok' : 'dot-idle'}`} />
                  <span className={`rail-state-text${c.injected ? ' on' : ''}`}>
                    {c.injected ? (c.installedLabel ?? '已注入') : '未注入'}
                  </span>
                </div>
              </div>
              <div className="rail-marks">
                <span className={`rail-ver mono${count === 0 ? ' zero' : ''}`}>{c.profileCount}V</span>
                <button
                  className="btn btn-ghost btn-sm"
                  title="修改客户端工作路径（批量改写该客户端全部预设组的注入位置）"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditing({ id: c.id, workDir: c.workDir || '' })
                  }}
                >
                  <Pencil size={11} />
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  title="删除这个客户端"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(c)
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          )
        })}

        {/*
          添加客户端：落一个 profiles/<客户端>/ 目录，并写一个默认预设组。
          用户要求「添加客户端然后 profiles\客户端\，这个为客户端工作路径例如 user/.xxx」。
        */}
        <div
          className="rail-row rail-add"
          data-tour="rail.add"
          onClick={() => setAdding({ id: '', workDir: '' })}
          title="新建一个客户端目录 profiles/<客户端>/"
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="rail-name">
              <FolderPlus size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              添加客户端
            </div>
            <div className="rail-path mono">profiles\客户端\</div>
          </div>
        </div>

        {clients.length === 0 && !backendLive && (
          <EmptyState icon={<Boxes size={26} />} title="浏览器预览读不到磁盘" />
        )}
      </div>

      {adding && (
        <Modal
          title="添加客户端"
          onClose={() => setAdding(null)}
          width={520}
        >
          <div className="form-col">
            <div className="sub">
              会在 <code>profiles\&lt;客户端名&gt;\</code> 下建目录，并生成一个默认预设组{' '}
              <code>manifest.json</code>。客户端名用英文（如 <code>mycli</code>）。
            </div>
            <label className="field">
              <span>客户端名（目录名）</span>
              <input
                className="input mono"
                placeholder="mycli"
                value={adding.id}
                onChange={(e) => setAdding({ ...adding, id: e.target.value })}
              />
            </label>
            <label className="field">
              <span>客户端工作路径（配置文件所在目录）</span>
              <div className="row gap" style={{ alignItems: 'center' }}>
                <input
                  className="input mono"
                  style={{ flex: 1 }}
                  placeholder="~/.mycli"
                  value={adding.workDir}
                  onChange={(e) => setAdding({ ...adding, workDir: e.target.value })}
                />
                {/* 用 Windows 资源管理器选文件夹 —— 比手敲路径快，也不容易敲错 */}
                <button
                  className="btn"
                  style={{ flex: 'none' }}
                  title="用资源管理器选择客户端工作路径"
                  onClick={() => void pickWorkDir()}
                >
                  <FolderOpen size={13} />
                </button>
              </div>
              <div className="sub" style={{ fontSize: 10.5 }}>
                留空则按 <code>~/.&lt;客户端名&gt;</code> 推断。之后所有「打开资源管理器」
                都会默认从这个路径开始。
              </div>
            </label>
            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setAdding(null)}>取消</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
                <FolderPlus size={13} /> 创建客户端
              </button>
            </div>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal
          title={`修改工作路径 — ${CLIENT_LABEL[editing.id] ?? editing.id}`}
          onClose={() => setEditing(null)}
          width={520}
        >
          <div className="form-col">
            <div className="sub">
              写入客户端配置 <code>profiles\{editing.id}\{editing.id}.json</code>（工作路径的
              <b>权威记录</b>），并同步该客户端 <b>全部预设组</b> 的注入位置与技能落点
              （manifest 里的 <code>injectTargets</code> / <code>skillSync</code> /{' '}
              <code>moduleSync</code>）。改完后安装会把提示词和技能装到新目录；
              爱丽丝也能直接改这个 json 来换路径。
            </div>
            <label className="field">
              <span>新工作路径（配置文件所在目录）</span>
              <div className="row gap" style={{ alignItems: 'center' }}>
                <input
                  className="input mono"
                  style={{ flex: 1 }}
                  placeholder="C:\Users\you\.mycli"
                  value={editing.workDir}
                  onChange={(e) => setEditing({ ...editing, workDir: e.target.value })}
                />
                <button
                  className="btn"
                  style={{ flex: 'none' }}
                  title="用资源管理器选择新工作路径"
                  onClick={() => void pickEditDir()}
                >
                  <FolderOpen size={13} />
                </button>
              </div>
              <div className="sub" style={{ fontSize: 10.5 }}>
                只改**配置声明**，不动已存在的文件。已注入的内容如需迁移到新位置，
                改完路径后重新安装一次预设组即可。
              </div>
            </label>
            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void saveWorkdir()}>
                <Pencil size={13} /> 保存
              </button>
            </div>
          </div>
        </Modal>
      )}
      {confirmNode}
    </aside>
  )
}
