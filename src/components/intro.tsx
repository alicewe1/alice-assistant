import { useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { ensureGlobeBuild, globeProgress, subscribeGlobeProgress } from '@/lib/globe-points'

/**
 * 开场动画（Splash）。
 *
 * ══ 它存在的唯一理由：盖住地球点阵的生成时间 ═════════════════════════
 * 首进总览页时地球点阵要算 1.6 万个格点的陆地面内测试。即使已经切成
 * 时间片（见 globe-points.ts），在完成之前画面上的点云是**边算边长**的
 * —— 用户看到的就是「刚打开时地球不流畅」。所以用一层开场动画盖住这段
 * 时间，并把**真实生成进度**接到进度条上：进度走满 = 点阵就绪。
 *
 * ══ 必须点 Start 才进入（用户要求，没有任何自动退场）══════════════════
 * 进度走满后**不会自动进入主界面**，只在进度条右侧亮出一个 Start 按钮，
 * 等用户点击。所以这里没有任何「到时自动收尾」的定时器 —— 唯一能进入的
 * 路径就是点击（或键盘回车/空格，button 原生支持）。
 * 注意这与「防单点故障」不冲突：点阵若因任何原因算不完，HARD_CAP_MS 只
 * 把**按钮**放出来（forced），仍然要用户点一下才走，绝不会自己跳过去。
 *
 * ══ 透明度：地板从第一帧起就完全不透明（真机踩坑两次）════════════════
 * 这一层**绝不允许整体 opacity 过渡** —— 无论淡入还是淡出。
 * 两次真机问题都是同一个病根：只要 .intro 处于半透明，下面的总览界面
 * （地球点云 / ALICE 大字 / 左侧轨道 / 右侧面板）就会透上来糊成一片。
 *   · 第一次报「进入一瞬间会露出地球形状」→ 修的是**退场**；
 *   · 第二次报「开场一瞬间还是能看到总览界面」→ 病根在**入场**，
 *     原先 .intro 自己也做 0→1 淡入，那 320ms 里同样半透明。
 * 现在：地板**没有任何 opacity 动画**，入场只让内容（大字/正文/进度条）
 * 逐级淡入，退场先淡内容再淡地板（两段不重叠）。地板只在退场第二段
 * 才动透明度，此时内容已经空干净，露出的是干净主界面。
 *
 * ══ 性能：进度不进 state ══════════════════════════════════════════════
 * 生成循环每帧都会回报进度。若把进度存进 state，就是 60fps 的整层重渲染
 * —— 而这层动画本身就是为了「让卡顿时刻流畅」而存在的，自己再吃主线程
 * 就本末倒置了。所以：
 *   · 进度 → 只写 ref（零渲染）；
 *   · 进度条宽度、百分比文字 → 由 rAF 直接写 DOM；
 *   · 只有「进度走满」这一次性翻转才进 state（用来放 Start 按钮）。
 */

/**
 * 进度条走满所需的最短时间。
 *
 * ══ 为什么进度条要「限速」，而不是直接显示真实进度 ═══════════════════
 * 真实进度是地球点阵的构建进度，而 bbox 预筛后它 70ms 就跑完了（见
 * globe-points.ts）—— 直接显示就是「进度条瞬间满格」，用户什么都看不到。
 * 所以显示值取 **min(真实进度, 时间进度)**：
 *   · 快机器：受时间进度约束，匀速走满 MIN_MS；
 *   · 慢机器：真实进度更慢，进度条如实跟着慢（不会骗人）。
 * 这个 min 保证了进度条**永远不会在点阵没算完时提前满格** ——
 * 「满格」始终等价于「地球已就绪」。
 * 时长按入场动画反推：标题最后一字 180+19×70+780 ≈ 2290ms 落定，
 * 进度条稍晚一点收尾（2800ms）节奏最顺。
 */
const MIN_MS = 2800
/**
 * 退场时序：**先内容、后地板**（用户报「进入一瞬间会露出地球形状」）。
 *
 * ══ 为什么不能整层 crossfade（真机复现）══════════════════════════════
 * 第一版是给 `.intro` 整层做 opacity 1→0 淡出。把过程冻在 50% 截图后看得很
 * 清楚：这一层半透明时，下面的主界面**整个透出来** —— 地球点云、ALICE 大字、
 * 左侧轨道、右侧面板全叠在「欢迎使用ALICE-Assistant」上，糊成一片。
 *
 * 现在拆成两段，中间**不重叠**：
 *   ① 0 → OUT_CONTENT_MS：只淡出内容，地板保持**完全不透明**
 *      → 这期间下层永远被盖住，不可能露出来；
 *   ② OUT_CONTENT_MS → OUT_TOTAL_MS：内容已经消失，再淡出地板
 *      → 这时露出的是干净的主界面，是「纸色 → 主界面」的正常过渡。
 * 两段都靠 CSS animation-delay 实现，不需要额外的 state 或定时器。
 */
const OUT_CONTENT_MS = 240
const OUT_FLOOR_MS = 240
const OUT_TOTAL_MS = OUT_CONTENT_MS + OUT_FLOOR_MS
/**
 * 兜底：到点后无论如何都**放出 Start 按钮**（但不自动进入）。
 *
 * ══ 为什么需要（否则一次失败就永久卡死）══════════════════════════════
 * 「满格才亮 Start」依赖 geojson 动态导入 + 1.6 万格点计算全部成功。
 * 任何一环失败（chunk 加载失败、WebView 内存不足、计算抛异常），
 * 进度条就会永远停在半路，Start 永远不亮 —— 用户看到的是「软件打不开」。
 * 开场动画是**体验优化**，绝不能成为启动的单点故障。
 * 超时后把进度条补满并放出 Start，用户点一下照常进入；点阵缺失只影响
 * 地球的观感，不影响任何功能。
 */
const HARD_CAP_MS = 8000

const REPO_URL = 'https://github.com/alicewe1/alice-assistant'
const TITLE = '欢迎使用ALICE-Assistant'

export function Intro({ onDone }: { onDone: () => void }) {
  /** 进度条是否已走满（走满才放出 Start 按钮）—— 一次性翻转，进 state 无压力 */
  const [filled, setFilled] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const readyRef = useRef(globeProgress().ready)
  const progressRef = useRef(globeProgress().progress)
  /** 兜底触发：强制进度条满格并放出 Start */
  const forcedRef = useRef(false)
  const startedAt = useRef(performance.now())
  const doneRef = useRef(false)
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const pctRef = useRef<HTMLSpanElement | null>(null)
  const startRef = useRef<HTMLButtonElement | null>(null)

  // 订阅真实生成进度（模块在订阅时会立刻回调一次当前值）
  useEffect(() => {
    ensureGlobeBuild()
    return subscribeGlobeProgress((p) => {
      progressRef.current = p.progress
      if (p.ready) readyRef.current = true
    })
  }, [])

  /*
   * 进度条由 rAF 驱动，**按时间而非帧数**推进 —— 帧率波动（掉帧、
   * 后台标签页降频）不会让进度条走不完。
   *
   * 显示值 = min(真实进度, 时间进度)，两者取小，所以「满格」严格等价于
   * 「地球已就绪 且 已过最短时长」。
   */
  useEffect(() => {
    let raf = 0
    let done = false
    const tick = () => {
      const elapsed = (performance.now() - startedAt.current) / MIN_MS
      const real = readyRef.current ? 1 : progressRef.current
      const shown = forcedRef.current ? 1 : Math.min(real, elapsed, 1)
      const pct = Math.min(100, Math.round(shown * 100))
      if (fillRef.current) fillRef.current.style.width = `${(shown * 100).toFixed(2)}%`
      if (pctRef.current) pctRef.current.textContent = `${String(pct).padStart(3, '0')}%`
      if (!done && shown >= 1) {
        done = true
        setFilled(true)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // 兜底：只放出按钮，不代替用户点击（见 HARD_CAP_MS 注释）
  useEffect(() => {
    const timer = window.setTimeout(() => { forcedRef.current = true }, HARD_CAP_MS)
    return () => window.clearTimeout(timer)
  }, [])

  // Start 一亮就聚焦，键盘用户直接回车即可（鼠标用户不受影响）
  useEffect(() => {
    if (filled) startRef.current?.focus({ preventScroll: true })
  }, [filled])

  const enter = () => {
    if (doneRef.current) return
    doneRef.current = true
    setLeaving(true)
    // 退场总时长 = 内容淡出 + 地板淡出（见 OUT_* 常量注释）
    window.setTimeout(onDone, OUT_TOTAL_MS)
  }

  const baseDelay = 180
  const afterTitle = baseDelay + TITLE.length * 70

  return (
    <div className={`intro${leaving ? ' is-leaving' : ''}`} aria-label="开场">
      {/*
       * 地板直接复用全局 .aurora-bg —— 同一套纸色 + 5 个炫彩折射光晕。
       *
       * ══ 为什么不自建一层（第一版就是这么写的，结果背景过曝）════════════
       * 自建版本把 4 个 radial-gradient 铺满整层、只给 blur(8px)，光晕半径
       * 又按 inset:-20% 放大 —— 实测整屏被高饱和彩色糊住，大字几乎看不清。
       * 全局 .aurora-bg 是调好的：显式 background-size(34~50vmax) 控制光晕
       * 半径、blur(88px) 做柔和、opacity 走 --refraction-opacity 压低。
       * 直接复用既省事，又保证开场与主界面**视觉完全连续**（淡出时无断层）。
       */}
      <div className="aurora-bg" aria-hidden />
      <div className="intro-inner">
        <h1 className="intro-title" aria-label={TITLE}>
          {/* 逐字拆分才能做 stagger；无障碍由上面的 aria-label 承担 */}
          {[...TITLE].map((ch, i) => (
            <span key={`${ch}-${i}`} className="intro-char" style={{ animationDelay: `${baseDelay + i * 70}ms` }} aria-hidden>
              {ch}
            </span>
          ))}
        </h1>
        <p className="intro-sub" style={{ animationDelay: `${afterTitle + 120}ms` }}>
          该项目地址：
          <a
            className="intro-link"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => {
              /*
               * Tauri 的 WebView 里 target=_blank 通常不交给系统浏览器（没装
               * opener 插件），点开会是空白页。所以显式 window.open 一次，
               * 成功则把 opener 置空（防 tabnabbing）；失败就什么都不做，
               * 让 <a href> 的默认导航兜底 —— WebView2 对 http(s) 外链会
               * 交给系统默认浏览器。
               */
              const w = window.open(REPO_URL, '_blank', 'noopener,noreferrer')
              if (w) w.opener = null
            }}
          >
            {REPO_URL}
          </a>
        </p>
        <p className="intro-note" style={{ animationDelay: `${afterTitle + 220}ms` }}>
          如有帮助请为我点 start。
        </p>
        {/*
         * 液态玻璃进度条：玻璃胶囊轨道 + 流动高光填充 + 掠过式镜面反光。
         * 宽度由上面的 rAF 直接写 style，不走 React（见文件头注释）。
         */}
        <div className="intro-bar-wrap" style={{ animationDelay: `${afterTitle + 320}ms` }}>
          <div
            className="intro-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="地球资源加载进度"
          >
            <span className="intro-fill" ref={fillRef} />
          </div>
          <div className="intro-bar-meta">
            <span className="intro-bar-pct" ref={pctRef}>000%</span>
            {/*
             * 走满前只显示状态文字；走满后**换成 Start 按钮**（用户要求：
             * 点 Start 才进入，不自动进入）。
             * 按钮自带淡入 + 呼吸动效，明确提示「现在可以点了」。
             */}
            {filled ? (
              <button className="intro-start" ref={startRef} onClick={enter} type="button">
                Start
                <ArrowRight size={13} />
              </button>
            ) : (
              <span className="intro-bar-state">正在构建地球</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
