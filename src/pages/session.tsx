import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Copy,
  ImagePlus,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { Topbar, EmptyState } from '@/components/topbar'
import { Modal, useConfirm } from '@/components/modal'
import * as be from '@/lib/tauri'
import type { AgentSessionDto, ProbeCheckDto } from '@/lib/tauri'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  ts: number
  /** 本轮过程（思考 / 命令 / 工具调用），可展开查看 */
  steps?: string[]
}

export function Session() {
  const { pushLog } = useStore()
  const { toast } = useApp()
  const { confirm, confirmNode } = useConfirm()

  const [sessions, setSessions] = useState<AgentSessionDto[]>([])
  const [selName, setSelName] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState<null | string>(null)
  const [editingPrompt, setEditingPrompt] = useState<null | { text: string; dirty: boolean }>(null)
  const [checks, setChecks] = useState<ProbeCheckDto[]>([])
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [liveSteps, setLiveSteps] = useState<string[]>([])
  /** 展开查看过程的会话消息下标 */
  const [openSteps, setOpenSteps] = useState<number | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  const sel = useMemo(() => sessions.find((s) => s.name === selName) ?? null, [sessions, selName])

  const refresh = useCallback(async () => {
    if (!be.IS_TAURI) return
    setLoading(true)
    try {
      const list = await be.agentList()
      setSessions(list)
      setSelName((cur) => (cur && list.some((s) => s.name === cur) ? cur : (list[0]?.name ?? null)))
    } catch (e) {
      pushLog(`[agent] 扫描失败：${String(e)}`, 'err')
    } finally {
      setLoading(false)
    }
  }, [pushLog])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 从磁盘重读当前会话的消息（后端是唯一权威） */
  const loadMessages = useCallback(async (dir: string) => {
    try {
      const parsed = JSON.parse(await be.readText(`${dir}\\messages.json`)) as ChatMsg[]
      setMessages(Array.isArray(parsed) ? parsed : [])
    } catch {
      setMessages([])
    }
  }, [])

  // 切换会话 → 从磁盘载入消息
  useEffect(() => {
    if (!sel || !be.IS_TAURI) {
      setMessages([])
      return
    }
    setLiveSteps([])
    setOpenSteps(null)
    void loadMessages(sel.dir)
  }, [sel, loadMessages])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages.length, running])

  /** 一轮结束（进程 stdout 关闭）→ 重读磁盘并解除运行中 */
  useEffect(() => {
    if (!be.IS_TAURI) return
    let unsub: (() => void) | undefined
    let alive = true
    void (async () => {
      try {
        const off = await be.onAgentDone(() => {
          setRunning(false)
          setLiveSteps([])
          if (sel) {
            void loadMessages(sel.dir)
          }
          void refresh()
        })
        if (alive) unsub = off
        else off()
      } catch (e) {
        pushLog(`[agent] 结束事件订阅失败：${String(e)}`, 'err')
      }
    })()
    return () => {
      alive = false
      unsub?.()
    }
  }, [refresh, loadMessages, sel, pushLog])

  /**
   * 本轮过程实时推送。
   *
   * 用户要求「思考过程显示进度、可展开」——过程只进 liveSteps，不写盘；
   * 落盘的是同一批（后端在 stdout 关闭时随正文一起存进 messages.json 的 steps）。
   */
  useEffect(() => {
    if (!be.IS_TAURI) return
    let unsub: (() => void) | undefined
    let alive = true
    void (async () => {
      try {
        const off = await be.onAgentStep((session, step) => {
          if (session !== sel?.name) return
          setLiveSteps((s) => [...s, step])
        })
        if (alive) unsub = off
        else off()
      } catch {
        /* 订阅失败不致命 */
      }
    })()
    return () => {
      alive = false
      unsub?.()
    }
  }, [sel?.name])

  /**
   * 会话开始跑 → 置运行中。
   *
   * 这样切页离开再回来，仍能从事件恢复「运行中」；进页面时还会主动查一次
   * `agent_status`（见下），避免离开期间错过事件导致状态丢失。
   */
  useEffect(() => {
    if (!be.IS_TAURI) return
    let unsub: (() => void) | undefined
    let alive = true
    void (async () => {
      try {
        const off = await be.onAgentRunning((session) => {
          if (session === sel?.name) setRunning(true)
        })
        if (alive) unsub = off
        else off()
      } catch {
        /* 同上 */
      }
    })()
    return () => {
      alive = false
      unsub?.()
    }
  }, [sel?.name])

  /**
   * 进页面 / 切会话时查一次真实进程状态。
   *
   * 用户反馈「切换之后不知道 agent 是否还在运行」——不能只靠事件（切页期间
   * 事件会漏），所以以进程实况为准。进程活着 = 真的在跑这一轮，才显示
   * 「运行中」；否则一律按空闲处理。
   */
  useEffect(() => {
    if (!sel || !be.IS_TAURI) return
    let alive = true
    void (async () => {
      try {
        const r = await be.agentStatus(sel.name)
        if (alive) setRunning(!!r.ok)
      } catch {
        if (alive) setRunning(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [sel])

  /**
   * 兜底轮询：每 3 秒用进程实况校正一次 running。
   *
   * 为什么不放心事件：`agent:done` 依赖 stdout 线程正常收尾；进程被外部
   * 杀掉 / 崩溃的极端情况下事件可能缺失。轮询让状态永远贴近真相，
   * 代价可忽略（一次轻量 invoke）。
   */
  useEffect(() => {
    if (!sel || !be.IS_TAURI) return
    const t = window.setInterval(() => {
      void (async () => {
        try {
          const r = await be.agentStatus(sel.name)
          setRunning(!!r.ok)
        } catch {
          /* 网络态错误保持现值 */
        }
      })()
    }, 3000)
    return () => window.clearInterval(t)
  }, [sel])

  /**
   * 切页回来时补回「正在跑的这一轮」已产生的过程。
   *
   * 为什么需要：过程原本只在内存里（agent:step 事件 → state），切页时组件卸载、
   * 事件没人接，回来就只剩转圈。后端把每步落盘到 live_steps.json，
   * 这里进页面/切会话时读一次，运行中则每 2 秒补一次（事件漏了也能追上）。
   */
  useEffect(() => {
    if (!sel || !be.IS_TAURI) return
    let alive = true
    const pull = async () => {
      try {
        const steps = await be.agentLiveSteps(sel.name)
        if (alive) setLiveSteps(steps)
      } catch {
        /* 读不到就当没有 */
      }
    }
    void pull()
    const t = window.setInterval(() => {
      if (running) void pull()
    }, 2000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [sel, running])

  const createSession = async (name: string) => {
    const n = name.trim()
    if (!n) return
    try {
      const s = await be.agentCreate(n)
      setCreating(null)
      toast(`已新建会话「${s.name}」`, 'ok')
      await refresh()
      setSelName(s.name)
    } catch (e) {
      toast(`新建失败：${String(e)}`, 'bad')
    }
  }

  const removeSession = (s: AgentSessionDto) => {
    confirm(`删除会话「${s.name}」？该会话的提示词、技能与聊天记录都会一并删除。`, () => {
      void (async () => {
        try {
          await be.deletePath(s.dir)
          pushLog(`[agent] 已删除会话 ${s.name}`, 'ok')
          if (selName === s.name) setSelName(null)
          await refresh()
        } catch (e) {
          toast(`删除失败：${String(e)}`, 'bad')
        }
      })()
    })
  }

  /** 待发送图片（base64 预览 + 落盘后的路径） */
  const [pendingImages, setPendingImages] = useState<Array<{ path: string; dataUrl: string }>>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 把一张图收进待发送列表：读文件 → base64 → 落盘到会话 uploads/ */
  const acceptImageFile = useCallback(
    async (file: File) => {
      if (!sel) return
      if (!file.type.startsWith('image/')) {
        toast('只能传图片', 'warn')
        return
      }
      try {
        const buf = await file.arrayBuffer()
        const bytes = new Uint8Array(buf)
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        const b64 = btoa(bin)
        const ext = (file.name.split('.').pop() ?? 'png').toLowerCase()
        const path = await be.agentSaveImage(sel.name, b64, ext)
        setPendingImages((l) => [...l, { path, dataUrl: `data:${file.type};base64,${b64}` }])
      } catch (e) {
        toast(`图片接收失败：${String(e)}`, 'bad')
      }
    },
    [sel, toast],
  )

  /** 从剪贴板粘贴图片（用户要求：会话支持上传图片，粘贴是最顺手的方式） */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!sel) return
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (!files.length) return
      e.preventDefault()
      for (const f of files.slice(0, 4)) void acceptImageFile(f)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [sel, acceptImageFile])

  const send = () => {
    const text = input.trim()
    if ((!text && !pendingImages.length) || !sel || running) return
    setInput('')
    setRunning(true)
    const imgs = pendingImages.map((p) => p.path)
    setPendingImages([])
    // 用户消息由后端落盘；这里乐观显示一条，done 事件回来时以磁盘为准覆盖
    setMessages((m) => [
      ...m,
      { role: 'user', content: imgs.length ? `${text}${text ? '\n' : ''}[图片 × ${imgs.length}]` : text, ts: Date.now() },
    ])
    void be
      .agentLaunch(sel.name, text || '（看图）', imgs)
      .then((r) => {
        if (!r.ok) {
          setRunning(false)
          toast(`启动失败：${r.error ?? '未知错误'}`, 'bad')
          if (sel) void loadMessages(sel.dir)
        }
      })
      .catch((e) => {
        setRunning(false)
        toast(`异常：${String(e)}`, 'bad')
        if (sel) void loadMessages(sel.dir)
      })
  }

  const stopRun = () => {
    if (!sel) return
    // 只停本会话的进程树 —— 不用 codexStop（那是全量清扫，会顺手杀掉
    // Alice-codex 页启动的 CLI / 桌面端）
    void be.agentStop(sel.name).then(() => {
      setRunning(false)
      setLiveSteps([])
      void loadMessages(sel.dir)
    })
  }

  const openPromptEditor = async () => {
    if (!sel) return
    try {
      setEditingPrompt({ text: await be.readText(sel.promptPath), dirty: false })
    } catch (e) {
      toast(`读提示词失败：${String(e)}`, 'bad')
    }
  }

  const savePrompt = async () => {
    if (!sel || !editingPrompt) return
    try {
      await be.saveFileText(sel.promptPath, editingPrompt.text)
      setEditingPrompt({ ...editingPrompt, dirty: false })
      toast('提示词已保存（原文件备份 .bak-edit-*）', 'ok')
    } catch (e) {
      toast(`保存失败：${String(e)}`, 'bad')
    }
  }

  /** 拉一次体检项，用于界面上显示「N/M 项通过」的概览（快照由后端生成） */
  const loadChecks = async () => {
    try {
      const rep = await be.engineProbe()
      setChecks(rep.checks)
    } catch (e) {
      toast(`体检失败：${String(e)}`, 'bad')
    }
  }

  useEffect(() => {
    void loadChecks()
  }, [])

  /** 刷新快照：后端重建「工具箱当前配置」并重挂技能，agent 下一轮就看到新值 */
  const refreshSnapshot = async () => {
    if (!sel) return
    setSnapshotBusy(true)
    try {
      await be.agentRefreshSnapshot(sel.name)
      await loadChecks()
      toast('快照已刷新，爱丽丝下一轮就能看到最新配置', 'ok')
    } catch (e) {
      toast(`刷新失败：${String(e)}`, 'bad')
    } finally {
      setSnapshotBusy(false)
    }
  }

  return (
    <div className="page anim-page">
      <Topbar
        kicker="AGENT / Agent 助手"
        title="Agent 会话"
        sub="独立提示词与单一技能 · 模型取自 Alice-codex 配置"
        actions={
          <>
            <button className="btn" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={13} /> {loading ? '扫描中…' : '重新扫描'}
            </button>
            <button className="btn btn-primary" data-tour="session.new" onClick={() => setCreating('')}>
              <Plus size={13} /> 新建会话
            </button>
          </>
        }
      />

      <div className="page-body tgt-workspace" style={{ gridTemplateColumns: 'minmax(0, 220px) minmax(0, 1fr)' }}>
        {/* ========== 左：历史会话栏目 ========== */}
        <div className="tgt-col">
          <div className="glass glass-iridescent glass-pad tgt-card" data-tour="session.list">
            <div className="panel-head">
              <span className="kicker">SESSIONS / {sessions.length}</span>
            </div>
            <div className="tgt-scroll">
              {sessions.length === 0 ? (
                <div className="sub" style={{ padding: '8px 4px' }}>
                  {be.IS_TAURI ? '还没有会话，点右上「新建会话」。' : '浏览器预览无法读磁盘'}
                </div>
              ) : (
                sessions.map((s, i) => (
                  <div
                    key={s.name}
                    className={`card-row${selName === s.name ? ' selected' : ''}`}
                    data-tour={i === 0 ? 'session.row-first' : undefined}
                    onClick={() => setSelName(s.name)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row gap" style={{ alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 800, fontSize: 12.5 }}>{s.name}</span>
                        {s.skillName ? (
                          <span className="badge badge-ok">已挂技能</span>
                        ) : (
                          <span className="badge badge-warn">未挂技能</span>
                        )}
                      </div>
                      <div className="sub" style={{ fontSize: 10.5 }}>
                        {s.messageCount} 条 · {s.sessionId ? '可续聊' : '未开始'}
                      </div>
                    </div>
                    <div className="rail-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        title="删除这个会话"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeSession(s)
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

        {/* ========== 右：会话 UI ========== */}
        <div className="tgt-col">
          {!sel ? (
            <div className="glass glass-iridescent glass-pad tgt-card">
              <EmptyState
                icon={<Bot size={30} />}
                title="选择左侧会话"
                hint="每个会话有独立提示词；技能固定为内置 alice_agent-skill"
              />
            </div>
          ) : (
            <>
              {/* 配置条：一行收纳提示词/技能/体检，点开才展开细节 —— 给会话腾地方 */}
              <div
                className="glass glass-iridescent glass-pad"
                data-tour="session.config"
                style={{ marginBottom: 10, padding: '8px 12px' }}
              >
                <div className="row gap" style={{ alignItems: 'center' }}>
                  <button
                    className="btn btn-sm"
                    data-tour="session.prompt-btn"
                    onClick={() => void openPromptEditor()}
                    title={sel.promptPath}
                  >
                    提示词
                  </button>
                  <span
                    className="badge badge-neutral"
                    data-tour="session.skill"
                    title="固定技能：自检 + 限定工作范围（不可更换）"
                    style={{ cursor: 'default' }}
                  >
                    alice_agent-skill
                  </span>
                  <span
                    className="badge badge-neutral"
                    data-tour="session.checks"
                    style={{ cursor: 'default' }}
                    title={checks.map((c) => `${c.label}: ${c.ok ? '通过' : '失败'}${c.detail ? ' — ' + c.detail : ''}`).join('\n') || '读取中…'}
                  >
                    {checks.length ? `${checks.filter((c) => c.ok).length}/${checks.length} 体检` : '体检…'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-ghost btn-sm" onClick={() => void loadChecks()} title="重跑体检">
                    <RefreshCw size={12} />
                  </button>
                  <button
                    className="btn btn-sm"
                    data-tour="session.snapshot"
                    disabled={snapshotBusy}
                    onClick={() => void refreshSnapshot()}
                    title="重建「工具箱当前配置」快照并重挂技能，爱丽丝下一轮即可看到最新配置"
                  >
                    {snapshotBusy ? '刷新中…' : '刷新快照'}
                  </button>
                </div>
                {/* 体检失败时才展开红项，不占常驻空间 */}
                {checks.some((c) => !c.ok) && (
                  <div className="skill-chips" style={{ marginTop: 6 }}>
                    {checks.filter((c) => !c.ok).map((c) => (
                      <span key={c.key} className="chip chip-bad" style={{ cursor: 'default' }} title={c.detail}>
                        {c.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* 对话 */}
              <div className="glass transcript" data-tour="session.thread" ref={scrollRef} style={{ marginBottom: 12 }}>
                {messages.length === 0 && (
                  <div className="sub" style={{ padding: 20 }}>
                    就绪。输入 <code>alice</code> 会得到「助手在线」；其余按正常任务处理。
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`msg msg-${m.role}`}>
                    <div className="msg-role">
                      {m.role === 'user' ? 'USER' : 'AGENT'}
                      {m.role === 'assistant' && m.content && (
                        <button
                          className="agent-copy"
                          title="复制回复"
                          onClick={() => {
                            void navigator.clipboard.writeText(m.content)
                            toast('已复制', 'ok')
                          }}
                        >
                          <Copy size={11} />
                        </button>
                      )}
                    </div>
                    <div className="msg-bubble">{m.content || (m.steps?.length ? '（本轮无正文）' : '')}</div>
                    {/*
                      过程可展开：用户要求「思考过程显示进度、可展开」。
                      默认收起，避免刷屏；点一下看思考/命令/工具调用明细。
                    */}
                    {!!m.steps?.length && (
                      <div className="agent-steps">
                        <button
                          className="agent-steps-toggle"
                          onClick={() => setOpenSteps(openSteps === i ? null : i)}
                        >
                          {openSteps === i ? '▾' : '▸'} 过程 {m.steps.length} 步
                        </button>
                        {openSteps === i && (
                          <ol className="agent-steps-list">
                            {m.steps.map((s, k) => (
                              <li key={k}>{s}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {running && (
                  <div className="msg msg-assistant">
                    <div className="msg-role">AGENT · 运行中</div>
                    {liveSteps.length > 0 ? (
                      <div className="agent-steps">
                        <button
                          className="agent-steps-toggle"
                          onClick={() => setOpenSteps(openSteps === -1 ? null : -1)}
                        >
                          {openSteps === -1 ? '▾' : '▸'} 过程 {liveSteps.length} 步（实时）
                        </button>
                        {openSteps === -1 && (
                          <ol className="agent-steps-list">
                            {liveSteps.map((s, k) => (
                              <li key={k}>{s}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    ) : (
                      <div className="msg-bubble shimmer" style={{ width: 200, height: 13, borderRadius: 6 }} />
                    )}
                  </div>
                )}
              </div>

              {/* 输入区 */}
              <div className="composer glass-strong" data-tour="session.composer" style={{ borderRadius: 14, flex: 'none' }}>
                {pendingImages.length > 0 && (
                  <div className="row gap" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                    {pendingImages.map((p, i) => (
                      <div key={i} className="agent-img-chip">
                        <img src={p.dataUrl} alt={`待发送图片 ${i + 1}`} />
                        <button
                          className="agent-img-chip-x"
                          onClick={() => setPendingImages((l) => l.filter((_, k) => k !== i))}
                          title="移除"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="prompt-line">
                  <span className="prompt-char">&gt;_</span>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 52 }}
                    placeholder="与 Agent 对话…（Enter 发送 · Shift+Enter 换行 · 可直接粘贴图片）"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        send()
                      }
                    }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      for (const f of Array.from(e.target.files ?? []).slice(0, 4)) {
                        void acceptImageFile(f)
                      }
                      e.target.value = ''
                    }}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ flex: 'none', alignSelf: 'center' }}
                    onClick={() => fileInputRef.current?.click()}
                    title="上传图片（也可直接 Ctrl+V 粘贴）"
                  >
                    <ImagePlus size={14} />
                  </button>
                </div>
                <div className="row gap" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                  {/*
                    运行中同时给「发送」与「停止」：用户可以排队下一条，
                    也能随时掐掉当前这轮。停止只杀本会话的进程树。
                  */}
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={send}
                    disabled={(!input.trim() && !pendingImages.length) || running}
                    title={running ? '当前一轮还没结束' : '发送（Enter）'}
                  >
                    <Play size={12} /> 发送
                  </button>
                  {running && (
                    <button className="btn btn-danger btn-sm" onClick={stopRun}>
                      <Square size={12} /> 停止
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 新建会话 */}
      {creating !== null && (
        <Modal title="新建 Agent 会话" onClose={() => setCreating(null)} width={440}>
          <label className="field">
            <span>会话名（= 存储目录名）</span>
            <input
              className="input"
              autoFocus
              placeholder="例如：工具箱自检"
              value={creating}
              onChange={(e) => setCreating(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createSession(creating)
              }}
            />
          </label>
          <div className="sub" style={{ fontSize: 10.5, marginTop: 8 }}>
            存在 <code>resources/_assets/agent/&lt;会话名&gt;/</code>，内含 prompt.md、skills/、聊天记录。
          </div>
          <div className="row gap" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={() => setCreating(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void createSession(creating)}>
              <Plus size={13} /> 创建
            </button>
          </div>
        </Modal>
      )}

      {/* 提示词编辑 */}
      {editingPrompt && sel && (
        <div className="drawer-overlay" onClick={() => setEditingPrompt(null)}>
          <div className="drawer glass glass-strong" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <span className="kicker">EDIT / prompt.md</span>
                <div className="h2">{sel.name}</div>
                <div className="mono sub" style={{ fontSize: 10, wordBreak: 'break-all' }}>
                  {sel.promptPath}
                </div>
              </div>
              <div className="row gap">
                {editingPrompt.dirty && <span className="badge badge-warn">未保存</span>}
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!editingPrompt.dirty}
                  onClick={() => void savePrompt()}
                >
                  <Save size={12} /> 保存
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingPrompt(null)}>
                  <X size={14} />
                </button>
              </div>
            </div>
            <textarea
              className="textarea drawer-editor"
              value={editingPrompt.text}
              onChange={(e) => setEditingPrompt({ text: e.target.value, dirty: true })}
              spellCheck={false}
            />
            <div className="drawer-foot">
              <span className="sub" style={{ fontSize: 10.5 }}>
                这是本会话的配置文件，保存后下一轮对话立即生效（原文件自动备份 .bak-edit-*）
              </span>
            </div>
          </div>
        </div>
      )}

      {confirmNode}
    </div>
  )
}
