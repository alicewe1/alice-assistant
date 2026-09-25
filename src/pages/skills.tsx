import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { Topbar, EmptyState } from '@/components/topbar'
import { Modal, useConfirm } from '@/components/modal'
import { Switch } from '@/components/switch'
import { isSkillOn } from '@/lib/skill-pick'
import * as be from '@/lib/tauri'
import type { SkillItemDto, SkillPackDto } from '@/lib/tauri'

export function Skills() {
  const { openFolder, backendLive, pushLog, skillPick, setSkillPick, setSkillPickMany } = useStore()
  const { toast } = useApp()
  const { confirm, confirmNode } = useConfirm()

  const [packs, setPacks] = useState<SkillPackDto[]>([])
  const [loading, setLoading] = useState(false)
  const [selPack, setSelPack] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<{ item: SkillItemDto; text: string; dirty: boolean } | null>(null)
  const [renaming, setRenaming] = useState<SkillPackDto | null>(null)
  const [newPack, setNewPack] = useState<{ id: string; title: string } | null>(null)
  /** 导入进度与结果（原生多选 → 自动解压识别） */
  const [importing, setImporting] = useState(false)
  const [importReport, setImportReport] = useState<be.ImportManyResultDto | null>(null)

  const isOn = (packId: string, name: string) => isSkillOn(skillPick, packId, name)
  const setOn = (packId: string, name: string, next: boolean) => setSkillPick(packId, name, next)

  const refresh = useCallback(async () => {
    if (!be.IS_TAURI) return
    setLoading(true)
    try {
      const list = await be.scanShippedSkillPacks()
      setPacks(list)
      if (!selPack && list.length) setSelPack(list[0].id)
      if (selPack && !list.some((p) => p.id === selPack)) setSelPack(list[0]?.id ?? null)
    } catch (e) {
      pushLog(`[skills] 扫描失败：${String(e)}`, 'err')
    } finally {
      setLoading(false)
    }
  }, [selPack, pushLog])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pack = useMemo(() => packs.find((p) => p.id === selPack) ?? null, [packs, selPack])

  /**
   * 列表只按搜索词过滤，**不重排**。
   * 曾经把「已勾选」提到前面，结果勾一个就跳一次位置，反而找不到技能了 ——
   * 保持磁盘扫描出的原始字母序，位置稳定才好按名找。
   */
  const shown = useMemo(() => {
    const list = pack?.skills ?? []
    const k = q.trim().toLowerCase()
    if (!k) return list
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(k) ||
        s.title.toLowerCase().includes(k) ||
        s.description.toLowerCase().includes(k),
    )
  }, [pack, q])

  const openEditor = async (item: SkillItemDto) => {
    try {
      const text = await be.readFileText(`${item.path}\\SKILL.md`)
      setEditing({ item, text, dirty: false })
    } catch (e) {
      toast(`读取失败：${String(e)}`, 'bad')
    }
  }

  const saveEditor = async () => {
    if (!editing) return
    try {
      await be.saveFileText(`${editing.item.path}\\SKILL.md`, editing.text)
      toast('已保存（原文件备份 .bak-edit-*）', 'ok')
      setEditing({ ...editing, dirty: false })
      void refresh()
    } catch (e) {
      toast(`保存失败：${String(e)}`, 'bad')
    }
  }

  const removeSkill = (item: SkillItemDto) => {
    confirm(`删除技能「${item.name}」整个目录？\n${item.path}`, async () => {
      try {
        await be.deletePath(item.path)
        toast(`已删除 ${item.name}`, 'warn')
        setEditing(null)
        void refresh()
      } catch (e) {
        toast(`删除失败：${String(e)}`, 'bad')
      }
    })
  }

  const doRename = async () => {
    if (!renaming) return
    try {
      await be.savePackMeta(renaming.id, {
        title: renaming.title,
        desc: '',
        custom: renaming.custom,
      })
      toast('已重命名', 'ok')
      setRenaming(null)
      void refresh()
    } catch (e) {
      toast(`重命名失败：${String(e)}`, 'bad')
    }
  }

  const doCreatePack = async () => {
    if (!newPack || !newPack.id.trim()) return
    try {
      const p = await be.createSkillPack(newPack.id.trim(), newPack.title.trim() || newPack.id.trim())
      toast(`已创建技能包：${p}`, 'ok')
      setNewPack(null)
      void refresh()
    } catch (e) {
      toast(`创建失败：${String(e)}`, 'bad')
    }
  }

  const doDeletePack = (p: SkillPackDto) => {
    confirm(`删除整个技能包「${p.title}」（${p.skills.length} 个技能）？\n目录：${p.path}\n此操作不可撤销。`, async () => {
      try {
        await be.deleteSkillPack(p.id)
        toast(`已删除技能包 ${p.title}`, 'warn')
        setSelPack(null)
        void refresh()
      } catch (e) {
        toast(`删除失败：${String(e)}`, 'bad')
      }
    })
  }

  /**
   * 添加技能：先让用户选来源类型，再开对应的系统对话框。
   * 文件夹选择器与压缩包选择器在 Windows 上是两种不同对话框，不能互相选，
   * 所以这里先问一句，避免用户以为「压缩包选不了」。
   */
  const doAddSkill = async (packId: string, kind: 'dir' | 'zip') => {
    if (!be.IS_TAURI) {
      toast('浏览器预览无法打开系统对话框', 'warn')
      return
    }
    setImporting(true)
    setImportReport(null)
    try {
      const paths = await be.pickImportSources(kind)
      if (!paths.length) {
        setImporting(false)
        return
      }
      const r = await be.importSkillMulti(paths, packId)
      setImportReport(r)
      if (r.imported.length) {
        toast(`已导入 ${r.imported.length} 个技能`, 'ok')
      } else {
        toast('没有识别到技能（需含 SKILL.md）', 'warn')
      }
      void refresh()
    } catch (e) {
      toast(`导入失败：${String(e)}`, 'bad')
    } finally {
      setImporting(false)
    }
  }

  const totalSkills = packs.reduce((n, p) => n + p.skills.length, 0)
  const pickedCount = pack ? pack.skills.filter((s) => isOn(pack.id, s.name)).length : 0

  return (
    <div className="page anim-page">
      <Topbar
        kicker="SKILLS / 技能库"
        title="技能库管理"
        sub={`${packs.length} 个技能包 · ${totalSkills} 个技能 · 目录 _assets/skill/<包名>/skills/<技能>`}
        actions={
          <>
            {/* 「已读磁盘」徽章已删除（用户反馈太丑、无信息量）。
                浏览器预览时用「重新扫描」按钮的禁用态表达，不再单独占一个徽章。 */}
            <button className="btn" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={13} /> {loading ? '扫描中…' : '重新扫描'}
            </button>
            <button className="btn btn-primary" onClick={() => setNewPack({ id: '', title: '' })}>
              <Plus size={13} /> 新建技能包
            </button>
          </>
        }
      />

      <div className="page-body tgt-workspace skills-workspace">
        {/* 左：技能包卡片（可命名/删除） */}
        <div className="tgt-col">
          <div className="glass glass-iridescent glass-pad tgt-card" data-tour="skills.packs">
            <div className="panel-head">
              <span className="kicker">PACKS / {packs.length}</span>
            </div>
            <div className="tgt-scroll">
              {packs.map((p, i) => (
                <div
                  key={p.id}
                  data-tour={i === 0 ? 'skills.pack-first' : undefined}
                  className={`card-row${selPack === p.id ? ' selected' : ''}`}
                  onClick={() => setSelPack(p.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row gap" style={{ alignItems: 'baseline' }}>
                      <span style={{ fontWeight: 800, fontSize: 12.5 }}>{p.title || p.id}</span>
                    </div>
                    {p.title && p.title !== p.id && (
                      <div className="mono sub" style={{ fontSize: 9.5 }}>{p.id}</div>
                    )}
                    <div className="sub" style={{ fontSize: 11 }}>
                      {p.skills.length} 技能
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenaming({ ...p })
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="删除整包"
                    onClick={(e) => {
                      e.stopPropagation()
                      doDeletePack(p)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {packs.length === 0 && (
                <div className="sub">
                  {be.IS_TAURI ? '未发现技能包（检查 _assets/skill/）' : '浏览器预览无法读磁盘'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 中：技能列表（磁盘真实内容 + 图二药丸勾选） */}
        <div className="tgt-col">
          <div className="glass glass-iridescent glass-pad tgt-card" data-tour="skills.list">
            <div className="panel-head panel-head-wrap">
              {/* kicker 用 nowrap：默认 .kicker 是 inline-flex + 允许换行，
                  面板头一挤就会把「SKILLS / 106 · 已勾选 0/106」竖着排成好几行 */}
              <span className="kicker" style={{ whiteSpace: 'nowrap' }}>
                SKILLS / {shown.length}
                {pack ? ` · 已勾选 ${pickedCount}/${pack.skills.length}` : ''}
              </span>
              <div className="row gap" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <input
                  className="input"
                  data-tour="skills.search"
                  style={{ width: 140 }}
                  placeholder="搜索…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  title="重新扫描磁盘"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={12} />
                </button>
                {pack && (
                  <>
                    {/* 教程锚点：全选 / 全不选 按钮组（只作用于当前包） */}
                    <div className="row gap" data-tour="skills.select-all">
                      <button
                        className="btn btn-ghost btn-sm"
                        title="全选本包技能"
                        onClick={() => setSkillPickMany(pack.id, pack.skills.map((s) => s.name), true)}
                      >
                        全选
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        title="全不选本包技能"
                        onClick={() => setSkillPickMany(pack.id, pack.skills.map((s) => s.name), false)}
                      >
                        全不选
                      </button>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      title="打开技能包目录"
                      onClick={() => openFolder(pack.path)}
                    >
                      <FolderOpen size={12} />
                    </button>
                    {/* 教程锚点：往当前包加技能的两个来源（文件夹 / 压缩包） */}
                    <div className="row gap" data-tour="skills.import">
                      <button
                        className="btn btn-sm"
                        title="打开资源管理器多选文件夹（系统对话框不能混选文件，压缩包请用右边的按钮）"
                        disabled={importing}
                        onClick={() => void doAddSkill(pack.id, 'dir')}
                      >
                        <FolderPlus size={12} /> {importing ? '导入中…' : '选文件夹'}
                      </button>
                      <button
                        className="btn btn-sm"
                        title="打开文件对话框多选 .zip（自动解压并识别技能）"
                        disabled={importing}
                        onClick={() => void doAddSkill(pack.id, 'zip')}
                      >
                        <FileArchive size={12} /> 选压缩包
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="tgt-scroll">
              {/* `_modules` 不再单列。
                  它就是技能包里的一个子目录，随技能一起复制到客户端，
                  不是独立概念。带不带它取决于包本身，用户不需要关心。 */}

              {shown.map((s, i) => (
                <div
                  key={s.path}
                  className="pick-skill"
                  data-tour={i === 0 ? 'skills.skill-first' : undefined}
                >
                  <div className="pick-skill-row">
                    {pack && (
                      <Switch
                        on={isOn(pack.id, s.name)}
                        onChange={(next) => setOn(pack.id, s.name, next)}
                        label={s.title || s.name}
                        size="sm"
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row gap" style={{ alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 700, fontSize: 11.5 }}>{s.title || s.name}</span>
                        {s.shape === 'router' && <span className="badge badge-accent">路由+子路由</span>}
                        {s.shape === 'tree' && <span className="badge badge-neutral">带参考树</span>}
                        {!s.valid && <AlertTriangle size={10} className="text-warn" />}
                        <span className="mono sub" style={{ fontSize: 9 }}>{s.files}文件</span>
                      </div>
                      <div className="side-skill-desc">{s.description || '（无 description）'}</div>
                      {s.subSkills.length > 0 && (
                        <div className="mono sub" style={{ fontSize: 9 }}>
                          子技能：{s.subSkills.join('、')}
                        </div>
                      )}
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={() => openFolder(s.path)}>
                      <FolderOpen size={11} />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      data-tour={i === 0 ? 'skills.skill-edit' : undefined}
                      onClick={() => void openEditor(s)}
                    >
                      <Pencil size={11} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => removeSkill(s)}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
              {shown.length === 0 && pack && (
                <div className="sub">该技能包为空，用「添加技能」导入，或直接在目录里放技能。</div>
              )}
            </div>
          </div>
        </div>

        {/* 右：包信息 + 操作提示 */}
        <div className="tgt-col">
          <div className="glass glass-iridescent glass-pad tgt-card" data-tour="skills.info">
            <div className="panel-head">
              <span className="kicker">INFO / 技能包信息</span>
            </div>
            <div className="tgt-scroll">
              {pack ? (
                <>
                  <div className="kv">
                    <span>包名</span>
                    <code>{pack.id}</code>
                  </div>
                  <div className="kv">
                    <span>显示名</span>
                    <code>{pack.title || pack.id}</code>
                  </div>
                  <div className="kv">
                    <span>技能数</span>
                    <code>
                      {pack.skills.length}（勾选 {pickedCount}）
                    </code>
                  </div>
                  <div className="kv">
                    <span>目录</span>
                    <code>{pack.path}</code>
                  </div>

                  {/* 形态统计 */}
                  <div style={{ marginTop: 12 }} data-tour="skills.shapes">
                    <span className="kicker">SHAPES / 技能形态</span>
                    <div className="row gap" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                      {(['simple', 'tree', 'router'] as const).map((sh) => {
                        const n = pack.skills.filter((s) => s.shape === sh).length
                        if (n === 0) return null
                        return (
                          <span key={sh} className="badge badge-neutral">
                            {sh === 'router' ? '路由型' : sh === 'tree' ? '参考树' : '单文件'} {n}
                          </span>
                        )
                      })}
                    </div>
                  </div>

                  <div className="row gap" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" onClick={() => openFolder(pack.path)}>
                      <FolderOpen size={12} /> 打开目录
                    </button>
                    <button className="btn btn-sm" onClick={() => setRenaming({ ...pack })}>
                      <Pencil size={12} /> 重命名
                    </button>
                  </div>
                </>
              ) : (
                <div className="sub">选择左侧技能包查看详情</div>
              )}

              <div style={{ marginTop: 16 }}>
                <span className="kicker">LAYOUT / 目录规范</span>
                <pre className="rule-box" style={{ marginTop: 6 }}>{`_assets/skill/<包名>/
  pack.json          显示名与描述
  skills/
    <技能名>/
      SKILL.md       必需，含 name/description
      subskills/     可选，子路由技能
      references/    可选，参考树
      scripts/       可选，工具脚本
  `}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SKILL.md 编辑器 */}
      {editing && (
        <div className="drawer-overlay" onClick={() => setEditing(null)}>
          <div className="drawer glass glass-strong" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <span className="kicker">EDIT / SKILL.md</span>
                <div className="h2">{editing.item.title || editing.item.name}</div>
                <div className="mono sub" style={{ fontSize: 10, wordBreak: 'break-all' }}>
                  {editing.item.path}\SKILL.md
                </div>
              </div>
              <div className="row gap">
                {editing.dirty && <span className="badge badge-warn">未保存</span>}
                <button className="btn btn-primary btn-sm" disabled={!editing.dirty} onClick={() => void saveEditor()}>
                  <Save size={12} /> 保存
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                  <X size={14} />
                </button>
              </div>
            </div>
            <textarea
              className="textarea drawer-editor"
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value, dirty: true })}
              spellCheck={false}
            />
            <div className="drawer-foot">
              <span className="mono sub" style={{ fontSize: 10 }}>
                {editing.text.length} 字符 · {editing.text.split('\n').length} 行
                {editing.item.valid ? (
                  <span className="text-ok"> · frontmatter 合规</span>
                ) : (
                  <span className="text-warn"> · frontmatter 不合规</span>
                )}
              </span>
              <button className="btn btn-danger btn-sm" onClick={() => removeSkill(editing.item)}>
                <Trash2 size={12} /> 删除技能
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名技能包 */}
      {renaming && (
        <Modal title="重命名技能包" onClose={() => setRenaming(null)} width={460}>
          <div className="form-col">
            <div className="sub mono" style={{ fontSize: 10.5 }}>
              包名（目录名）不可改：{renaming.id}
            </div>
            <label className="field">
              <span>显示名</span>
              <input
                className="input"
                autoFocus
                value={renaming.title}
                onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
              />
            </label>
            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setRenaming(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void doRename()}>
                <Save size={13} /> 保存
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 新建技能包 */}
      {newPack && (
        <Modal title="新建技能包" onClose={() => setNewPack(null)} width={460}>
          <div className="form-col">
            <div className="sub">
              会创建 <code>_assets/skill/&lt;包名&gt;/skills/</code>，之后可用「添加技能」导入技能目录。
            </div>
            <label className="field">
              <span>包名（英文/数字/-_）</span>
              <input
                className="input mono"
                autoFocus
                placeholder="my-pack"
                value={newPack.id}
                onChange={(e) => setNewPack({ ...newPack, id: e.target.value })}
              />
            </label>
            <label className="field">
              <span>显示名（可留空）</span>
              <input
                className="input"
                placeholder="我的技能包"
                value={newPack.title}
                onChange={(e) => setNewPack({ ...newPack, title: e.target.value })}
              />
            </label>
            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setNewPack(null)}>取消</button>
              <button className="btn btn-primary" disabled={!newPack.id.trim()} onClick={() => void doCreatePack()}>
                <Plus size={13} /> 创建
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 导入结果（原生多选 → 自动解压 → 自动识别） */}
      {importReport && (
        <Modal title="导入结果" onClose={() => setImportReport(null)} width={640}>
          <div className="form-col">
            {importReport.imported.length > 0 && (
              <>
                <div className="row gap" style={{ alignItems: 'baseline' }}>
                  <span className="kicker">IMPORTED / {importReport.imported.length}</span>
                  <span className="sub" style={{ fontSize: 11 }}>同名技能已备份为 .bak-时间戳</span>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {importReport.imported.map((s) => (
                    <div key={s.target} className="pick-skill">
                      <div className="pick-skill-row">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="row gap" style={{ alignItems: 'baseline' }}>
                            <span style={{ fontWeight: 700, fontSize: 11.5 }}>{s.title || s.name}</span>
                            {!s.valid && <AlertTriangle size={10} className="text-warn" />}
                            <span className="mono sub" style={{ fontSize: 9 }}>{s.files}文件</span>
                            {s.backup && <span className="badge badge-warn">已备份旧版</span>}
                          </div>
                          <div className="mono sub" style={{ fontSize: 9.5, wordBreak: 'break-all' }}>
                            来源 {s.source}
                          </div>
                        </div>
                        <button className="btn btn-ghost btn-sm" onClick={() => openFolder(s.target)}>
                          <FolderOpen size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {importReport.imported.length === 0 && (
              <div className="sub">
                没有识别到技能。请确认所选文件夹或压缩包里含有 <code>SKILL.md</code>。
              </div>
            )}

            {importReport.skipped.length > 0 && (
              <div>
                <span className="kicker">SKIPPED / {importReport.skipped.length}</span>
                <pre className="rule-box" style={{ marginTop: 6, maxHeight: 160 }}>
                  {importReport.skipped.join('\n')}
                </pre>
              </div>
            )}

            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setImportReport(null)}>关闭</button>
              {pack && (
                <>
                  <button className="btn" onClick={() => void doAddSkill(pack.id, 'zip')}>
                    <FileArchive size={13} /> 再导压缩包
                  </button>
                  <button className="btn btn-primary" onClick={() => void doAddSkill(pack.id, 'dir')}>
                    <FolderPlus size={13} /> 再导文件夹
                  </button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}

      {confirmNode}
    </div>
  )
}
