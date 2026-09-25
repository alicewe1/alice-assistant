import type { ReactNode } from 'react'
import { GraduationCap } from 'lucide-react'
import { useTour } from '@/components/tour'

/**
 * 页头。右侧动作区由页面自己传 `actions`，本组件在其前面固定插入
 * 「使用教程」按钮（见下）。
 */
export function Topbar({
  kicker,
  title,
  sub,
  subNode,
  actions,
}: {
  kicker: string
  title: string
  sub?: string
  /** 富文本副标题（优先于 sub）—— 需要内嵌彩色标签时用 */
  subNode?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="topbar">
      <div className="topbar-meta">
        <span className="kicker">{kicker}</span>
        <h1 className="h1">{title}</h1>
        {subNode ? <div className="sub">{subNode}</div> : sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="row gap">
        <TourButton />
        {actions}
      </div>
    </header>
  )
}

/**
 * 「使用教程」入口。
 *
 * ══ 为什么挂在 Topbar 而不是各页自己加 ═══════════════════════════════
 * 每个页面的 Topbar 都长一样、位置也固定在本页标题右边，把按钮放进
 * Topbar 就自动出现在全部页面的同一个位置，用户不用满界面找。
 * 且各页新增/删除时不会漏掉挂按钮这一步。
 *
 * 当前页没有配教程时按钮**直接不渲染** —— 宁可没有入口，也不给一个
 * 点开是空的按钮（那种按钮比没有更让人困惑）。
 */
function TourButton() {
  const { available, running, start, stepCount } = useTour()
  if (!available) return null
  return (
    <button
      className={`btn tutorial-btn${running ? ' on' : ''}`}
      disabled={running}
      onClick={start}
      title={`${stepCount} 步图文指引：告诉你当前页面每一项是干什么的、该怎么点`}
      data-tour="page.tutorial-btn"
    >
      <GraduationCap size={13} />
      使用教程
      <span className="tutorial-btn-n">{stepCount}</span>
    </button>
  )
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <div className="h2">{title}</div>
      {hint && <div className="sub">{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  )
}
