import { useEffect, useState } from 'react'
import { Moon, Sun, Bell } from 'lucide-react'
import {
  LayoutDashboard,
  MessageSquareCode,
  ScrollText,
  TerminalSquare,
  CloudCog,
  MapPin,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useApp } from '@/lib/app-context'
import { useStore } from '@/lib/store'
import * as be from '@/lib/tauri'

export type PageId =
  | 'dashboard'
  | 'targets'
  | 'skills'
  | 'prompts'
  | 'session'
  | 'messages'
  | 'runtime'
  | 'cloud'

export const TOPNAV: { id: PageId; idx: string; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', idx: '01', label: '总览', icon: LayoutDashboard },
  { id: 'targets', idx: '02', label: '目标', icon: MapPin },
  { id: 'skills', idx: '03', label: '技能库', icon: Sparkles },
  { id: 'prompts', idx: '04', label: '提示词', icon: ScrollText },
  { id: 'session', idx: '05', label: '会话', icon: MessageSquareCode },
  { id: 'runtime', idx: '06', label: 'Alice-codex', icon: TerminalSquare },
  { id: 'cloud', idx: '07', label: '云过审', icon: CloudCog },
]

/**
 * 通知铃铛：agent 写入留档 / 运行日志的统一入口（消息中心页）。
 *
 * 未读徽标 = 本页没打开时发生的新事件数（写入留档、warn/err 日志）。
 * 进消息中心即清零。
 */
function NotificationBell({ page, onNavigate }: { page: PageId; onNavigate: (p: PageId) => void }) {
  const [unread, setUnread] = useState(0)

  // 离开消息中心后，新写入事件与 warn/err 日志累计未读
  useEffect(() => {
    if (!be.IS_TAURI) return
    let unsubW: (() => void) | undefined
    let unsubL: (() => void) | undefined
    void (async () => {
      try {
        unsubW = await be.onAgentWrite(() => {
          if (page !== 'messages') setUnread((n) => n + 1)
        })
      } catch {
        /* 订阅失败静默：徽标只是提示，不影响功能 */
      }
      try {
        unsubL = await be.onRuntimeLog((_text, kind) => {
          if (page !== 'messages' && (kind === 'warn' || kind === 'err')) setUnread((n) => n + 1)
        })
      } catch {
        /* 同上 */
      }
    })()
    return () => {
      unsubW?.()
      unsubL?.()
    }
  }, [page])

  // 打开消息中心 = 全部已读
  useEffect(() => {
    if (page === 'messages') setUnread(0)
  }, [page])

  return (
    <button
      className="btn btn-ghost btn-sm"
      style={{ position: 'relative' }}
      onClick={() => onNavigate('messages')}
      title="消息中心：写入留档与运行日志"
    >
      <Bell size={14} />
      {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  )
}

export function TopNav({
  page,
  onNavigate,
}: {
  page: PageId
  onNavigate: (p: PageId) => void
}) {
  const { theme, toggleTheme } = useApp()
  const { targets, runtime } = useStore()
  const installed = targets.filter((t) => t.installedVersionId).length

  return (
    <header className="topnav topnav-glass">
      <div className="topnav-brand" onClick={() => onNavigate('dashboard')}>
        <div className="logo-mark">A</div>
        <div className="topnav-brand-copy">
          <div className="logo-name">ALICE</div>
          <div className="logo-sub">BENCH-01</div>
        </div>
      </div>

      <nav className="topnav-items" data-tour="nav.pages">
        {TOPNAV.map(({ id, idx, label, icon: Icon }) => (
          <button
            key={id}
            className={`topnav-item${page === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
            title={label}
          >
            <span className="nav-idx">{idx}</span>
            <Icon size={14} strokeWidth={2} />
            <span className="topnav-label">{label}</span>
            {id === 'runtime' && runtime.running && <span className="dot dot-ok" />}
          </button>
        ))}
      </nav>

      <div className="topnav-right">
        <span className="mono sub topnav-stat" style={{ fontSize: 10 }}>
          {installed}/{targets.length} 已装
        </span>
        <NotificationBell page={page} onNavigate={onNavigate} />
        {/*
         * 原先这里还有一个电源图标按钮跳「个人中心」。个人中心页已删除，
         * 入口一并去掉 —— 该页只有「账号状态」和「主题切换」两块，
         * 状态在总览页已有，主题切换本就在右边这个月亮/太阳按钮上，
         * 留着入口只会点到一个空壳页面。
         */}
        <button className="btn btn-ghost btn-sm" onClick={toggleTheme} title="切换主题">
          {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </div>
    </header>
  )
}
