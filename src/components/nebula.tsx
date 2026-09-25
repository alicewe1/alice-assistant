import { useEffect, useRef } from 'react'

/**
 * 星云背景层（叠在星空之下）。
 *
 * ══ 为什么在星空之外再加一层星云 ═════════════════════════════════════
 * 只有离散星点时，背景是"空"的 —— 无论把星数加到多少，观感都是「白纸上
 * 撒了点」，因为缺少**连续的明暗结构**。星云提供的就是这层结构：几团大而
 * 极淡的彩色云，把背景分成有层次的深浅区，星点落在云上才有"深空"感。
 *
 * ══ 形态：靠渐变本身柔和，不靠 CSS blur ═══════════════════════════════
 * 每团云用一个 radial-gradient，色标在 0 / 0.4 / 0.7 / 1 处依次衰减到透明
 * —— 这样画出来本身就是软的，不需要给整张 canvas 套 `filter: blur()`
 * （全屏 canvas 每帧重新模糊很贵，而且会让星点一起糊掉）。
 *
 * ══ 与星空的分工 ═════════════════════════════════════════════════════
 *   星云（本组件）→ 大尺度、慢、位移小（远景）
 *   星空（Starfield）→ 小尺度、快、位移大（近景）
 * 两者各自按 depth 做视差，叠起来才有纵深。DOM 顺序上星云在前、星空在后，
 * 星点自然画在云之上。
 */

type Cloud = {
  /** 中心（归一化，允许略超出 [0,1] 让云从边缘溢出） */
  x: number
  y: number
  /** 半径（占视口短边的比例） */
  r: number
  /** 调色板索引 */
  hue: number
  /** 基础透明度 */
  a: number
  /** 视差深度：云是远景，取值比星点小 */
  depth: number
  /** 缓慢漂移的相位与速度 */
  phase: number
  speed: number
  /** 漂移幅度（占视口短边比例） */
  drift: number
}

/**
 * 星云调色板。
 * 取偏冷的紫/蓝/青 + 一点品红，与软件既有的炫彩折射语言同源，
 * 但在浅色纸上用低 alpha 呈现为"淡彩雾"，不会抢内容。
 */
const PALETTE = [
  { light: '124, 92, 255', dark: '150, 122, 255' },  // 紫罗兰
  { light: '79, 195, 255', dark: '104, 208, 255' },  // 青蓝
  { light: '255, 95, 176', dark: '255, 122, 190' },  // 品红
  { light: '79, 224, 184', dark: '104, 236, 200' },  // 薄荷
  { light: '92, 108, 255', dark: '122, 140, 255' },  // 靛蓝
]

/** 确定性 PRNG（mulberry32），保证窗口尺寸变化时云布局不跳变 */
function makeRng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 每多少平方像素一团云（云很大，所以这个数远大于星点的） */
const AREA_PER_CLOUD = 62000
const MAX_CLOUDS = 26
const MIN_CLOUDS = 10

/** 视差最大位移（比星点小 —— 云是远景） */
const PARALLAX_PX = 16
const EASE = 0.05

function buildClouds(w: number, h: number): Cloud[] {
  const count = Math.max(MIN_CLOUDS, Math.min(MAX_CLOUDS, Math.round((w * h) / AREA_PER_CLOUD)))
  const rng = makeRng(0x85ebca6b)
  const out: Cloud[] = []
  for (let i = 0; i < count; i++) {
    const u1 = rng(), u2 = rng(), u3 = rng(), u4 = rng(), u5 = rng(), u6 = rng(), u7 = rng()
    out.push({
      // 允许中心落在 [-0.15, 1.15]：云从边缘溢出，画面才不会被"框住"
      x: -0.15 + u1 * 1.3,
      y: -0.15 + u2 * 1.3,
      // 半径 0.20~0.62 倍短边：大的做底、小的做局部亮部
      r: 0.20 + Math.pow(u3, 1.4) * 0.42,
      hue: Math.floor(u4 * PALETTE.length) % PALETTE.length,
      /*
       * 基础透明度。
       * ══ 为什么从 0.05~0.15 提到 0.13~0.34（用户报「星云团呢咋没看见」）══
       * 第一版按"极淡"来设，但忽略了**浅色纸底本身就接近白** ——
       * 低 alpha 的彩色叠在 #fbfbf8 上几乎无差别，实测截图里完全看不出云，
       * 只看到星点。提到 0.13~0.34 后云团成形，多团叠加处也不会脏
       * （单团仍远低于不透明，靠层叠出结构）。
       */
      a: 0.13 + u5 * 0.21,
      depth: 0.25 + u6 * 0.75,
      phase: u7 * Math.PI * 2,
      // 漂移极慢（周期 40~110 秒），只看得出"在动"，看不出运动方向
      speed: 0.00009 + rng() * 0.00016,
      drift: 0.012 + rng() * 0.03,
    })
  }
  return out
}

export function Nebula({ theme }: { theme: 'light' | 'dark' }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const redrawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    /** 与地球/星空同口径：用布局尺寸，不用 getBoundingClientRect（会受 transform 影响） */
    const layoutSize = () => ({ w: canvas.offsetWidth, h: canvas.offsetHeight })

    let clouds: Cloud[] = []
    let builtFor = ''
    let minSide = 1
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
      const key = `${w}x${h}`
      if (key !== builtFor && w > 0 && h > 0) {
        builtFor = key
        minSide = Math.min(w, h)
        clouds = buildClouds(w, h)
      }
    }

    let tx = 0, ty = 0, px = 0, py = 0

    const draw = () => {
      const { w, h } = layoutSize()
      if (w <= 0 || h <= 0) return
      context.clearRect(0, 0, w, h)
      const dark = themeRef.current === 'dark'
      const ox = -px * PARALLAX_PX
      const oy = -py * PARALLAX_PX
      const t = performance.now()
      for (const c of clouds) {
        // 缓慢漂移（各自相位/幅度/速度都不同 → 不会整体平移）
        const dx = reduced ? 0 : Math.sin(t * c.speed + c.phase) * c.drift * minSide
        const dy = reduced ? 0 : Math.cos(t * c.speed * 0.83 + c.phase * 1.7) * c.drift * minSide
        const x = c.x * w + dx + ox * c.depth
        const y = c.y * h + dy + oy * c.depth
        const r = c.r * minSide
        const rgb = dark ? PALETTE[c.hue].dark : PALETTE[c.hue].light
        /*
         * 色标在 0 / 0.4 / 0.72 / 1 处衰减 —— 这是"软"的来源。
         * 不用 CSS filter: blur() 是因为全屏 canvas 每帧重新模糊开销大，
         * 而且会把上层星点一起糊掉（星点画在同一个 canvas 之外，
         * 但模糊层会让整片背景失去锐度）。
         */
        const g = context.createRadialGradient(x, y, 0, x, y, r)
        const a = c.a
        /*
         * 色标在 0 / 0.35 / 0.68 / 1 处衰减 —— 这是"软"的来源。
         * 中间两档比第一版（0.52 / 0.18）抬高了：原来云心到边缘掉得太快，
         * 看着像一小块色斑而不是一团云。现在 0.62 / 0.26 让云有明显的
         * 主体面积，边缘才收干净。
         */
        g.addColorStop(0, `rgba(${rgb}, ${a.toFixed(3)})`)
        g.addColorStop(0.35, `rgba(${rgb}, ${(a * 0.62).toFixed(3)})`)
        g.addColorStop(0.68, `rgba(${rgb}, ${(a * 0.26).toFixed(3)})`)
        g.addColorStop(1, `rgba(${rgb}, 0)`)
        context.fillStyle = g
        context.beginPath()
        context.arc(x, y, r, 0, Math.PI * 2)
        context.fill()
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

  // 主题切换要重绘（reduced-motion 下无常驻循环，否则颜色不会更新）
  useEffect(() => { redrawRef.current() }, [theme])

  return <canvas ref={canvasRef} className="nebula" aria-hidden />
}
