import { useCallback, useEffect, useMemo, useState } from 'react'
import { FilePlus, FileText, FolderOpen, FolderPlus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { Topbar, EmptyState } from '@/components/topbar'
import { Modal, useConfirm } from '@/components/modal'
import * as be from '@/lib/tauri'
import type { PromptItemDto } from '@/lib/tauri'

export function Prompts() {
  const { openFolder, pushLog } = useStore()
  const { toast } = useApp()
  const { confirm, confirmNode } = useConfirm()

  const [items, setItems] = useState<PromptItemDto[]>([])
  const [loading, setLoading] = useState(false)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [filter, setFilter] = useState('')
  /** 添加提示词：文件多选 / 文件夹多选，共用一份进度与结果 */
  const [adding, setAdding] = useState(false)
  const [addReport, setAddReport] = useState<be.ImportManyResultDto | null>(null)

  const refresh = useCallback(async () => {
    if (!be.IS_TAURI) return
    setLoading(true)
    try {
      const list = await be.scanPrompts()
      setItems(list)
      if (list.length && !activePath) void load(list[0].path)
    } catch (e) {
      pushLog(`[prompts] 扫描失败：${String(e)}`, 'err')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushLog])

  const load = async (path: string, force = false) => {
    // 有未保存改动时不许静默丢弃 —— 弹确认，用户取消就留在原地
    if (!force && dirty) {
      confirm('当前文件有未保存的修改，放弃并切换？', async () => {
        await load(path, true)
      })
      return
    }
    try {
      const t = await be.readFileText(path)
      setText(t)
      setActivePath(path)
      setDirty(false)
    } catch (e) {
      toast(`读取失败：${String(e)}`, 'bad')
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = useMemo(() => items.find((i) => i.path === activePath) ?? null, [items, activePath])

  const shown = useMemo(() => {
    if (!filter.trim()) return items
    const k = filter.toLowerCase()
    return items.filter(
      (i) => i.file.toLowerCase().includes(k) || i.preview.toLowerCase().includes(k) || i.source.toLowerCase().includes(k),
    )
  }, [items, filter])

  const save = async () => {
    if (!activePath) return
    try {
      await be.saveFileText(activePath, text)
      toast('已保存（原文件备份为 .bak-edit-*）', 'ok')
      pushLog(`[prompts] 保存 ${activePath}`, 'ok')
      setDirty(false)
      void refresh()
    } catch (e) {
      toast(`保存失败：${String(e)}`, 'bad')
    }
  }

  const remove = (item: PromptItemDto) => {
    confirm(`删除提示词文件「${item.file}」？\n路径：${item.path}\n此操作不可撤销。`, async () => {
      try {
        await be.deletePath(item.path)
        toast(`已删除 ${item.file}`, 'warn')
        pushLog(`[prompts] 删除 ${item.path}`, 'warn')
        if (activePath === item.path) {
          setActivePath(null)
          setText('')
          setDirty(false)
        }
        void refresh()
      } catch (e) {
        toast(`删除失败：${String(e)}`, 'bad')
      }
    })
  }

  /**
   * 添加提示词：kind='file' 多选 .md 文件，kind='dir' 多选文件夹（递归收 .md）。
   * 后端负责识别 + 复制进 _assets/prompts，同名先备份，绝不静默覆盖。
   */
  const addPrompts = async (kind: 'file' | 'dir') => {
    if (!be.IS_TAURI) {
      toast('浏览器预览无法打开系统对话框', 'warn')
      return
    }
    setAdding(true)
    setAddReport(null)
    try {
      const paths = await be.pickImportSources(kind)
      if (!paths.length) {
        setAdding(false)
        return
      }
      const r = await be.importPromptMulti(paths)
      setAddReport(r)
      if (r.imported.length) {
        toast(`已添加 ${r.imported.length} 个提示词`, 'ok')
        pushLog(`[prompts] 添加 ${r.imported.length} 个提示词文件`, 'ok')
        void refresh()
      } else {
        toast('没有识别到 .md 提示词文件', 'warn')
      }
    } catch (e) {
      toast(`添加失败：${String(e)}`, 'bad')
    } finally {
      setAdding(false)
    }
  }

  const totalKB = (items.reduce((n, i) => n + i.size, 0) / 1024).toFixed(1)

  return (
    <div className="page anim-page">
      <Topbar
        kicker="PROMPTS / 提示词"
        title="提示词（磁盘实际文件）"
        sub={`共 ${items.length} 个文件 · ${totalKB} KB · 只扫描 _assets/prompts，新添加的文件也落在这里`}
        actions={
          <>
            {/* 「已读磁盘」徽章已删除（用户反馈太丑、无信息量）。
                浏览器预览模式下 backendLive 为 false，添加/保存会在下面各自提示。 */}
            <button className="btn" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={13} /> {loading ? '扫描中…' : '重新扫描'}
            </button>
            <button
              className="btn"
              data-tour="prompts.add-file"
              disabled={!be.IS_TAURI || adding}
              title="从磁盘添加提示词文件（可多选，支持一次选多个 .md）"
              onClick={() => void addPrompts('file')}
            >
              <FilePlus size={13} /> {adding ? '添加中…' : '添加提示词'}
            </button>
            <button
              className="btn"
              data-tour="prompts.add-dir"
              disabled={!be.IS_TAURI || adding}
              title="从磁盘添加整个提示词文件夹（递归收 .md）"
              onClick={() => void addPrompts('dir')}
            >
              <FolderPlus size={13} /> 添加文件夹
            </button>
            <button className="btn btn-primary" data-tour="prompts.save" disabled={!dirty} onClick={() => void save()}>
              <Save size={13} /> 保存
            </button>
          </>
        }
      />

      <div className="page-body tgt-workspace prompt-workspace">
        {/* 左：文件列表（磁盘真实文件，独立滚动） */}
        <div className="tgt-col">
          <div className="glass glass-iridescent glass-pad tgt-card" data-tour="prompts.files">
            <div className="panel-head">
              <span className="kicker">FILES / {shown.length}</span>
              {filter && (
                <button className="btn btn-ghost btn-sm" onClick={() => setFilter('')}>
                  <X size={11} /> 清空
                </button>
              )}
            </div>
            <input
              className="input"
              data-tour="prompts.search"
              placeholder="搜索文件名 / 内容…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ marginBottom: 8, flex: 'none' }}
            />
            <div className="tgt-scroll">
              {shown.length === 0 ? (
                <div className="sub">
                  {be.IS_TAURI ? '未发现提示词文件' : '浏览器预览模式无法读磁盘'}
                </div>
              ) : (
                shown.map((i, idx) => (
                  <div
                    key={i.path}
                    className={`card-row${i.path === activePath ? ' selected' : ''}`}
                    data-tour={idx === 0 ? 'prompts.file-first' : undefined}
                    onClick={() => void load(i.path)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row gap" style={{ alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 700, fontSize: 12.5 }}>{i.file}</span>
                      </div>
                      <div className="mono sub" style={{ fontSize: 9.5 }}>
                        {i.source} · {(i.size / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); remove(i) }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* 右：正文编辑 */}
        <div className="tgt-col">
          <div className="glass glass-iridescent glass-pad tgt-card">
            {!active ? (
              <EmptyState icon={<FileText size={34} />} title="选择左侧文件" hint="正文直接读写磁盘上的 .md" />
            ) : (
              <>
                <div className="panel-head" data-tour="prompts.editor">
                  <div className="panel-kicker">
                    <span className="kicker">EDITOR / 正文</span>
                    <div className="row gap" style={{ alignItems: 'baseline' }}>
                      <h2 className="h2">{active.file}</h2>
                    </div>
                    <div className="mono sub" style={{ fontSize: 10, wordBreak: 'break-all' }}>
                      {active.path}
                    </div>
                  </div>
                  <div className="row gap">
                    {dirty && <span className="badge badge-warn">未保存</span>}
                    <button className="btn" onClick={() => openFolder(active.path)} title="打开所在目录">
                      <FolderOpen size={13} />
                    </button>
                    <button className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => void save()}>
                      <Save size={12} /> 保存
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => void load(active.path)}
                      title="放弃修改并重新读取"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>

                <div className="tgt-scroll">
                  {active.preview && (
                    <div className="rule-box" data-tour="prompts.preview" style={{ marginBottom: 10 }}>
                      <span className="kicker">PREVIEW / 正文首行</span>
                      <div style={{ marginTop: 4 }}>{active.preview}</div>
                    </div>
                  )}

                  <textarea
                    className="textarea"
                    style={{ minHeight: 460, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value)
                      setDirty(true)
                    }}
                    spellCheck={false}
                  />
                  <div className="mono sub" style={{ fontSize: 10, marginTop: 6 }}>
                    {text.length} 字符 · {text.split('\n').length} 行 · 磁盘 {(active.size / 1024).toFixed(1)} KB
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 添加结果：识别到的文件 + 被跳过的原因 */}
      {addReport && (
        <Modal title="添加结果" onClose={() => setAddReport(null)} width={640}>
          <div className="form-col">
            {addReport.imported.length > 0 && (
              <>
                <div className="row gap" style={{ alignItems: 'baseline' }}>
                  <span className="kicker">ADDED / {addReport.imported.length}</span>
                  <span className="sub" style={{ fontSize: 11 }}>同名文件已备份为 .bak-时间戳</span>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {addReport.imported.map((s) => (
                    <div key={s.target} className="pick-skill">
                      <div className="pick-skill-row">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="row gap" style={{ alignItems: 'baseline' }}>
                            <span style={{ fontWeight: 700, fontSize: 11.5 }}>{s.name}</span>
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

            {addReport.imported.length === 0 && (
              <div className="sub">
                没有识别到提示词。请确认所选内容里有 <code>.md</code> 文件。
              </div>
            )}

            {addReport.skipped.length > 0 && (
              <div>
                <span className="kicker">SKIPPED / {addReport.skipped.length}</span>
                <pre className="rule-box" style={{ marginTop: 6, maxHeight: 160 }}>
                  {addReport.skipped.join('\n')}
                </pre>
              </div>
            )}

            <div className="row gap" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setAddReport(null)}>关闭</button>
              <button className="btn" onClick={() => void addPrompts('dir')}>
                <FolderPlus size={13} /> 再添文件夹
              </button>
              <button className="btn btn-primary" onClick={() => void addPrompts('file')}>
                <FilePlus size={13} /> 再添文件
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmNode}
    </div>
  )
}
