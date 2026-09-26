import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  Boxes,
  FileText,
  FlaskConical as FlaskIcon,
  Globe2,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import type { PageId } from '@/components/topnav'
import {
  cachedGlobePoints,
  currentGlobePoints,
  ensureGlobeBuild,
  type GeoPoint as GeoPointDto,
} from '@/lib/globe-points'

/**
 * 总览页 · Pidan 风格
 *
 * 三套视觉机制（参考 pidanai.com）：
 *   1. Hero 视差   —— 鼠标移动时文字 3D 倾斜、背景点阵反向位移
 *   2. 液态水泡    —— 跟随鼠标的圆，用 mix-blend-mode 反色其下的文字
 *   3. 苹果玻璃    —— 卡片/按钮用毛玻璃 + 高光描边（样式在 tokens.css）
 */

/** Hero 大字（粗细混排） */
function HeroTitle() {
  return (
    <div className="hero-copy">
      <h1 className="hero-title">
        <span className="title-light">ALICE</span>
      </h1>
    </div>
  )
}

/**
 * Hero 视差：鼠标移动时文字与背景朝不同方向偏转。
 *
 * 三层不同步率 —— 这是纵深感的来源：
 *   · 文字层   → 3D 倾斜（rotateX/rotateY）+ 轻微跟随位移
 *   · 星空背景 → 位移由 <Starfield> 自己按每颗星的**深度**处理
 *
 * 数值取自 pidanai.com 的 setPointerVars()：
 *   --tilt-x = -dy * 18deg    --tilt-y = dx * 24deg
 *   --move-x =  dx * 30px     --move-y = dy * 22px
 *
 * 变量挂在 .dash-page 上（不是 :root），所以只作用于总览页。
 *
 * 注：原来这里还写 --grid-x/--grid-y 驱动 CSS 点阵视差，那套已经删掉
 * （36px 规则网格平移后与自身重合，视觉上等于没动）—— 现在星空是 canvas，
 * 直接读指针位置自己算位移，不再需要这两个变量。
 */
function useHeroParallax() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const root = document.querySelector<HTMLElement>('.dash-page')
    if (!root) return

    // 目标值 / 当前值分离：插值让倾斜有「重量」，不是生硬 1:1 跟手
    let tx = 0
    let ty = 0
    let cx = 0
    let cy = 0
    let raf = 0

    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2
      ty = (e.clientY / window.innerHeight - 0.5) * 2
    }

    const tick = () => {
      cx += (tx - cx) * 0.08
      cy += (ty - cy) * 0.08
      root.style.setProperty('--tilt-x', `${(-cy * 18).toFixed(2)}deg`)
      root.style.setProperty('--tilt-y', `${(cx * 24).toFixed(2)}deg`)
      root.style.setProperty('--move-x', `${(cx * 30).toFixed(2)}px`)
      root.style.setProperty('--move-y', `${(cy * 22).toFixed(2)}px`)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])
}

/**
 * 生成「凸透镜」法线贴图，供 feDisplacementMap 做真实折射。
 *
 * 关键：位移量必须与半径成**线性**关系，才能得到均匀放大。
 *
 *   设 d(r) = k·r，则 输出(r) = 源(r - k·r) = 源(r(1-k))
 *   ⇒ 半径 R(1-k) 内的画面被拉伸铺满整个 R 的圆盘
 *   ⇒ 放大倍率 M = R / (R(1-k)) = 1/(1-k)，**全盘一致**
 *
 * 早先写成 m = r^2.2（中心位移≈0、只有边缘偏折），那是鱼眼/桶形畸变：
 * 圆心的字完全没被放大，看着「扭曲不明显」。这正是要改掉的地方。
 *
 * 编码方式（R/G 通道存位移向量，128 = 零位移）：
 *   R = 128 - cosθ · m · 127
 *   G = 128 - sinθ · m · 127
 * 方向指向**圆心**（向内采样）→ 视觉上就是放大，与真实水滴一致。
 * 圆外填 (128,128) = 零位移，圆边形成一道硬边（真实放大镜的边缘就是这样）。
 */
function makeDropNormalMap(size: number): string {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(size, size)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half
      const dy = (y - half + 0.5) / half
      const r = Math.hypot(dx, dy)
      let rr = 128
      let gg = 128
      if (r < 1 && r > 0.0001) {
        // m = r（线性）⇒ 均匀放大。指数 >1 会变成鱼眼，别用。
        const m = r
        rr = Math.round(128 - (dx / r) * m * 127)
        gg = Math.round(128 - (dy / r) * m * 127)
      }
      const i = (y * size + x) * 4
      img.data[i] = rr
      img.data[i + 1] = gg
      img.data[i + 2] = 0
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL()
}

/** 水珠中心放大倍率。1.7 = 圆心处的字放大 70% */
const DROP_MAGNIFY = 1.7

/**
 * 把水珠折射滤镜注入 DOM（只需一次）。
 *
 * 用 backdrop-filter 引用这个滤镜：Chromium 会把「元素背后的画面」
 * 当作输入喂进滤镜，经 feDisplacementMap 扭曲后再绘制出来 ——
 * 于是文字经过水珠时会被真实地放大弯折，而不是简单反色。
 *
 * scale 的推导：
 *   feDisplacementMap 的实际位移 = scale × (通道值/255 − 0.5)
 *   我的贴图在边缘处通道值≈1（R=1）⇒ 位移系数 ≈ 0.496
 *   要拿到 M 倍放大，边缘位移应为 R(1 − 1/M)
 *   ⇒ scale = 2R(1 − 1/M)
 */
const DROP_FILTER_ID = 'alice-water-drop'
function ensureDropFilter(diameter: number) {
  const old = document.getElementById(DROP_FILTER_ID + '-svg')
  if (old) old.remove()
  const map = makeDropNormalMap(160)
  const R = diameter / 2
  const scale = 2 * R * (1 - 1 / DROP_MAGNIFY)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('id', DROP_FILTER_ID + '-svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none;overflow:hidden'
  svg.innerHTML = `
    <filter id="${DROP_FILTER_ID}" x="0" y="0" width="${diameter}" height="${diameter}"
            filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feImage href="${map}" x="0" y="0" width="${diameter}" height="${diameter}"
               preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map"
                         scale="${scale.toFixed(1)}"
                         xChannelSelector="R" yChannelSelector="G" result="bent"/>
      <feGaussianBlur in="bent" stdDeviation="0.3"/>
    </filter>`
  document.body.appendChild(svg)
}

/**
 * 液态水珠：跟随鼠标的透明圆，**真实折射**其下的内容。
 *
 * 与上一版的区别：删掉了「反色」。之前用 mix-blend-mode / 双层文字副本
 * 把文字染成反色，但那不是水珠该有的样子，而且两层 DOM 布局盒子不同
 * 导致永远对不齐。现在改成 backdrop-filter + SVG 位移贴图：
 * 同一个元素、同一份像素，**不存在对齐问题**，且文字经过时是真实的
 * 弯折放大，像一滴水落在屏幕上。
 *
 * 层级在水珠之上（z-index 90）但它是透明的，只会让下面的卡片/文字
 * 轻微扭曲，不会遮挡。
 */
function CursorBlob() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    // 尊重系统「减少动态效果」：关掉水珠，避免晕动不适
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setEnabled(!mq.matches)
    const onMq = () => setEnabled(!mq.matches)
    mq.addEventListener('change', onMq)
    return () => mq.removeEventListener('change', onMq)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return

    // 半径从 CSS 变量读，保证与样式表单一来源
    const R = parseFloat(getComputedStyle(el).getPropertyValue('--blob-r')) || 150
    ensureDropFilter(R * 2)

    let tx = window.innerWidth / 2
    let ty = window.innerHeight / 2
    let cx = tx
    let cy = ty
    let raf = 0
    let visible = false

    /*
     * ── 顶栏判定：几何矩形，不用选择器 ──────────────────────────
     *
     * 参考 pidanai.com 的 pointermove 处理（pdaim-shell.js:1533-1541）：
     *   const r = siteHeader.getBoundingClientRect()
     *   inside = x >= r.left - pad && x <= r.right + pad &&
     *            y >= r.top  - pad && y <= r.bottom + pad
     *
     * 为什么不用 closest('.topnav')：
     *   顶栏本身有 margin（悬浮玻璃条），鼠标落在它的**外边距**上时
     *   target 其实是 .shell，closest 判定为 false —— 于是气泡在
     *   顶栏边缘忽隐忽现。几何矩形能把外扩的 padding 一起算进去，
     *   判定稳定，也天然覆盖了顶栏内部的所有按钮/文字。
     *
     * 用户明确要求：**只有顶部**收缩，页面里的按钮不参与。
     */
    const HEADER_PAD = 8
    const isInHeaderZone = (x: number, y: number) => {
      const h = document.querySelector('.topnav')
      if (!h) return false
      const r = h.getBoundingClientRect()
      return (
        x >= r.left - HEADER_PAD &&
        x <= r.right + HEADER_PAD &&
        y >= r.top - HEADER_PAD &&
        y <= r.bottom + HEADER_PAD
      )
    }

    /*
     * ── 变换合成：位置与缩放写在**同一个 transform 里** ──────────
     *
     * 这是一个真实踩过的数学坑：
     *   原先用 CSS 的独立 `scale` 属性 + `transform: translate(...)`，
     *   两者的合成顺序是 `M = S · T`（scale 在前、transform 在后）。
     *   于是元素中心 (R,R) 被映射到：
     *       (R,R) + s·(cx−R, cy−R)
     *   当 s→0.035 且 cx 很大（鼠标在右侧）时，中心会跑到视口左上角
     *   —— 表现就是「从右上移走却往左上收缩」。
     *
     *   现在把 scale 放进 transform 内部：`M = T · S`，
     *   中心映射为 (R,R) + t = (cx, cy)，**与 s 无关**，
     *   所以无论缩放到多小，都精确围绕指针位置。
     */
    const applyTransform = () => {
      el.style.transform = `translate3d(${cx - R}px, ${cy - R}px, 0) scale(${sc})`
    }

    /*
     * ── 收缩动画：时长驱动 + 缓动 ──────────────────────────────
     *
     * 参考 animateCursorScale（pdaim-shell.js:1195-1232）：
     *   收缩 → 0.035，170ms，easeOutCubic
     *   展开 → 1，     260ms，easeOutCubic
     *
     * 为什么用时长驱动而不是每帧指数逼近（sc += (want−sc)·k）：
     *   指数逼近永远到不了终点，起止速度也不可控，视觉上「拖泥带水」。
     *   时长驱动有明确终点与缓动曲线，收缩利落。
     */
    let sc = 1
    let scFrom = 1
    let scTo = 1
    let scStart = 0
    let scDur = 0
    let scaleRaf = 0
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

    const animateScale = (to: number, dur: number) => {
      if (to === scTo && scaleRaf) return // 目标相同且动画进行中 → 不打断
      cancelAnimationFrame(scaleRaf)
      scFrom = sc
      scTo = to
      scStart = performance.now()
      scDur = dur
      const step = (now: number) => {
        const t = Math.min(1, (now - scStart) / scDur)
        sc = scFrom + (scTo - scFrom) * easeOutCubic(t)
        applyTransform()
        if (t < 1) scaleRaf = requestAnimationFrame(step)
        else scaleRaf = 0
      }
      scaleRaf = requestAnimationFrame(step)
    }

    /*
     * ── 位置跟随：系数随距离自适应 ──────────────────────────────
     *
     * 参考 animateCursor（pdaim-shell.js:1454-1465）：
     *   const distance = Math.hypot(dx, dy)
     *   const followEase = Math.min(0.68, Math.max(0.24, distance / 260))
     *
     * 关键：距离越远跟得越快（0.24~0.68），距离近时慢下来。
     * 早先用固定系数 0.14 —— 鼠标快速移动时气泡严重落后，
     * 点击时收缩就发生在落后位置，看起来「收缩方向和鼠标不一致」
     * （用户反馈的偏移问题）。自适应系数让气泡始终贴近指针。
     */
    const tick = () => {
      const dx = tx - cx
      const dy = ty - cy
      const dist = Math.hypot(dx, dy)
      const followEase = Math.min(0.68, Math.max(0.24, dist / 260))
      cx += dx * followEase
      cy += dy * followEase
      applyTransform()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    /** 鼠标进入顶栏：位置硬同步 + 立刻缩成点（参考 enterHeaderZone） */
    let inHeader = false
    const enterHeader = (x: number, y: number) => {
      inHeader = true
      // 硬同步位置：顶栏是「另一个区域」，气泡不该从远处飘过来
      cx = x
      cy = y
      applyTransform()
      animateScale(0.035, 170)
    }
    const leaveHeader = () => {
      inHeader = false
      animateScale(1, 260)
    }

    const onMove = (e: PointerEvent) => {
      tx = e.clientX
      ty = e.clientY
      if (!visible) {
        visible = true
        el.style.opacity = '1'
      }
      // 顶栏区域进出判定（只在状态变化时触发动画，避免每帧重启动画）
      const inside = isInHeaderZone(tx, ty)
      if (inside && !inHeader) enterHeader(tx, ty)
      else if (!inside && inHeader) leaveHeader()
    }

    /*
     * 按下：位置硬同步到点击点 + 收缩到 0.82（110ms）。
     * 早先只置 down=true，若气泡还在跟随途中，收缩就发生在落后位置
     * —— 这是「收缩方向和鼠标不一致」的另一半原因。
     * 时长取自参考站 animateCursorScale 的按下段（110ms）。
     */
    const onDown = (e: PointerEvent) => {
      tx = e.clientX
      ty = e.clientY
      cx = tx
      cy = ty
      applyTransform()
      el.dataset.press = '1'
      if (!inHeader) animateScale(0.82, 110)
    }
    const onUp = () => {
      delete el.dataset.press
      if (!inHeader) animateScale(1, 260)
    }
    const onLeave = () => {
      visible = false
      el.style.opacity = '0'
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    document.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(scaleRaf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointerleave', onLeave)
    }
  }, [enabled])

  if (!enabled) return null
  return <div ref={ref} className="cursor-blob" aria-hidden />
}

type GlobeFocus = 'clients' | 'packs' | 'injected' | 'runtime'

const globeFocus: Record<GlobeFocus, { lat: number; lon: number; color: string }> = {
  clients: { lat: 48, lon: 12, color: '#ff5b2e' },
  packs: { lat: 34, lon: 116, color: '#f4ad28' },
  injected: { lat: 1, lon: -74, color: '#0e9b66' },
  runtime: { lat: -26, lon: 151, color: '#5b82ff' },
}

type GeoPoint = GeoPointDto
/**
 * 地球上的客户端节点。
 * `installedLabel` = 已注入的**预设组名**（来自安装状态文件），
 * 未注入为 null —— hover 卡片要显示"注入的是哪个预设"。
 */
type GlobeClient = { id: string; label: string; injected: boolean; profileCount: number; installedLabel: string | null }
/** 橙点的屏幕坐标（canvas 逻辑像素），供 hover 命中与小 UI 定位 */
type GlobeHit = { id: string; x: number; y: number; radius: number }

function hashSeed(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return hash >>> 0
}

/**
 * 客户端标记落点：**吸附到最近的大陆点**。
 *
 * ══ 为什么不能纯随机经纬（用户报「橙点跑到海里」）══════════════════
 * 旧实现按 hash 在 [-52,56]×[-172,172] 里随机取经纬 —— 地球 71% 是海洋，
 * 随机落点大概率掉进海里，视觉上就是「橙点飘在海面上」，与「客户端节点
 * 落在地图上」的语义不符。
 * 现在：先按 hash 取一个候选经纬，再在已生成的大陆点阵里找**最近的一个**
 * 吸附过去。点阵是懒加载的，未就绪时先退回原始经纬（就绪后自然纠正）。
 */
/**
 * 吸附结果的缓存（见 clientLocation 注释）。
 *   snapCache       id → 已吸附经纬
 *   snapTaken       已被占用的点（避免多个客户端叠在同一个点上）
 *   snapCacheSource 缓存所属的点阵引用（换点阵即整体失效）
 */
const snapCache = new Map<string, { lat: number; lon: number }>()
/** 已分配的落点集合（用于最小间隔判据） */
const snapTaken = new Set<GeoPoint>()
let snapCacheSource: GeoPoint[] | null = null

/**
 * 橙点之间的**最小间隔**（度）。
 *
 * ══ 为什么需要（用户报「光点聚集太近容易重叠」）══════════════════════
 * 陆地点阵的网格步长是 1.8°(经) × 1.65°(纬)。两个客户端若各自吸附到
 * 相邻格点，屏幕上就是两个几乎贴在一起、甚至互相压住的圆点。
 * 取 7° ≈ 4 个格距，缩到屏幕上刚好能分清两个点。
 */
const CLIENT_MIN_SEP = 7
/** 加权度量：纬度权重 1、经度权重 0.55（极区经度收缩，避免被高纬点抢走） */
const sepMetric = (dLat: number, dLon: number) => Math.sqrt(dLat * dLat + dLon * dLon * 0.55)
const lonDiff = (a: number, b: number) => {
  const d = Math.abs(a - b)
  return d > 180 ? 360 - d : d
}

/**
 * 为一组客户端分配落点（吸附到大陆 + 互相保持间隔）。
 *
 * ══ 两个必须一起解决的性质 ═══════════════════════════════════════════
 *   ① 落在大陆上：候选点只在 land=true 的点阵里挑（点阵本身已保证
 *      每个 land 点真实位于陆地多边形内部）。
 *   ② 互不重叠：已分配的点进入 taken 集合，后续客户端要离它们至少
 *      CLIENT_MIN_SEP；排不下就分轮放宽（7° → 5.25° → 3.5° → 1.75°），
 *      保证任何数量都能收敛。
 * ══ 为什么按 id 排序处理 ═════════════════════════════════════════════
 * 分配是**顺序相关**的（先来的占好位置）。若按 clients 数组顺序算，
 * 客户端顺序一变（侧栏拖动排序、reload 后顺序不同）所有橙点会整体搬家。
 * 固定按 id 字典序分配 → 同一组客户端永远得到同一组落点。
 */
function assignClientLocations(ids: string[]): Map<string, { lat: number; lon: number }> {
  const pts = cachedGlobePoints
  if (!pts || !pts.length) return snapCache
  if (snapCacheSource !== pts) {
    snapCacheSource = pts
    snapCache.clear()
    snapTaken.clear()
  }
  const ordered = [...new Set(ids)].sort()
  for (const id of ordered) {
    if (snapCache.has(id)) continue
    const seed = hashSeed(id)
    const rawLat = -52 + (seed % 108)
    const rawLon = -172 + ((seed >>> 8) % 344)
    let picked: GeoPoint | null = null
    let fallback: GeoPoint = pts[0]
    let fallbackD = Number.POSITIVE_INFINITY
    for (let attempt = 0; attempt < 4 && !picked; attempt++) {
      const minSep = CLIENT_MIN_SEP * (1 - attempt * 0.25)
      let best: GeoPoint | null = null
      let bestD = Number.POSITIVE_INFINITY
      for (const p of pts) {
        if (!p.land) continue
        const dLat = p.lat - rawLat
        const dLon = lonDiff(p.lon, rawLon)
        const d = sepMetric(dLat, dLon)
        if (d < fallbackD) {
          fallbackD = d
          fallback = p
        }
        if (taken(p, minSep)) continue
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      picked = best
    }
    const target = picked ?? fallback
    const result = { lat: target.lat, lon: target.lon }
    snapCache.set(id, result)
    snapTaken.add(target)
  }
  return snapCache
}

/** 该点是否离任一已分配点太近（含本身已被占用） */
function taken(p: GeoPoint, minSep: number): boolean {
  for (const t of snapTaken) {
    if (sepMetric(t.lat - p.lat, lonDiff(t.lon, p.lon)) < minSep) return true
  }
  return false
}

/**
 * 单个客户端的落点。点阵未就绪或该 id 尚未参与批量分配时，
 * 退回 hash 原始经纬（点阵就绪后由 assignClientLocations 纠正）。
 */
function clientLocation(id: string): { lat: number; lon: number } {
  const hit = snapCache.get(id)
  if (hit) return hit
  const seed = hashSeed(id)
  return { lat: -52 + (seed % 108), lon: -172 + ((seed >>> 8) % 344) }
}

function ParticleGlobe({
  focus,
  clients,
  activeClientId,
  theme,
  expanded,
  onHits,
  hoveredClientId,
  onHoverClient,
}: {
  focus: GlobeFocus
  clients: GlobeClient[]
  activeClientId: string | null
  theme: 'light' | 'dark'
  /**
   * 客户端抽屉是否展开。控制**两种互斥的交互模式**（用户要求）：
   *   · 收起 → 持续自转，**禁止拖拽**（球是背景装饰，别误拖）
   *   · 展开 → **停止自转**，但可以鼠标拖拽（用户要手动转到想看的位置）
   */
  expanded: boolean
  /** 每帧回传橙点屏幕坐标，供上层做 hover 命中与引出线卡片定位 */
  onHits: (hits: GlobeHit[]) => void
  /** 当前悬停的客户端 id（上层状态，用于高亮与显示小 UI） */
  hoveredClientId: string | null
  onHoverClient: (id: string | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const focusRef = useRef(focus)
  focusRef.current = focus
  const clientsRef = useRef(clients)
  clientsRef.current = clients
  const activeClientRef = useRef(activeClientId)
  activeClientRef.current = activeClientId
  const themeRef = useRef(theme)
  themeRef.current = theme
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  /** 橙点坐标表（绘制循环写，指针事件读） */
  const hitsRef = useRef<GlobeHit[]>([])
  const hoveredClientRef = useRef(hoveredClientId)
  hoveredClientRef.current = hoveredClientId
  const onHoverClientRef = useRef(onHoverClient)
  onHoverClientRef.current = onHoverClient
  const onHitsRef = useRef(onHits)
  onHitsRef.current = onHits

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    /*
     * 点阵不再同步生成（那是 3775ms 主线程冻结 = 启动白屏主因）。
     * 现在由 globe-points 模块在 rAF 里按时间片推进，这里只取当前可用的
     * 部分绘制 —— 首帧就能出画面，点阵边算边出现。
     * 关闭态不显示光点，所以这段生成过程用户完全无感（何况还有开场动画盖着）。
     */
    ensureGlobeBuild()
    let points: GeoPoint[] = currentGlobePoints()
    let rotation = 0
    let targetRotation = 0
    let tilt = 0
    let velocity = 0
    let tiltVelocity = 0
    let dragging = false
    let lastX = 0
    let lastY = 0
    let raf = 0
    /** 辉光渐变缓存（只在尺寸/主题变化时重建，见 draw 内的说明） */
    let glowCache: { dark: boolean; r: number; cx: number; cy: number; g: CanvasGradient } | null = null
    /*
     * ══ 自转与「对焦某地」的冲突（实测自转几乎不可见）════════════════
     * 旧式子 `rotation += delta*0.018 + velocity` 里 delta 是把球拉向
     * focus 经度的收敛力，它比 velocity（0.00042）大两个数量级 ——
     * 数值模拟结果：3 秒后球被钉死在 -12.9°，稳态速度仅 1.44°/秒，
     * 且方向被收敛力抵消，肉眼看不到自转。
     *
     * 用户要的是**持续向左自转**。改成：
     *   · 基础自转常驻（SPIN，弧度/帧），方向为左（负）；
     *   · 「对焦」不再用持续收敛力，改为**一次性偏置**：切换 focus 时把
     *     目标经度记为偏移量，由自转自然带过去 —— 不再和自转抢控制权；
     *   · 拖动时暂停自转，松手后按拖动惯性滑行，惯性耗尽恢复常速自转。
     */
    const SPIN = -0.0016 // ≈ 5.5°/秒，约 65 秒一圈，明显可见又不晃眼
    let focusBias = 0 // 切换 focus 时一次性施加的经度偏置
    let lastFocus = focusRef.current
    let lastClient = activeClientRef.current
    /*
     * ══ 开关驱动的两个视觉量（用户要求）════════════════════════════════
     *   · 关闭态：**不显示光点**（只有球体轮廓与辉光，安静的背景）
     *   · 开启态：球体**轻微放大** + 显示光点
     * 两者都用 0→1 的平滑插值（glowT），而不是瞬间切换 ——
     * 开关是 420ms 的滑动动画，视觉量必须同节奏跟上才不突兀。
     */
    let glowT = expandedRef.current ? 1 : 0
    const GLOW_EASE = 0.06 // 每帧逼近速度（约 300ms 到位）
    /*
     * ══ 尺寸必须用「布局尺寸」，不能用 getBoundingClientRect ═════════════
     * 真机 bug（用户报「展开后绿点与中心错位」）：
     *   resize() 原先读 `getBoundingClientRect()` —— 它返回**变换后**的矩形。
     *   展开时 CSS 从 scale(.9) → scale(1)，而 **ResizeObserver 不会因
     *   transform 变化触发**（它只观察布局盒）。于是：
     *     canvas 位图尺寸停留在 scale(.9) 时代的 774dpr，
     *     而 draw() 按新的 860 布局去画 → 超出位图的部分被**裁掉右侧**，
     *     视觉上点云整体偏左、与圆心错位（截图里 x≈880 那道垂直分界
     *     就是被裁的画布边缘）。
     * 现在：尺寸一律取 offsetWidth/offsetHeight（布局尺寸，与 transform 无关），
     * 并在每帧自愈式比对 —— 尺寸不符就立刻重建位图，覆盖展开/收起、
     * 窗口缩放、系统 DPI 变化所有情形，不再依赖 ResizeObserver 的触发时机。
     */
    const layoutSize = () => ({ w: canvas.offsetWidth, h: canvas.offsetHeight })
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
    }
    const draw = () => {
      /*
       * 点阵由 globe-points 模块自己驱动增量生成（它同时服务开场动画的
       * 进度条），这里只取当前可用的部分绘制 —— 不再在绘制循环里推进生成。
       */
      points = currentGlobePoints()
      // 自愈：位图尺寸与布局不符（展开/收起、缩放、DPI 变化）→ 立即重建
      resize()
      const { w, h } = layoutSize()
      const cx = w / 2
      const cy = h / 2
      // glowT：光点淡入淡出的插值量（关闭→0 隐藏光点，开启→1 显示）
      const targetT = expandedRef.current ? 1 : 0
      glowT += (targetT - glowT) * GLOW_EASE
      if (Math.abs(targetT - glowT) < 0.002) glowT = targetT
      // 球体尺寸固定，**放大交给 CSS**（.globe-frame 的 transform: scale）：
      // 一处控制缩放（CSS，GPU 合成更平滑），一处控制透明度（这里），避免叠加放大。
      const r = Math.min(w, h) * 0.46
      const selected = globeFocus[focusRef.current]
      const selectedLocation = focusRef.current === 'clients' && activeClientRef.current
        ? clientLocation(activeClientRef.current)
        : selected
      /*
       * 切换 focus / 选中客户端时，把「目标经度」折算成一次性偏置：
       * 让自转把球**自然转过去**，而不是用收敛力把球钉住。
       * 偏置取最短角差，避免绕远路。
       */
      if (focusRef.current !== lastFocus || activeClientRef.current !== lastClient) {
        lastFocus = focusRef.current
        lastClient = activeClientRef.current
        targetRotation = (-selectedLocation.lon * Math.PI) / 180
        const diff = Math.atan2(Math.sin(targetRotation - rotation), Math.cos(targetRotation - rotation))
        focusBias = diff
      }
      /*
       * ══ 两种互斥交互模式（用户要求）══════════════════════════════════
       *   收起（expanded=false）→ 持续自转，禁止拖拽
       *   展开（expanded=true） → 停止自转，可鼠标拖拽
       * 展开时 focus 偏置也不再生效（球应该听用户的手，不该被拉走）。
       */
      const isExpanded = expandedRef.current
      if (isExpanded) {
        // 展开：不自转、不释放偏置；仅保留拖拽惯性让它自然滑停
        if (!dragging) {
          rotation += velocity
          velocity *= 0.94
          if (Math.abs(velocity) < 0.0002) velocity = 0
          tilt += tiltVelocity
          tiltVelocity *= 0.94
          if (Math.abs(tiltVelocity) < 0.00008) tiltVelocity = 0
        }
      } else if (!dragging) {
        // 收起：自转常驻 + 一次性偏置平滑释放（偏置衰减，不抢控制权）
        rotation += SPIN + velocity + focusBias * 0.02
        focusBias *= 0.94
        if (Math.abs(focusBias) < 0.0008) focusBias = 0
        velocity *= 0.965
        if (Math.abs(velocity) < 0.0002) velocity = 0
        tilt += tiltVelocity
        tiltVelocity *= 0.965
        if (Math.abs(tiltVelocity) < 0.00008) tiltVelocity = 0
      }
      context.clearRect(0, 0, w, h)
      const dark = themeRef.current === 'dark'
      /*
       * ══ 每帧开销（实测优化点）════════════════════════════════════════
       * 旧实现两个热点：
       *   ① `createRadialGradient` **每帧新建** —— 渐变对象是较重的分配，
       *      60fps 下每秒 60 次；且它只依赖 (cx,cy,r,dark)，缓存即可。
       *   ② 每个点单独 `beginPath/arc/fill` —— 5425 次/帧 ≈ 32 万次/秒；
       *      更糟的是每点 alpha 用 toFixed(3) 生成**唯一颜色**，
       *      浏览器无法合批，等于 5425 次独立绘制调用。
       * 改法：渐变缓存 + 颜色分桶合批（按 land/space × alpha 量化档位），
       * 一次 fill 画完同色的一批点 —— 调用数从 5425 降到 ~16。
       */
      /*
       * ══ 辉光必须完整收在画布内，否则被裁成方形（真机 bug）════════════
       * 旧值：地球半径 r = min(w,h)*0.46，辉光画到 r*1.22。
       * 因为 canvas 是正方形（aspect-ratio:1），半宽 = 0.5：
       *   r*1.22 = 0.46*1.22 = 0.561 > 0.500  → 辉光圆四边**超出画布**，
       *   被 canvas 矩形边界硬裁 → 用户看到「绿光呈正方形轮廓」（黑白主题都如此）。
       * 另一个隐患：渐变定义到 r*1.25、填充圆却是 r*1.22，两者不一致 →
       * 1.22 处渐变尚未到全透明，边缘出现**硬边**，进一步强化了方框感。
       *
       * 修法：
       *   · 辉光半径取 `min(0.5*min(w,h) , r*1.22)` —— 保证圆完整在画布内；
       *   · 渐变外沿与填充半径**用同一个值**，让 alpha 在边缘恰好归零。
       */
      // 留 1px 余量：贴着画布边缘的抗锯齿仍可能露出细边
      const glowRadius = Math.min(Math.min(w, h) * 0.5 - 1, r * 1.22)
      if (
        !glowCache ||
        glowCache.dark !== dark ||
        Math.abs(glowCache.r - glowRadius) > 0.5 ||
        Math.abs(glowCache.cx - cx) > 0.5 ||
        Math.abs(glowCache.cy - cy) > 0.5
      ) {
        const g = context.createRadialGradient(cx, cy, glowRadius * 0.29, cx, cy, glowRadius)
        g.addColorStop(0, dark ? 'rgba(77, 224, 183, .25)' : 'rgba(255,255,255,.34)')
        g.addColorStop(0.62, dark ? 'rgba(30, 159, 139, .14)' : 'rgba(125,180,255,.13)')
        g.addColorStop(1, 'rgba(125,180,255,0)')
        glowCache = { dark, r: glowRadius, cx, cy, g }
      }
      context.fillStyle = glowCache.g
      context.beginPath(); context.arc(cx, cy, glowRadius, 0, Math.PI * 2); context.fill()
      const tiltCos = Math.cos(tilt)
      const tiltSin = Math.sin(tilt)
      // 颜色分桶：alpha 量化到 8 档 → 最多 2(land/space) × 8 = 16 个批次
      const BUCKETS = 8
      const buckets: Array<{ land: boolean; alpha: number; pts: Array<[number, number, number]> }> = []
      for (let b = 0; b < BUCKETS; b++) {
        buckets.push({ land: true, alpha: 0, pts: [] })
        buckets.push({ land: false, alpha: 0, pts: [] })
      }
      const sparks: Array<[number, number, number]> = []
      /*
       * ══ 谁该隐藏（用户澄清）════════════════════════════════════════════
       * 地球点阵（陆地/星点）**始终显示** —— 那是球体本身的质感。
       * 开关控制的是**客户端标记点**（橙色那些）：
       *   关 → 不显示客户端标记（安静的地球）
       *   开 → 客户端标记淡入
       * 所以这里点阵不再乘 glowT，只有下面的客户端标记受它控制。
       */
      points.forEach((p, i) => {
        const lat = (p.lat * Math.PI) / 180
        const lon = (p.lon * Math.PI) / 180 + rotation
        const x = Math.cos(lat) * Math.sin(lon)
        const baseY = Math.sin(lat)
        const baseZ = Math.cos(lat) * Math.cos(lon)
        const y = baseY * tiltCos - baseZ * tiltSin
        const z = baseY * tiltSin + baseZ * tiltCos
        if (z < -0.12) return
        const alpha = p.land ? 0.42 + z * 0.58 : 0.11 + z * 0.2
        const size = p.size * (0.72 + z * 0.45)
        const slot = Math.min(BUCKETS - 1, Math.max(0, Math.round(((alpha - (p.land ? 0.42 : 0.11)) / (p.land ? 0.58 : 0.2)) * (BUCKETS - 1))))
        const bucket = buckets[(p.land ? 0 : 1) * BUCKETS + slot]
        bucket.alpha = Math.max(bucket.alpha, alpha)
        bucket.pts.push([cx + x * r, cy - y * r, size])
        if (p.land && i % 23 === 0 && z > 0.45) sparks.push([cx + x * r, cy - y * r, size + 0.45])
      })
      for (const bucket of buckets) {
        if (!bucket.pts.length) continue
        context.fillStyle = bucket.land
          ? dark
            ? `rgba(197, 255, 238, ${bucket.alpha.toFixed(3)})`
            : `rgba(36, 104, 105, ${bucket.alpha.toFixed(3)})`
          : dark
            ? `rgba(132, 219, 196, ${bucket.alpha.toFixed(3)})`
            : `rgba(89, 135, 151, ${bucket.alpha.toFixed(3)})`
        context.beginPath()
        for (const [px, py, ps] of bucket.pts) {
          context.moveTo(px + ps, py)
          context.arc(px, py, ps, 0, Math.PI * 2)
        }
        context.fill()
      }
      if (sparks.length) {
        context.fillStyle = dark ? 'rgba(238,255,251,.72)' : 'rgba(238,255,251,.88)'
        context.beginPath()
        for (const [px, py, ps] of sparks) {
          context.moveTo(px + ps, py)
          context.arc(px, py, ps, 0, Math.PI * 2)
        }
        context.fill()
      }
      /*
       * ══ 焦点标记（红点）已删除（用户要求）══════════════════════════════
       * 原来这里还画一个 selected 标记（focus 对应的红/黄/绿/蓝点 + 呼吸环）。
       * 它与客户端橙点混在同一层，颜色又接近橙点，用户看到的就是「球上有个
       * 没意义的红点」，分不清哪个是可交互的客户端节点。
       * 现在球面上**只有客户端光点**；focus 的表达交给左侧状态轨道高亮和
       * 右侧信息面板（那两处已经足够，且不会污染球面）。
       * 注意：focus 仍然参与「一次性经度偏置」把球转过去（见上方 focusBias），
       * 所以点击轨道依然能看到球转向对应区域 —— 只是不再画那个点。
       *
       * 客户端橙点仍然受开关控制（glowT）：关闭态整体跳过，球面保持干净。
       */
      if (glowT > 0.01) {
      const now = performance.now()
      /*
       * 橙点屏幕坐标登记表：供 React 层做 hover 命中与引出线卡片定位。
       * 每帧重写（球在转，坐标一直在变），key 用 client.id。
       * lineX = 引出线右端 x（画布右缘），卡片挂在它外面 —— 见下方注释。
       */
      const hits: GlobeHit[] = []
      const lineEndX = w - 2
      /** 宽屏才画引出线（与 tokens.css 的 900px 媒体查询保持一致） */
      const wideLayout = window.innerWidth > 900
      /*
       * 先把本帧全部客户端**一次性**分配落点（吸附到大陆 + 互相保持间隔），
       * 再逐个取用。分配是顺序相关的，必须整批算 —— 见 assignClientLocations。
       * 已有缓存时这一步是 O(N) 查表，几乎零成本。
       */
      const assigned = assignClientLocations(clientsRef.current.map((client) => client.id))
      clientsRef.current.forEach((client) => {
        const location = assigned.get(client.id) ?? clientLocation(client.id)
        const lat = (location.lat * Math.PI) / 180
        const lon = (location.lon * Math.PI) / 180 + rotation
        const x = Math.cos(lat) * Math.sin(lon)
        const baseY = Math.sin(lat)
        const baseZ = Math.cos(lat) * Math.cos(lon)
        const y = baseY * tiltCos - baseZ * tiltSin
        const z = baseY * tiltSin + baseZ * tiltCos
        if (z < -0.08) return
        const px = cx + x * r
        const py = cy - y * r
        const active = client.id === activeClientRef.current
        const hovered = client.id === hoveredClientRef.current
        const color = client.injected ? '#36d39a' : '#ffb45c'
        const pulse = 1 + Math.sin(now / 340 + hashSeed(client.id) % 5) * .18
        hits.push({ id: client.id, x: px, y: py, radius: active || hovered ? 15 : 11 })
        context.globalAlpha = glowT
        /*
         * ══ 悬停引出线（用户指定图2样式）══════════════════════════════════
         * 参考图里每个厂区节点都拉一条水平细线到右侧的照片卡片。
         * 这里同构：hover 的橙点 → 画一条水平线到画布右缘，React 层在
         * 画布**外面**（右侧留白区）渲染卡片，卡片左缘正好接上这条线。
         * 画在 canvas 里而不是 DOM：线条要跟着球一起转、一起缩放，
         * 用 DOM 画就得每帧同步 transform，得不偿失。
         */
        if (hovered) {
          /*
           * 引出线只在**宽屏**画：窄屏时地球右侧没有留白区（信息面板会占住），
           * 卡片改用「橙点正上方」布局，此时画一条水平线到画布右缘反而
           * 指向空白处，是坏视觉。阈值与 CSS 媒体查询保持一致（见 tokens.css）。
           */
          if (wideLayout) {
            context.strokeStyle = dark ? 'rgba(255,255,255,.34)' : 'rgba(20,70,62,.28)'
            context.lineWidth = 1
            context.beginPath()
            context.moveTo(px, py)
            context.lineTo(lineEndX, py)
            context.stroke()
            // 右端一个小圆头，视觉上把线「钉」在画布边界上（同参考图）
            context.fillStyle = color
            context.beginPath(); context.arc(lineEndX, py, 2.6, 0, Math.PI * 2); context.fill()
          }
        }
        // 悬停：加一圈高亮环，给用户「这个点可交互」的反馈
        if (hovered) {
          context.strokeStyle = `${color}ff`
          context.lineWidth = 2.4
          context.beginPath(); context.arc(px, py, 20, 0, Math.PI * 2); context.stroke()
        }
        context.strokeStyle = `${color}${active ? 'cc' : '7a'}`
        context.lineWidth = active ? 2.2 : 1.4
        context.beginPath(); context.arc(px, py, (active ? 14 : 9) * pulse, 0, Math.PI * 2); context.stroke()
        context.fillStyle = color
        context.shadowColor = color; context.shadowBlur = active || hovered ? 24 : 13
        context.beginPath(); context.arc(px, py, active ? 6.2 : 4.2, 0, Math.PI * 2); context.fill()
        context.shadowBlur = 0
        context.globalAlpha = 1
      })
      hitsRef.current = hits
      onHitsRef.current(hits)
      }
      raf = requestAnimationFrame(draw)
    }
    const onPointerDown = (event: PointerEvent) => {
      /*
       * 收起状态下**禁止拖拽**（用户要求）：此时球是自转的背景装饰，
       * 误拖会打断自转节奏。只有展开客户端抽屉时才允许手动转动。
       */
      if (!expandedRef.current) return
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      velocity = 0
      tiltVelocity = 0
      canvas.setPointerCapture(event.pointerId)
      canvas.classList.add('is-dragging')
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) {
        /*
         * 非拖拽时做**橙点命中检测**（用户要求：移到橙点上显示小 UI）。
         * 坐标换算：hits 存的是 canvas 逻辑像素（未乘 dpr），而
         * offsetX/offsetY 同样是元素内逻辑像素 → 直接可比。
         * 用命中半径 + 4px 容差，小点也好点中。
         */
        if (!expandedRef.current) {
          if (hoveredClientRef.current) onHoverClientRef.current(null)
          return
        }
        const mx = event.offsetX
        const my = event.offsetY
        let found: string | null = null
        for (const h of hitsRef.current) {
          const dx = mx - h.x
          const dy = my - h.y
          if (dx * dx + dy * dy <= (h.radius + 4) * (h.radius + 4)) {
            found = h.id
            break
          }
        }
        if (found !== hoveredClientRef.current) onHoverClientRef.current(found)
        return
      }
      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      rotation += dx * 0.008
      velocity = dx * 0.0018
      /*
       * ══ 垂直拖拽方向必须与投影的 y 轴一致（改投影时容易漏）══════════════
       * 投影已改为 py = cy - y*r（北纬在上）。此时「抓住球面往下拖」要
       * 让正面那个点跟着往下走，由 py = cy + sin(tilt)*r 可得需要 tilt 增大
       * —— 所以这里是 **+dy**。
       * 旧代码是 -dy：那是配合旧的 py = cy + y*r（上下颠倒）写的，两者
       * 的符号正好抵消，所以当时手感是对的；只翻投影不改这里，拖拽就会反向。
       */
      tilt = Math.max(-0.78, Math.min(0.78, tilt + dy * 0.006))
      tiltVelocity = dy * 0.0015
    }
    const onPointerLeave = () => {
      if (hoveredClientRef.current) onHoverClientRef.current(null)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      canvas.classList.remove('is-dragging')
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    resize(); draw()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => {
      cancelAnimationFrame(raf); observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
    }
  }, [])

  // 光标提示随模式切换：收起=默认箭头（不可拖），展开=抓取（可拖）
  return <canvas ref={canvasRef} className={`particle-globe${expanded ? ' is-draggable' : ''}`} aria-hidden />
}

export function Dashboard({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  const { reloadClients, clients, targets, versions } = useStore()
  const { theme } = useApp()
  const [focus, setFocus] = useState<GlobeFocus>('clients')
  const [hoveredFocus, setHoveredFocus] = useState<GlobeFocus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [activeClientId, setActiveClientId] = useState<string | null>(null)
  /*
   * 橙点 hover 小 UI。
   *
   * ══ 为什么坐标走 ref + rAF，而不是 setState ══════════════════════════
   * 地球一直在转，橙点的屏幕坐标**每帧都在变**。若把 hits 塞进 state，
   * 就是 60 次/秒的 React 重渲染（整页 diff），白白吃掉主线程。
   * 这里拆成两条路：
   *   · hits → 只进 ref（不触发渲染），供命中检测和坐标读取；
   *   · hoveredClientId → 才进 state（只在「移入/移出某个点」时变一次）；
   * 小 UI 的位置由 rAF 循环直接写 style.transform（不经过 React）。
   */
  const globeHitsRef = useRef<GlobeHit[]>([])
  const tipRef = useRef<HTMLDivElement | null>(null)
  const [hoveredClientId, setHoveredClientId] = useState<string | null>(null)
  /*
   * 宽屏判定（>900px）：决定卡片是「接在引线末端」还是「浮在橙点上方」。
   * 与 tokens.css 的媒体查询同阈值。用 matchMedia 监听而不是每帧读
   * window.innerWidth —— 后者在部分引擎里会强制同步布局，60fps 下是纯浪费。
   */
  const wideRef = useRef(typeof window === 'undefined' ? true : window.innerWidth > 900)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 901px)')
    const sync = () => { wideRef.current = mq.matches }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  useHeroParallax()
  useEffect(() => { void reloadClients() }, [reloadClients])
  const globeClients = useMemo<GlobeClient[]>(() => {
    const merged = new Map<string, GlobeClient>()
    clients.forEach((client) => merged.set(client.id, {
      id: client.id,
      label: client.label || client.id,
      injected: client.injected,
      profileCount: client.profileCount,
      installedLabel: client.installedLabel,
    }))
    targets.forEach((target) => {
      if (!merged.has(target.id)) merged.set(target.id, {
        id: target.id,
        label: target.name,
        injected: Boolean(target.installedVersionId),
        profileCount: target.installedVersionId ? 1 : 0,
        /*
         * targets 那套数据只有 installedVersionId（内部版本 id，如
         * `codex-custom-m3k2`），**不是**给人看的名字 —— 直接显示就是
         * 一串机器标识。这里用 versions 表把它翻成可读名（预设组名称）。
         * 翻不到才退回原 id，至少不显示空。
         */
        installedLabel: target.installedVersionId
          ? (versions.find((v) => v.id === target.installedVersionId)?.label ?? target.installedVersionId)
          : null,
      })
    })
    return Array.from(merged.values())
  }, [clients, targets, versions])
  useEffect(() => {
    if (!activeClientId || globeClients.some((client) => client.id === activeClientId)) return
    setActiveClientId(null)
  }, [activeClientId, globeClients])
  // 收起时不该留着小 UI（标记点整体隐藏了）
  useEffect(() => { if (!expanded) setHoveredClientId(null) }, [expanded])
  /*
   * 引出线卡片跟随：每帧把 hovered 橙点的纵向坐标写到卡片的 transform。
   *
   * ══ 为什么卡片挂在 .globe-frame 内、用 left:100%（用户指定图2样式）══
   * 参考图里每个节点拉一条水平细线到右侧的说明卡片。同构实现：
   *   · 线：由 canvas 画（要跟球一起转、一起缩放）；
   *   · 卡片：React 渲染，锚在 canvas 右缘外侧的留白区，垂直位置跟随橙点。
   * 卡片放在 .globe-frame 内部而不是外面，好处是**共用同一套逻辑像素坐标**
   * —— 直接写 top: hit.y 即可，不需要任何矩阵换算，也自动跟随缩放。
   * （hover 只在展开态发生，此时 frame 的 scale 正好是 1，卡片不会被拉伸。）
   * 仍然用 rAF 直接写 style，不走 setState —— 地球在转，橙点 y 每帧都变。
   */
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const tip = tipRef.current
      if (tip) {
        const hit = hoveredClientId
          ? globeHitsRef.current.find((item) => item.id === hoveredClientId)
          : undefined
        if (hit) {
          /*
           * 宽屏：卡片接在引线末端（垂直居中于橙点）；
           * 窄屏：没有引线，卡片浮在橙点正上方。
           */
          tip.style.transform = wideRef.current
            ? `translate3d(0, ${hit.y}px, 0) translateY(-50%)`
            : `translate3d(${hit.x}px, ${hit.y}px, 0) translate(-50%, calc(-100% - 16px))`
          tip.style.opacity = '1'
        } else {
          tip.style.opacity = '0'
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [hoveredClientId])
  const statuses = [
    { key: 'clients' as GlobeFocus, icon: Boxes, page: 'targets' as PageId, title: '客户端', short: '客', count: globeClients.length, note: '已接入客户端' },
    { key: 'packs' as GlobeFocus, icon: FileText, page: 'skills' as PageId, title: '预设组', short: '组', count: '—', note: '注入预设与技能' },
    { key: 'injected' as GlobeFocus, icon: Activity, page: 'targets' as PageId, title: '已注入', short: '注', count: targets.filter((target) => target.installedVersionId).length, note: '正在生效的目标' },
    { key: 'runtime' as GlobeFocus, icon: FlaskIcon, page: 'runtime' as PageId, title: '运行时', short: '端', count: 'LIVE', note: '运行时链路' },
  ]
  const detailFocus = hoveredFocus ?? focus
  const detail = statuses.find((status) => status.key === detailFocus) ?? statuses[0]
  const hoveredClient = hoveredClientId
    ? globeClients.find((client) => client.id === hoveredClientId)
    : undefined
  return (
    <div className={`page dash-page dash-globe-page globe-${theme}`}>
      {/*
       * 星云 + 星空不在这里渲染 —— 它们挂在 **shell 级**（App.tsx），
       * 否则只能铺到内容区、盖不到顶栏，顶栏下沿会出现分层接缝。
       * 见 App.tsx 里那段注释。
       */}
      <section className={`globe-stage${expanded ? ' is-expanded' : ''}`}>
        <div className="globe-backdrop" />
        <div className="globe-wordmark"><HeroTitle /></div>
        <div className="globe-frame">
          <ParticleGlobe
            focus={focus}
            clients={globeClients}
            activeClientId={activeClientId}
            theme={theme}
            expanded={expanded}
            onHits={(hits) => { globeHitsRef.current = hits }}
            hoveredClientId={hoveredClientId}
            onHoverClient={setHoveredClientId}
          />
          {/*
           * 橙点 hover 卡片（用户指定图2样式）：橙点拉一条水平线到画布右缘，
           * 卡片接在线的末端、落在球体外的留白区。
           * 垂直位置由上面的 rAF 直接写 transform（跟随转动），这里只管内容。
           * 未 hover 时 opacity:0 + pointer-events:none，不挡鼠标。
           *
           * 已注入时显示**注入的是哪个预设组**（用户要求），而不仅是"已注入"。
           * 预设组名取自 clients_list 的 installedLabel（读安装状态文件得到），
           * 拿不到时退回只显示状态，不显示一个空行。
           */}
          <div className={`globe-tip${hoveredClientId ? ' is-on' : ''}`} ref={tipRef} aria-hidden>
            <span className={`globe-tip-dot${hoveredClient?.injected ? ' is-ready' : ''}`} />
            <span className="globe-tip-body">
              <b className="globe-tip-label">{hoveredClient?.label ?? ''}</b>
              {hoveredClient?.injected && hoveredClient.installedLabel ? (
                <>
                  <span className="globe-tip-state is-ready">已注入</span>
                  <span className="globe-tip-preset">{hoveredClient.installedLabel}</span>
                </>
              ) : (
                <span className="globe-tip-state">待配置</span>
              )}
            </span>
          </div>
        </div>
        <div className="globe-status-rail">
          {statuses.map(({ key, icon: Icon, page, title, short }) => (
            <button key={key} className={`globe-status${focus === key ? ' active' : ''}`} title={`${title} · 双击进入`} aria-label={title} onClick={() => { setFocus(key); setActiveClientId(null) }} onDoubleClick={() => onNavigate(page)} onPointerEnter={() => setHoveredFocus(key)} onPointerLeave={() => setHoveredFocus(null)} onFocus={() => setHoveredFocus(key)} onBlur={() => setHoveredFocus(null)}>
              <Icon size={17} />
              <span className="globe-status-label">{short}</span>
              <span className="globe-status-dot" />
            </button>
          ))}
        </div>
        <aside className={`globe-info-panel${hoveredFocus ? ' is-hovered' : ''}${hoveredClientId ? ' is-muted' : ''}`} aria-live="polite" onPointerEnter={() => setHoveredFocus(detailFocus)} onPointerLeave={() => setHoveredFocus(null)}>
          <div className="globe-info-kicker"><span className="globe-info-live" />{detail.short} / ALICE</div>
          <strong>{detail.title}</strong>
          <span className="globe-info-note">{detail.note}</span>
          <div className="globe-info-metric"><b>{detail.count}</b><span>个节点</span></div>
          <button className="globe-info-link" onClick={() => onNavigate(detail.page)}>
            打开模块 <ArrowUpRight size={13} />
          </button>
        </aside>
        {/*
         * 开关（用户指定图1样式）：玻璃胶囊 + 绿色圆钮（带地球图标）+ 文字。
         * 圆钮**真的左右滑动**，文字随之切换 —— 不是只变色。
         *   关 → 圆钮在左，文字 Clients（地球自转，不可拖）
         *   开 → 圆钮滑到右，文字 Close（地球停转，可拖）
         * 抽屉已按用户要求整体删除。
         */}
        <div className="client-dock">
          <button
            className={`glass-switch${expanded ? ' on' : ''}`}
            onClick={() => setExpanded((open) => !open)}
            role="switch"
            aria-checked={expanded}
            aria-label={expanded ? '关闭' : '展开客户端'}
            title={expanded ? '关闭（恢复地球自转）' : '展开（可拖拽地球）'}
          >
            <span className="glass-switch-knob" aria-hidden>
              <Globe2 size={15} />
            </span>
            <span className="glass-switch-label">{expanded ? 'Close' : 'Clients'}</span>
          </button>
        </div>
      </section>
      <CursorBlob />
    </div>
  )
}
