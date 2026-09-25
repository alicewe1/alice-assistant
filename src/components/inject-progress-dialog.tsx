import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import * as be from '@/lib/tauri'
import type { InjectProgressItem } from '@/lib/tauri'

interface Line {
  key: string
  label: string
  /** pending → 待办；ok → 成功；bad → 失败；skip → 无需处理 */
  state: 'pending' | 'ok' | 'bad' | 'skip'
}

/**
 * 安装 / 卸载进度弹窗。
 *
 * 关键设计：**待办清单由前端自己算好传进来**（plan prop），不依赖后端事件。
 *
 * 为什么：后端事件是「边做边发」，而弹窗是点按钮后才挂载的 ——
 * 等 React 渲染出来，前面几步的事件早发完了。之前试图让后端先发一个
 * plan 事件来解决，但同步命令阻塞主线程，弹窗根本来不及挂载，
照样收不到。
 * 现在清单在父组件点按钮时就构造好（那时数据都在手上），弹窗一挂载
 * 就有完整列表；后端的 inject:progress 事件只负责把对应行点亮。
 *
 * 完成后停在结果页，**由用户点关闭** —— 不自动消失，方便逐条核对。
 */
export function InjectProgressDialog({
  phase,
  title,
  /** 待办清单（父组件按当前预设组算出，含每项的 key 与显示文案） */
  plan,
  /** 后端命令是否仍在执行（父组件的 busy）—— false 即已返回，进入结果页 */
  running,
  onClose,
}: {
  phase: 'install' | 'uninstall'
  title: string
  plan: { key: string; label: string }[]
  running: boolean
  onClose: () => void
}) {
  // 初始就用 plan 铺满（全部待办态），保证弹窗一出现就有内容
  const [lines, setLines] = useState<Line[]>(() =>
    plan.map((p) => ({ key: p.key, label: p.label, state: 'pending' as const })),
  )
  const [finished, setFinished] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  // plan 变化（例如父组件后补了清单）→ 合并：保留已有结果态，补上新项
  useEffect(() => {
    setLines((cur) => {
      if (cur.length === 0) {
        return plan.map((p) => ({ key: p.key, label: p.label, state: 'pending' as const }))
      }
      const known = new Set(cur.map((l) => l.key))
      const extra = plan
        .filter((p) => !known.has(p.key))
        .map((p) => ({ key: p.key, label: p.label, state: 'pending' as const }))
      return extra.length ? [...cur, ...extra] : cur
    })
  }, [plan])

  // 后端返回（running=false）→ 进入结果页。
  // 留一小段缓冲：事件可能比返回值晚到几个 tick，别把列表定格在半路。
  useEffect(() => {
    if (running) {
      setFinished(false)
      return
    }
    const t = setTimeout(() => {
      setFinished(true)
      /**
       * 兜底：把结束时仍是「待办」的行标成「跳过」。
       *
       * 后端某些步骤在特定条件下不会发事件（例如技能目录已被前一步清空、
       * 或清单里没有已装技能）。不兜这一层，那些行就永远显示「待办」，
       * 用户以为卡住了 —— 实测就是这个现象（截图里「清理技能」一直待办）。
       */
      setLines((cur) =>
        cur.map((l) => (l.state === 'pending' ? { ...l, state: 'skip' as const } : l)),
      )
    }, 600)
    return () => clearTimeout(t)
  }, [running])

  // 收逐项结果：点亮对应行
  useEffect(() => {
    let alive = true
    void be.onEvent<InjectProgressItem>('inject:progress', (p) => {
      if (!alive || p.phase !== phase) return
      setLines((cur) => {
        const i = cur.findIndex((l) => l.key === p.key)
        if (i >= 0) {
          const next = cur.slice()
          next[i] = { key: p.key, label: p.label, state: p.ok ? 'ok' : 'bad' }
          return next
        }
        // 清单里没预列的项（如按状态动态决定的）→ 追加
        return [...cur, { key: p.key, label: p.label, state: p.ok ? 'ok' : 'bad' }]
      })
    })
    return () => {
      alive = false
    }
  }, [phase])

  // 自动滚到最新
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [lines])

  const okCount = lines.filter((l) => l.state === 'ok').length
  const badCount = lines.filter((l) => l.state === 'bad').length
  const skipCount = lines.filter((l) => l.state === 'skip').length
  /** 已处理数（成功 + 失败；「无需处理」不计入进度分子） */
  const doneCount = okCount + badCount

  return (
    <div className="modal-overlay" onClick={finished ? onClose : undefined}>
      <div
        className="glass glass-strong modal-card anim-pop"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <span className="kicker">
              {phase === 'install' ? 'INSTALL / 注入进度' : 'UNINSTALL / 还原进度'}
            </span>
            <div className="h2">{title}</div>
          </div>
          {finished && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              <X size={15} />
            </button>
          )}
        </div>

        {/* 汇总 */}
        <div className="row gap" style={{ padding: '0 20px 10px', alignItems: 'center' }}>
          {finished ? (
            <>
              <span className={`badge ${badCount ? 'badge-bad' : 'badge-ok'}`}>
                {badCount ? `失败 ${badCount}` : `全部成功 ${okCount}`}
              </span>
              {skipCount > 0 && (
                <span className="badge badge-neutral">无需处理 {skipCount}</span>
              )}
              <span className="badge badge-neutral">共 {lines.length} 项</span>
              {badCount > 0 && (
                <span className="sub" style={{ fontSize: 11 }}>失败项见下方 ⚠</span>
              )}
            </>
          ) : (
            <>
              <Loader2 size={14} className="spin" />
              <span className="sub" style={{ fontSize: 11 }}>
                执行中… 已完成 {doneCount} / {lines.length}
              </span>
            </>
          )}
        </div>

        {/* 逐项列表 */}
        <div
          ref={listRef}
          className="tgt-scroll"
          style={{ maxHeight: 340, minHeight: 120, padding: '0 12px 12px' }}
        >
          {lines.length === 0 && (
            <div className="sub" style={{ padding: 10, fontSize: 11 }}>
              没有需要处理的注入点
            </div>
          )}
          {lines.map((l) => (
            <div key={l.key} className="prog-line">
              {l.state === 'pending' ? (
                <span
                  style={{
                    flex: 'none',
                    width: 13,
                    height: 13,
                    borderRadius: '50%',
                    border: '1.5px solid var(--hairline-strong)',
                  }}
                />
              ) : l.state === 'ok' ? (
                <Check size={13} style={{ flex: 'none', color: 'var(--ok)' }} />
              ) : l.state === 'skip' ? (
                // 无需处理：不是失败，用灰点区分（如技能目录本就没有内容）
                <span
                  style={{
                    flex: 'none',
                    width: 13,
                    height: 13,
                    borderRadius: '50%',
                    background: 'var(--hairline-strong)',
                  }}
                />
              ) : (
                <AlertTriangle size={13} style={{ flex: 'none', color: 'var(--bad)' }} />
              )}
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color:
                    l.state === 'bad'
                      ? 'var(--bad)'
                      : l.state === 'skip'
                        ? 'var(--muted)'
                        : 'var(--ink)',
                }}
                title={l.key}
              >
                {l.label}
              </span>
              <span className="badge" style={{ flex: 'none' }}>
                {l.state === 'pending'
                  ? '待办'
                  : l.state === 'ok'
                    ? '成功'
                    : l.state === 'skip'
                      ? '无需处理'
                      : '失败'}
              </span>
            </div>
          ))}
        </div>

        <div
          className="row gap"
          style={{
            justifyContent: 'flex-end',
            padding: '10px 20px 14px',
            borderTop: '1px solid var(--hairline)',
          }}
        >
          {finished ? (
            <button className="btn btn-primary" onClick={onClose}>
              关闭
            </button>
          ) : (
            <span className="sub" style={{ fontSize: 10.5 }}>执行中，请稍候…</span>
          )}
        </div>
      </div>
    </div>
  )
}
