import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react'
import { TOURS, anchorOf } from '@/lib/tour'
import type { TourPlacement, TourStep } from '@/lib/tour'

/**
 * 新手教程指引（Product Tour）。
 *
 * ══ 交互 ══════════════════════════════════════════════════════════════
 * 顶部「使用教程」按钮 → 读完当前页的步骤表 → 依次高亮元素 + 气泡讲解。
 * 每一步三个出口：跳过（整轮结束）/ 上一步 / 下一步（最后一步变「完成」）。
 *
 * ══ 为什么要「挖孔」而不是「盖一层半透明」════════════════════════════
 * 常见做法是给整屏铺一层 rgba(0,0,0,.5)，再把目标元素 z-index 抬起来。
 * 但目标元素往往在 .glass / backdrop-filter 容器里 —— 给它加 z-index
 * 会破坏原有的层叠（顶栏、侧栏、浮层各自有定位），而且父子元素的
 * z-index 谁压谁根本不由这一处决定，调起来是场灾难。
 *
 * 现在改成**遮罩自己挖孔**：一层 fixed 的全屏 div，用
 * `box-shadow: 0 0 0 100vmax rgba(...)` 把「孔」以外的区域全部涂暗。
 * 孔 = 目标元素的矩形，遮罩本身 pointer-events:auto 挡掉误点。
 * 这样完全不碰被测页面的任何样式，页面里一个 z-index 都不用改。
 *
 * ══ 位置追踪：每帧量一次 getBoundingClientRect ═════════════════════════
 * 试过 ResizeObserver + scroll 监听，但漏得厉害：面板折叠动画、字体
 * 后加载导致的回流、嵌套滚动容器…… 都会让高亮框和元素错位。
 * 反正教程打开期间页面基本是静态的，直接 rAF 每帧量一次最简单也最准；
 * 只有矩形真的变了才 setState，静止时不触发重渲染。
 *
 * ══ 锚点可以不在场 ═══════════════════════════════════════════════════
 * 有些步骤讲的是「选中某行之后才有」的面板。锚点找不到时**不报错、
 * 不跳过**，退化成一张居中卡片把话讲完 —— 教程中断比少高亮一个框糟得多。
 */

const TIP_W = 344
const GAP = 14
const MARGIN = 12
const PAD_DEFAULT = 8

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

interface TourCtx {
  /** 当前页有没有可讲的步骤 */
  available: boolean
  running: boolean
  start: () => void
  stop: () => void
  /** 当前页步骤数（按钮上显示「N 步」） */
  stepCount: number
}

const Ctx = createContext<TourCtx | null>(null)

export function useTour(): TourCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('TourProvider missing')
  return v
}

/**
 * 数值兜底：把 any 非有限数（NaN / Infinity / undefined）压成 fallback。
 *
 * ══ 为什么值得专门写一个（真机出现过这条报错）═════════════════════════
 * 控制台报过 `NaN is an invalid value for the left css style property`。
 * 根因是几何量一旦有一个是 NaN，就会顺着 `rect.left + rect.width / 2`
 * 一路传染到 `style.left`，React 只是最后的报信人。
 * NaN 的来源很杂：元素在 `display:none` 祖先下量到 0×0、刚卸载的节点
 * getBoundingClientRect 返回 0、气泡首次渲染时尺寸还没量到……
 * 逐个堵住不如在**进入计算前统一过滤** —— 只要有一个数不干净就退回
 * fallback，最差是位置差一点，绝不会写进非法 CSS。
 */
function safe(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}

/**
 * 把目标元素滚进视口。
 *
 * ══ 为什么不能只用 scrollIntoView({block:'center'}) ═══════════════════
 * `block:'center'` 对**比视口还高**的元素是灾难：浏览器为了让「中心对齐
 * 视口中心」，会把元素的中间段摆到屏幕中央，结果**头部被滚到屏幕上方
 * 之外**。日志面板、技能列表这类高面板都属于这种，用户看到的是
 * 「高亮框框住了半块面板，标题在屏幕外」。
 *
 * 所以这里分两种：
 *   · 元素放得下（再留 24px 余量）→ 居中，上下文都能看到，观感最好；
 *   · 元素比视口高 → 对齐**顶部**（留 12px），让面板标题和第一行可见 ——
 *     看一个长面板时，用户需要的是「这是哪个面板」，而不是中间那一段。
 * 两种情况都用**瞬时**滚动：smooth 期间每帧都在动，高亮框会拖一条尾巴。
 */
function scrollTargetIntoView(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const fits = r.height <= window.innerHeight - 24
  try {
    el.scrollIntoView({ block: fits ? 'center' : 'start', inline: 'nearest' })
  } catch {
    // 老 WebView 不认 options 形式：退回无参调用（对齐顶部，语义安全）
    el.scrollIntoView()
  }
}

/** 把矩形夹进视口，保证高亮框不会整块跑到屏幕外 */
function clampTip(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const maxX = window.innerWidth - w - MARGIN
  const maxY = window.innerHeight - h - MARGIN
  return {
    x: Math.max(MARGIN, Math.min(safe(x, MARGIN), Math.max(MARGIN, safe(maxX, MARGIN)))),
    y: Math.max(MARGIN, Math.min(safe(y, MARGIN), Math.max(MARGIN, safe(maxY, MARGIN)))),
  }
}

/**
 * 算气泡落点。
 *
 * `auto` 的优先级：下 → 上 → 右 → 左 → 强行放下（夹进视口）。
 * 空间不足时**允许盖住一部分目标**（夹取兜底），也好过气泡被切掉半个字。
 */
function placeTip(
  rect: Rect | null,
  placement: TourPlacement,
  tipW: number,
  tipH: number,
): { x: number; y: number; side: TourPlacement } {
  const w = safe(tipW, TIP_W)
  const h = safe(tipH, 190)
  if (!rect) {
    return {
      x: (window.innerWidth - w) / 2,
      y: (window.innerHeight - h) / 2,
      side: 'auto',
    }
  }
  const top = safe(rect.top)
  const left = safe(rect.left)
  const rw = safe(rect.width)
  const rh = safe(rect.height)
  const spaceBelow = window.innerHeight - (top + rh)
  const spaceAbove = top
  const spaceRight = window.innerWidth - (left + rw)
  const spaceLeft = left
  const cx = left + rw / 2
  const cy = top + rh / 2

  const order: Exclude<TourPlacement, 'auto'>[] =
    placement === 'auto' ? ['bottom', 'top', 'right', 'left'] : [placement]

  for (const side of order) {
    if (side === 'bottom' && spaceBelow >= tipH + GAP) {
      const p = clampTip(cx - tipW / 2, rect.top + rect.height + GAP, tipW, tipH)
      return { ...p, side }
    }
    if (side === 'top' && spaceAbove >= tipH + GAP) {
      const p = clampTip(cx - tipW / 2, rect.top - tipH - GAP, tipW, tipH)
      return { ...p, side }
    }
    if (side === 'right' && spaceRight >= tipW + GAP) {
      const p = clampTip(rect.left + rect.width + GAP, cy - tipH / 2, tipW, tipH)
      return { ...p, side }
    }
    if (side === 'left' && spaceLeft >= tipW + GAP) {
      const p = clampTip(rect.left - tipW - GAP, cy - tipH / 2, tipW, tipH)
      return { ...p, side }
    }
  }

  // 四面都放不下：优先压在下方，夹进视口
  const below = rect.top + rect.height + GAP
  const p = clampTip(cx - tipW / 2, below, tipW, tipH)
  return { ...p, side: 'bottom' }
}

function TourOverlay({
  steps,
  onDone,
}: {
  steps: TourStep[]
  onDone: () => void
}) {
  const [idx, setIdx] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [tipSize, setTipSize] = useState({ w: TIP_W, h: 190 })
  const tipRef = useRef<HTMLDivElement | null>(null)
  /** 已量到的锚点键：用来判断 rect 变化，以及「锚点不在场」的退化 */
  const prevKey = useRef<string>('')
  /**
   * 本步是否已经滚过。锚点可能由 `before` 展开后才出现，所以要等它
   * 真的能被量到的那一帧再滚（见下面的 rAF 循环），不能进步骤就滚。
   */
  const scrolledRef = useRef<string | null>(null)

  const step = steps[idx]
  const total = steps.length

  const go = useCallback(
    (n: number) => {
      if (n < 0) return
      if (n >= total) {
        onDone()
        return
      }
      setIdx(n)
    },
    [total, onDone],
  )

  /**
   * 进入一步：先做准备工作（`before`：展开面板 / 切子标签 / 选中一行），
   * 再立刻滚到目标并量一次矩形。
   *
   * ══ 滚动为什么必须在这里也做一次（真机 BUG，别退回只让 rAF 滚）══════
   * 早先这里只 `setRect` 不滚动，却把 `scrolledRef.current` 设成了
   * `step.anchor` —— 等于标记「本步已滚过」。于是下面 rAF 里的
   * `if (scrolledRef.current !== step.anchor)` 永远为假，`scrollIntoView`
   * **一次都没执行**。矮锚点看不出来（本来就在视口里），
   * 但「Alice-codex」页的 `runtime.log` 高 590px、绝对 y=626，而视口只有
   * 900 —— 高亮孔中心落在 y=921 的屏幕外，elementFromPoint 取到 null，
   * 挖孔框整个悬在下方，看着就是「这一步没高亮」。
   * 现在改成：**真滚了才打标记**；锚点还没出现就留 null，让 rAF 接手。
   *
   * 滚动放在 layout effect 里是安全的：`scrollIntoView` 是同步的，
   * 紧跟其后的 getBoundingClientRect 已经能看到滚动后的新位置。
   */
  useLayoutEffect(() => {
    step.before?.()
    const el = step.anchor ? anchorOf(step.anchor) : null
    if (el) {
      // 到这里锚点必然有值（el 就是用它查出来的）
      const key = step.anchor
      scrollTargetIntoView(el)
      scrolledRef.current = key ?? null
      setRect({ ...el.getBoundingClientRect() })
    } else {
      // 锚点还没出现（多半是 before 刚触发展开，React 尚未提交渲染）：
      // 交给 rAF 循环，等它出现的那一帧再滚 + 再量。
      scrolledRef.current = null
      setRect(null)
    }
    prevKey.current = step.anchor ?? '__none__'
  }, [idx, step])

  /**
   * 位置追踪：每帧量一次，变了才写 state（静止时不重渲染）。
   *
   * 顺带负责「锚点由 before 展开后才出现」的首次滚动（见上面的注释）。
   *
   * ══ 为什么不用 ResizeObserver + scroll 监听 ═══════════════════════
   * 漏得厉害：面板折叠动画、字体后加载导致的回流、嵌套滚动容器……
   * 都会让高亮框和元素错位。教程打开期间页面基本是静态的，
   * 直接每帧量一次最简单也最准。
   */
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const el = step.anchor ? anchorOf(step.anchor) : null
      if (el) {
        if (scrolledRef.current !== step.anchor) {
          scrolledRef.current = step.anchor!
          scrollTargetIntoView(el)
        }
        const r = el.getBoundingClientRect()
        setRect((prev) => {
          if (
            prev &&
            Math.abs(prev.top - r.top) < 0.5 &&
            Math.abs(prev.left - r.left) < 0.5 &&
            Math.abs(prev.width - r.width) < 0.5 &&
            Math.abs(prev.height - r.height) < 0.5
          ) {
            return prev
          }
          return { top: r.top, left: r.left, width: r.width, height: r.height }
        })
      } else if (prevKey.current !== '__missing__') {
        // 锚点从「有」变「没有」（比如取消选中）：退化成居中卡片，不中断教程
        prevKey.current = '__missing__'
        setRect(null)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [step.anchor])

  // 气泡真实尺寸量一次（文案长短不一，估不准）。
  // 过滤非有限值：首帧量不到尺寸时 getBoundingClientRect 可能是 0 或 NaN，
  // 直接喂给 placeTip 会一路算出非法 CSS（见 safe() 注释）。
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const w = safe(r.width, TIP_W)
    const h = safe(r.height, 190)
    if (w <= 0 || h <= 0) return
    setTipSize((p) => (Math.abs(p.w - w) < 1 && Math.abs(p.h - h) < 1 ? p : { w, h }))
  }, [idx, step.title, step.body])

  // 键盘：Esc 退出、← → 翻页、Enter 下一步
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDone()
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        go(idx + 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        go(idx - 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [idx, go, onDone])

  const pad = safe(step.pad ?? PAD_DEFAULT, PAD_DEFAULT)
  const hole: Rect | null = rect
    ? {
        top: safe(rect.top) - pad,
        left: safe(rect.left) - pad,
        width: safe(rect.width) + pad * 2,
        height: safe(rect.height) + pad * 2,
      }
    : null

  const pos = placeTip(rect, step.placement ?? 'auto', tipSize.w, tipSize.h)
  const isLast = idx === total - 1

  return createPortal(
    <div className="tour-layer" role="dialog" aria-modal="true" aria-label="新手教程">
      {/*
       * 遮罩 + 挖孔：见文件头「为什么要挖孔」。
       * 没有锚点时铺满整屏（纯压暗），此时是居中卡片模式。
       */}
      {hole ? (
        <div
          className="tour-hole"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
          }}
        >
          {/* 呼吸光环：把视线钉在目标上（用户要的「亮部特写加指示」） */}
          <span className="tour-hole-ring" aria-hidden />
        </div>
      ) : (
        <div className="tour-veil" />
      )}

      {/*
       * 指示箭头：三角的**尖端**落在孔边缘（指向目标）。
       * 尖端坐标的横/纵轴对齐**气泡中心**再夹进孔的跨度 —— 气泡被视口
       * 夹取后可能偏离孔中心，用孔中心会让箭头和气泡错开、看着断开。
       * 各朝向的 translate 约定见 tokens.css 里 .tour-arrow-* 注释。
       */}
      {hole && (
        <span
          className={`tour-arrow tour-arrow-${pos.side}`}
          aria-hidden
          style={(() => {
            const holeRight = safe(hole.left + hole.width)
            const holeBottom = safe(hole.top + hole.height)
            const tipX = safe(hole.left + hole.width / 2)
            const tipY = safe(hole.top + hole.height / 2)
            // 气泡中心（夹取后的真实位置）
            const bubbleCx = safe(pos.x + tipSize.w / 2, tipX)
            const bubbleCy = safe(pos.y + tipSize.h / 2, tipY)
            // 夹进孔的跨度内，避免箭头跑到孔的角外
            const alongX = Math.max(hole.left + 14, Math.min(bubbleCx, holeRight - 14))
            const alongY = Math.max(hole.top + 14, Math.min(bubbleCy, holeBottom - 14))
            // 尖端离孔边 2px：不压住呼吸光环，又看着是贴着目标
            if (pos.side === 'bottom') return { left: alongX, top: holeBottom + 2 }
            if (pos.side === 'top') return { left: alongX, top: hole.top - 2 }
            if (pos.side === 'right') return { left: holeRight + 2, top: alongY }
            return { left: hole.left - 2, top: alongY }
          })()}
        />
      )}

      <div
        className="glass glass-strong tour-tip anim-pop"
        ref={tipRef}
        style={{ left: safe(pos.x, MARGIN), top: safe(pos.y, MARGIN), width: TIP_W }}
      >
        <div className="tour-tip-head">
          <span className="tour-tip-idx">
            {String(idx + 1).padStart(2, '0')}
            <i>/</i>
            {String(total).padStart(2, '0')}
          </span>
          <span className="tour-tip-title">{step.title}</span>
          <button className="btn btn-ghost btn-sm" onClick={onDone} title="关闭教程" aria-label="关闭教程">
            <X size={14} />
          </button>
        </div>

        <p className="tour-tip-body">{step.body}</p>

        {/* 进度：一眼看出还剩多少步 */}
        <div className="tour-dots" aria-hidden>
          {steps.map((_, i) => (
            <span key={i} className={`tour-dot${i === idx ? ' on' : ''}${i < idx ? ' done' : ''}`} />
          ))}
        </div>

        <div className="tour-tip-foot">
          <button className="btn btn-ghost btn-sm tour-skip" onClick={onDone}>
            跳过
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" disabled={idx === 0} onClick={() => go(idx - 1)}>
            <ArrowLeft size={12} /> 上一步
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => go(idx + 1)}>
            {isLast ? (
              <>
                完成 <Check size={12} />
              </>
            ) : (
              <>
                下一步 <ArrowRight size={12} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 教程 Provider：包在 App 外层。
 *
 * `page` 变化时**自动结束**正在跑的教程 —— 否则用户翻到别的页，教程还在
 * 按上一页的锚点找元素，高亮框会到处乱跳。
 */
export function TourProvider({
  page,
  children,
}: {
  page: string
  children: ReactNode
}) {
  const [running, setRunning] = useState(false)
  const [runPage, setRunPage] = useState(page)

  const steps = useMemo(() => TOURS[page] ?? [], [page])
  const runSteps = useMemo(() => TOURS[runPage] ?? [], [runPage])

  const start = useCallback(() => {
    if (!steps.length) return
    setRunPage(page)
    setRunning(true)
  }, [page, steps.length])

  const stop = useCallback(() => setRunning(false), [])

  // 翻页即结束（见上）
  useEffect(() => {
    setRunning(false)
  }, [page])

  const value = useMemo<TourCtx>(
    () => ({ available: steps.length > 0, running, start, stop, stepCount: steps.length }),
    [steps.length, running, start, stop],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      {running && runSteps.length > 0 && <TourOverlay steps={runSteps} onDone={stop} />}
    </Ctx.Provider>
  )
}
