import { useEffect, useRef } from 'react'

/**
 * 星空背景（替代原「矩阵点阵」）。
 *
 * ══ 为什么要换掉原来的实现（用户要求）════════════════════════════════
 * 原来是 `.dash-page::before` 上一张 **36px 平铺的 radial-gradient**：
 *   background-image: radial-gradient(rgba(...,.34) 1.2px, transparent 1.2px);
 *   background-size: 36px 36px;
 * 它有三个固有缺陷：
 *   ① **所有点等大等亮**，是"矩阵"不是"星空"，整齐得发死；
 *   ② 间距严格 36px，放大看就是规则网格；
 *   ③ 视差位移**看不出效果** —— 规则网格整体平移 24px 后，图案与自身
 *      重合（36px 周期的网格平移 24px 视觉上几乎无差别），所以即使
 *      JS 一直在写 --grid-x/--grid-y，用户也感觉"没跟着鼠标动"。
 * 换成 canvas 随机星空后：位置随机、大小随机、亮度随机，且每颗星按
 * **各自的深度**做视差位移 —— 近处的大星移动多、远处的碎星移动少，
 * 这才是真正的纵深感，位移也一眼可见。
 *
 * ══ 性能 ═════════════════════════════════════════════════════════════
 * 星点数量按面积自适应（约每 6200px² 一颗，1440×830 时约 190 颗），
 * 上限 420。每帧只做 ~200 次 arc+fill，远低于地球点阵（每帧 4700 次），
 * 开销可忽略。
 *
 * ══ 确定性随机 ═══════════════════════════════════════════════════════
 * 用固定 seed 的 mulberry32 而非 Math.random：窗口尺寸变化重建星表时
 * 星空布局保持一致，不会"重新撒一遍"导致视觉跳变。
 */

/** 一颗星：位置归一化到 [0,1]，其余是绘制参数 */
type Star = {
  x: number
  y: number
  /** 半径（逻辑像素） */
  r: number
  /** 基础亮度 */
  a: number
  /** 视差深度 0.3~1：越大越"近"，随鼠标位移越多 */
  depth: number
  /** 闪烁相位 / 速度 */
  phase: number
  speed: number
}

/** 确定性 PRNG（mulberry32） */
function makeRng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 每多少平方像素一颗星（越小越密）。
 *
 * ══ 密度调整记录（实拍逐次加）════════════════════════════════════════
 *   6200 → 约 167 颗：明显比原矩阵点阵（36px 网格，约 780 点）空，背景发秃
 *   2600 → 约 400 颗：与原点阵视觉分量相当，但用户仍觉得"星星太少"
 *    650 → 约 1600 颗：用户要求"再多几倍"，取 4 倍量级
 * 1440×830 视口下约 1600 颗，平均最近邻间距 ~13px —— 密而不糊，
 * 因为大小/亮度分布把绝大多数压在碎星档（半径 < 1px），只有极少数亮星。
 */
const AREA_PER_STAR = 650
/**
 * 星数上限。
 * 单纯按面积算，4K 全屏会到 ~5000 颗 —— 每颗 1~2 次 arc+fill，一帧上万次
 * 调用会开始和地球点阵抢帧。压到 2600（约 1440p 全屏的量）足够密，
 * 再大屏也不会线性膨胀。
 */
const MAX_STARS = 2600
/** 视差最大位移（逻辑像素） */
const PARALLAX_PX = 30
/** 跟随缓动：让星空的位移有一点"重量"，不是生硬 1:1 跟手 */
const EASE = 0.07

function buildStars(w: number, h: number): Star[] {
  const count = Math.max(400, Math.min(MAX_STARS, Math.round((w * h) / AREA_PER_STAR)))
  const rng = makeRng(0x9e3779b9)
  const out: Star[] = []
  for (let i = 0; i < count; i++) {
    const u1 = rng(), u2 = rng(), u3 = rng(), u4 = rng(), u5 = rng(), u6 = rng()
    /*
     * 3.0 次幂把分布压向小尺寸：绝大多数是碎星，少数是亮星。
     * 指数从 2.6 提到 3.0 是**配合加密一起调的** —— 星数翻 4 倍后，若还按
     * 原分布就会有 4 倍的亮星，屏幕会花。提高指数把更多点压进碎星档，
     * 亮星数量基本不变（`pow(u,3) > 0.5` 的概率仅 ~13%），密度上去了
     * 但视觉重心仍是"细密星尘 + 少量亮星"。
     * 上限 1.55 是实拍调过的：第一版给到 2.05，最大的几颗在屏幕上直径 4px
     * 还叠外晕，看起来像"脏点/糊斑"而不是星。
     */
    const r = 0.28 + Math.pow(u1, 3.0) * 1.27
    out.push({
      /*
       * 过扫 3%：视差最大位移 30px，若星只铺在 [0,1] 内，边缘会随鼠标
       * 出现一圈"空带"。往外多铺一点，位移后边缘依然有星。
       */
      x: -0.03 + u2 * 1.06,
      y: -0.03 + u3 * 1.06,
      r,
      a: 0.18 + u4 * 0.5,
      // 大星更"近" → 视差位移更大。这是纵深感的来源，不是整层一起平移
      depth: 0.3 + 0.7 * Math.min(1, r / 1.55),
      phase: u5 * Math.PI * 2,
      speed: 0.0006 + u6 * 0.0014,
    })
  }
  return out
}

export function Starfield({ theme }: { theme: 'light' | 'dark' }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  /** 供 theme 变化时强制重绘（reduced-motion 下没有常驻循环） */
  const redrawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    /** 与地球绘制同口径：用布局尺寸，不用 getBoundingClientRect（会被 transform 影响） */
    const layoutSize = () => ({ w: canvas.offsetWidth, h: canvas.offsetHeight })

    let stars: Star[] = []
    let builtFor = ''
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const { w, h } = layoutSize()
      const needW = Math.max(1, Math.floor(w * dpr))
      const needH = Math.max(1, Math.floor(h * dpr))
      if (canvas.width !== needW || canvas.height !== needH) {
        canvas.width = needW
        canvas.height = needH
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      // 星表只在尺寸真变化时重建（同一 seed → 布局稳定，不"重新撒星"）
      const key = `${w}x${h}`
      if (key !== builtFor && w > 0 && h > 0) {
        builtFor = key
        stars = buildStars(w, h)
      }
    }

    // 目标 / 当前分离：鼠标归一化到 [-1,1]
    let tx = 0, ty = 0, px = 0, py = 0

    const draw = () => {
      const { w, h } = layoutSize()
      if (w <= 0 || h <= 0) return
      context.clearRect(0, 0, w, h)
      const dark = themeRef.current === 'dark'
      const ox = -px * PARALLAX_PX
      const oy = -py * PARALLAX_PX
      const t = performance.now()
      for (const s of stars) {
        // 各自深度 → 位移量不同，这才是视差（整层等量平移看不出纵深）
        const x = s.x * w + ox * s.depth
        const y = s.y * h + oy * s.depth
        // 闪烁：幅度压得很小，只是让星空"活"一点，不抢注意力
        const tw = reduced ? 1 : 0.74 + 0.26 * Math.sin(t * s.speed + s.phase)
        context.fillStyle = dark
          ? `rgba(241,241,236,${(s.a * tw).toFixed(3)})`
          : `rgba(16,16,19,${(s.a * tw).toFixed(3)})`
        context.beginPath()
        context.arc(x, y, s.r, 0, Math.PI * 2)
        context.fill()
        /*
         * 亮星补一圈极淡的外晕（半径 2.4 倍、亮度 1/6）。
         * 不用 shadowBlur：那会为每颗星建一次模糊，几百颗时明显吃帧；
         * 叠一个低 alpha 的圆便宜得多，观感接近。
         * 阈值 1.05 且外晕压到 2.4 倍 / 1/6 亮度 —— 外晕太大会让亮星糊成
         * 一团脏斑（第一版 3 倍 / 1/5 就是这样），只给真正亮的少数几颗。
         */
        if (s.r > 1.05) {
          context.fillStyle = dark
            ? `rgba(241,241,236,${(s.a * tw * 0.16).toFixed(3)})`
            : `rgba(16,16,19,${(s.a * tw * 0.16).toFixed(3)})`
          context.beginPath()
          context.arc(x, y, s.r * 2.4, 0, Math.PI * 2)
          context.fill()
        }
      }
    }
    redrawRef.current = () => { resize(); draw() }

    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2
      ty = (e.clientY / window.innerHeight - 0.5) * 2
    }

    let raf = 0
    const tick = () => {
      px += (tx - px) * EASE
      py += (ty - py) * EASE
      resize()
      draw()
      raf = requestAnimationFrame(tick)
    }

    resize()
    if (reduced) {
      // 减少动态效果：画一次静态星空，不跟鼠标、不闪烁
      draw()
    } else {
      window.addEventListener('pointermove', onMove)
      raf = requestAnimationFrame(tick)
    }
    const observer = new ResizeObserver(() => { resize(); if (reduced) draw() })
    observer.observe(canvas)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  // 主题切换要重绘（reduced-motion 下没有常驻循环，否则颜色不会更新）
  useEffect(() => { redrawRef.current() }, [theme])

  return <canvas ref={canvasRef} className="starfield" aria-hidden />
}
