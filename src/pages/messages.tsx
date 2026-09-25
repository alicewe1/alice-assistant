import { useCallback, useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { useApp } from '@/lib/app-context'
import { useStore } from '@/lib/store'
import { Topbar } from '@/components/topbar'
import * as be from '@/lib/tauri'
import type { AppliedWriteDto } from '@/lib/tauri'
import type { LogLine } from '@/types/domain'

/** 一条写入留档 + 它所属的会话名 */
type WriteRow = AppliedWriteDto & { session: string }

/**
 * 消息中心：agent 写入留档 + 运行日志。
 *
 * 会话页只留对话本身；写入记录、日志这类「看一眼就行」的信息统一进本页，
 * 右上角铃铛直达。
 */
export function Messages() {
  const { toast } = useApp()
  const { logs } = useStore()
  const [writes, setWrites] = useState<WriteRow[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await be.agentList()
      const all = await Promise.all(
        list.map(async (s) => {
          try {
            const rows = await be.agentAppliedWrites(s.name)
            return rows.map((r) => ({ ...r, session: s.name }))
          } catch {
            return []
          }
        }),
      )
      setWrites(all.flat())
    } catch (e) {
      toast(`读取失败：${String(e)}`, 'bad')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 宿主刚写入文件 → 刷新留档列表
  useEffect(() => {
    if (!be.IS_TAURI) return
    let unsub: (() => void) | undefined
    void (async () => {
      try {
        unsub = await be.onAgentWrite(() => void refresh())
      } catch {
        /* 订阅失败时静默，用户可手动刷新 */
      }
    })()
    return () => unsub?.()
  }, [refresh])

  const dismissWrite = async (w: WriteRow) => {
    try {
      await be.agentDismissWrite(w.session, w.id)
      setWrites((l) => l.filter((x) => !(x.id === w.id && x.session === w.session)))
      toast('已从列表移除（文件保持已修改状态）', 'info')
    } catch (e) {
      toast(`操作失败：${String(e)}`, 'bad')
    }
  }

  return (
    <div className="page anim-page">
      <Topbar
        kicker="MESSAGES / 消息中心"
        title="消息"
        sub="agent 写入留档与运行日志的统一入口"
        actions={
          <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>
            刷新
          </button>
        }
      />
      <div className="page-body col gap">
        <div className="glass glass-iridescent glass-pad">
          <div className="panel-head">
            <span className="kicker">
              <Bell size={11} style={{ verticalAlign: -1 }} /> APPLIED WRITES / 已修改 {writes.length}
            </span>
          </div>
          <div className="sub" style={{ fontSize: 11, marginBottom: 8 }}>
            爱丽丝按你的要求直接改完的文件（跨全部会话汇总）。原文件已备份为 <code>.bak-edit-*</code>，可手动还原。
          </div>
          {writes.length === 0 ? (
            <div className="sub" style={{ padding: '14px 0' }}>
              {loading ? '读取中…' : '暂无写入记录 —— agent 每次改完配置文件都会在这里留档。'}
            </div>
          ) : (
            writes.map((w) => (
              <div key={`${w.session}:${w.id}`} className="cfg-row" style={{ alignItems: 'flex-start' }}>
                <div className="cfg-copy" style={{ minWidth: 0 }}>
                  <div className="row gap" style={{ alignItems: 'baseline' }}>
                    <span className="chip" style={{ flex: 'none', fontSize: 10 }}>
                      {w.session}
                    </span>
                    <div className="cfg-title mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {w.path}
                    </div>
                  </div>
                  {w.reason && (
                    <div className="cfg-desc" style={{ fontSize: 11 }}>
                      {w.reason}
                    </div>
                  )}
                  <details style={{ marginTop: 6 }}>
                    <summary className="sub" style={{ fontSize: 10.5, cursor: 'pointer' }}>
                      查看改后内容（{w.content.length} 字）
                    </summary>
                    <pre className="agent-proposal-preview">{w.content}</pre>
                  </details>
                </div>
                <div className="row gap" style={{ flex: 'none' }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => void dismissWrite(w)}
                    title="从列表移除这条记录（不还原文件，文件保持已修改）"
                  >
                    知道了
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="glass glass-iridescent glass-pad">
          <div className="panel-head">
            <span className="kicker">RUNTIME LOG / 运行日志 {logs.length}</span>
          </div>
          {logs.length === 0 ? (
            <div className="sub" style={{ padding: '14px 0' }}>暂无日志。</div>
          ) : (
            <div className="log-dock-body" style={{ maxHeight: 420, overflowY: 'auto' }}>
              {[...logs].reverse().map((l: LogLine, i: number) => (
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
  )
}
