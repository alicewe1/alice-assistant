import { useEffect, useState } from 'react'
import { AppProvider, useApp } from '@/lib/app-context'
import { StoreProvider } from '@/lib/store'
import { TopNav, TOPNAV } from '@/components/topnav'
import type { PageId } from '@/components/topnav'
import { TargetRail } from '@/components/target-rail'
import { ErrorBoundary } from '@/components/error-boundary'
import { Intro } from '@/components/intro'
import { TourProvider } from '@/components/tour'
import { Starfield } from '@/components/starfield'
import { Nebula } from '@/components/nebula'
import { Dashboard } from '@/pages/dashboard'
import { Targets } from '@/pages/targets'
import { Skills } from '@/pages/skills'
import { Prompts } from '@/pages/prompts'
import { Session } from '@/pages/session'
import { Messages } from '@/pages/messages'
import { Runtime } from '@/pages/runtime'
import { Cloud } from '@/pages/cloud'

function Toasts() {
  const { toasts, dismiss } = useApp()
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`glass toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

function Shell() {
  const { theme } = useApp()
  // 支持 hash 深链（#session / #targets…）：便于排障直达页面，也让以后能外部唤起
  const initial = (): PageId => {
    const h = window.location.hash.replace('#', '') as PageId
    const known: PageId[] = [
      'dashboard',
      'targets',
      'skills',
      'prompts',
      'session',
      'messages',
      'runtime',
      'cloud',
    ]
    return known.includes(h) ? h : 'dashboard'
  }
  const [page, setPage] = useState<PageId>(initial)

  const navigate = (p: PageId) => {
    setPage(p)
    window.location.hash = p
  }

  useEffect(() => {
    const onHash = () => setPage(initial())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /*
   * 页头错误边界的标题。TOPNAV 里没有「消息中心」（它由顶栏铃铛进入，
   * 不是导航项），所以这里给一个兜底名。
   */
  const label = TOPNAV.find((n) => n.id === page)?.label ?? (page === 'messages' ? '消息中心' : page)

  /*
   * TourProvider 包住整个 shell：教程要盖住全屏（含顶栏），而「使用教程」
   * 按钮在页头里 —— 两者必须在同一个 Provider 下才拿得到同一份状态。
   * page 传进去，翻页时教程自动结束（见 tour.tsx）。
   */
  return (
    <TourProvider page={page}>
      <div className="shell shell-topnav">
        <div className="aurora-bg" />
        {/*
         * 背景层（星云 + 星空）挂在 **shell 级**，不是页面级。
         *
         * ══ 为什么必须在这（用户报「咋分层了 / 和顶栏颜色不一样」）════════
         * 顶栏 .topnav 是 .shell-topnav 的直接子元素，而 .dash-page 在
         * .main 里面 —— 把背景层挂在 .dash-page 里就只能铺到内容区，
         * 顶栏那条玻璃背后仍是纯纸色，顶栏下沿出现一条**分层接缝**，
         * 且顶栏的 backdrop-filter 采样到的颜色与内容区不一致。
         * 提到 shell 级 + fixed 铺满视口后，全屏是同一张背景，
         * 顶栏玻璃也会自然把星云星空模糊进来。
         *
         * 只在总览页渲染：其他页面没有这套背景（用户要求「只保留主页的」）。
         */}
        {page === 'dashboard' && <Nebula theme={theme} />}
        {page === 'dashboard' && <Starfield theme={theme} />}
        <TopNav page={page} onNavigate={navigate} />
        <div className="shell-body">
          {(page === 'targets' || page === 'session') && <TargetRail page={page} />}
          <main className="main">
            {/* key=page 让切页时重置边界，一个页面崩了不拖累其他页面 */}
            <ErrorBoundary key={page} label={label}>
              {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
              {page === 'targets' && <Targets />}
              {page === 'skills' && <Skills />}
              {page === 'prompts' && <Prompts />}
              {page === 'session' && <Session />}
              {page === 'messages' && <Messages />}
              {page === 'runtime' && <Runtime />}
              {page === 'cloud' && <Cloud />}
            </ErrorBoundary>
          </main>
        </div>
        <Toasts />
      </div>
    </TourProvider>
  )
}

export default function App() {
  /*
   * 开场动画状态。
   *
   * ══ 为什么放在 App 顶层（而不是总览页里）════════════════════════════
   * 开场动画要盖住的是**地球点阵的生成时间**，而点阵生成在 globe-points
   * 模块里、与页面无关。放在总览页里的话：
   *   · 用户若用 hash 深链直接进别的页（#runtime），点阵没人触发，动画
   *     永远不会结束；
   *   · 切页会把动画连同页面一起卸载，进度条中途消失。
   * 放顶层则只在「整个应用首次启动」时出现一次，且无条件订阅模块进度。
   */
  const [intro, setIntro] = useState(true)
  return (
    <AppProvider>
      <StoreProvider>
        {/*
         * ══ 开场期间**不渲染主界面**（根治「开场一瞬间看到总览界面」）══
         * 只靠 z-index + 不透明地板挡住是不够的：CSS 遮罩再严，也总有
         * 「React 还没把 .intro 挂上、主界面已经画出来」的那一帧空隙
         * （实测首帧 t=5ms 时 .intro 尚不存在，而 root 已开始渲染）。
         * 既然开场阶段用户本来就不该看到主界面，那就**根本不渲染它** ——
         * 从根上消除这一帧，同时省掉首屏一大笔渲染开销（对「盖住卡顿」
         * 这个原始目的也是正向的）。
         *
         * 代价：点 Start 后主界面是**首次挂载**，会有一次冷启动渲染。
         * 但那正好发生在退场动画的 480ms 里（内容先淡、地板后淡），
         * 用户看到的是干净的主界面淡入，不会被卡顿影响。
         */}
        {!intro && <Shell />}
        {/*
         * Intro 不依赖任何 store 数据，且要盖住整个 shell（含顶栏）。
         * z-index 由 .intro 控制。卸载后不再回来 —— 只在首次启动出现。
         */}
        {intro && <Intro onDone={() => setIntro(false)} />}
      </StoreProvider>
    </AppProvider>
  )
}
