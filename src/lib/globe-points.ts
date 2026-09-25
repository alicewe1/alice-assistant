/**
 * 地球点阵：加载、增量生成、进度订阅。
 *
 * ══ 为什么单独成模块 ═══════════════════════════════════════════════════
 * 点阵生成是总览页最重的一次计算（16434 个经纬格点 × 286 个多边形环的
 * 射线法面内测试，实测 3775ms）。它有两个消费者：
 *   ① 总览页的 canvas 绘制循环（要「已有多少点」）；
 *   ② 开场动画的进度条（要「整体完成了几成」）。
 * 放在页面组件里，开场动画就没法在总览页挂载前拿到进度 —— 而开场动画
 * 存在的意义恰恰是**盖住这段计算**。所以抽到模块级：模块内自己驱动
 * 增量生成，两边都只是订阅者。
 *
 * ══ 三级策略 ═════════════════════════════════════════════════════════
 *   ① 模块级缓存：算过一次后任何重挂载 0 成本；
 *   ② **分帧增量生成**：不再一口气跑完 3775ms，切成小块在 rAF 里推进 ——
 *      主线程每帧只花几毫秒，界面全程可响应，开场动画不卡；
 *   ③ **时间片预算**：每帧干到 ~7ms 就收手（而不是固定 250 个格点）。
 *      固定预算在快机器上白白拖长时间，在慢机器上又会掉帧；按时间切
 *      才能同时满足「快机尽快完成」和「慢机不卡」。
 *
 * ══ bbox 预筛（把 3775ms 压到几百毫秒）═══════════════════════════════
 * 每个多边形环先算一次轴对齐包围盒。面内测试前先做 4 次数值比较 ——
 * 绝大多数环（286 个里通常 280+ 个）在这一步就被排除，不再进入逐边
 * 循环。这是纯几何优化，**不改变任何点的判定结果**（包围盒外的点必然
 * 在多边形外），所以点阵与旧实现逐点一致。
 */

export type GeoPoint = { lon: number; lat: number; size: number; land: boolean }

export type GlobeProgress = {
  /** 0..1 总体进度 */
  progress: number
  /** 当前阶段，供开场动画显示文案 */
  phase: 'shapes' | 'land' | 'ambient' | 'done'
  /** 点阵是否已完全就绪 */
  ready: boolean
}

type GeoFeatureCollection = { features: Array<{ geometry: { type: string; coordinates: unknown } }> }
/** 多边形环 + 其轴对齐包围盒（bbox 预筛用） */
type LandRing = { ring: Array<[number, number]>; minLon: number; maxLon: number; minLat: number; maxLat: number }

/*
 * ══ geojson 动态导入（消除启动白屏）══════════════════════════════════
 * 世界地图 geojson 原始 252KB，原先用 `?raw` 静态导入 —— 会被打进主
 * bundle，使入口 JS 从 ~400KB 膨胀到 **649KB**：应用启动时浏览器必须先
 * 下载+解析完这 649KB 才能渲染首屏，这就是「打开软件白屏一会儿」的主因。
 * 改为动态 import 后它成为独立 chunk，只在真正需要点阵时按需加载；
 * 首屏 bundle 因此瘦身约 250KB。
 */
let landShapes: LandRing[] | null = null
let landShapesLoading: Promise<void> | null = null

function loadLandShapes(): Promise<void> {
  if (landShapes) return Promise.resolve()
  if (!landShapesLoading) {
    landShapesLoading = import('@/data/world.geojson?raw').then((mod) => {
      const geo = JSON.parse((mod as { default: string }).default) as GeoFeatureCollection
      landShapes = geo.features
        .flatMap((feature) => {
          if (feature.geometry.type === 'Polygon')
            return (feature.geometry.coordinates as Array<Array<[number, number]>>).slice(0, 1)
          if (feature.geometry.type === 'MultiPolygon')
            return (feature.geometry.coordinates as Array<Array<Array<[number, number]>>>).map((polygon) => polygon[0])
          return []
        })
        .filter((ring) => ring.length > 3)
        .map(toRing)
    })
  }
  return landShapesLoading
}

/** 环 → 带包围盒的结构（遍历一次算完 bbox） */
function toRing(ring: Array<[number, number]>): LandRing {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { ring, minLon, maxLon, minLat, maxLat }
}

/** 射线法：点是否在环内。调用方需已通过 bbox 预筛。 */
function insideRing(lon: number, lat: number, shape: Array<[number, number]>) {
  let inside = false
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [xi, yi] = shape[i]
    const [xj, yj] = shape[j]
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (hit) inside = !inside
  }
  return inside
}

/** 点是否落在任一大陆环内（先 bbox 预筛，再逐边射线法） */
function isLand(lon: number, lat: number, shapes: LandRing[]): boolean {
  for (const s of shapes) {
    if (lon < s.minLon || lon > s.maxLon || lat < s.minLat || lat > s.maxLat) continue
    if (insideRing(lon, lat, s.ring)) return true
  }
  return false
}

/** 格点总数（纬度 83 档 × 经度 198 档），进度分母用 */
const LAT_STEPS = Math.floor((78 - -58) / 1.65) + 1
const LON_STEPS = Math.floor((178 - -178) / 1.8) + 1
const TOTAL_GRID = LAT_STEPS * LON_STEPS
const AMBIENT_TOTAL = 760

export let cachedGlobePoints: GeoPoint[] | null = null
/** 增量生成中的临时状态（null = 未开始或已完成） */
let buildingPoints: GeoPoint[] | null = null
let buildCursor = { lat: -58, lon: -178, phase: 0, seed: 17, ambient: 0, gridDone: 0 }

const buildRandom = () => {
  buildCursor.seed = (buildCursor.seed * 9301 + 49297) % 233280
  return buildCursor.seed / 233280
}

/* ------------------------------------------------------------------ *
 * 进度订阅
 * ------------------------------------------------------------------ */

const listeners = new Set<(p: GlobeProgress) => void>()
let lastProgress: GlobeProgress = { progress: 0, phase: 'shapes', ready: false }

export function globeProgress(): GlobeProgress {
  return lastProgress
}

/** 订阅进度变化；会立刻用当前值回调一次（订阅者不必自己补初始态） */
export function subscribeGlobeProgress(fn: (p: GlobeProgress) => void): () => void {
  listeners.add(fn)
  fn(lastProgress)
  return () => { listeners.delete(fn) }
}

function emit(next: GlobeProgress) {
  // 进度只增不减（生成是单向的，任何回退都说明调用方算错了）
  if (next.progress < lastProgress.progress && !next.ready) return
  /*
   * 去重：生成循环每帧都会 emit 一次，但绝大多数帧的进度变化极小
   * （甚至为 0，比如等 geojson 的那几帧）。值没变就不通知 —— 否则
   * 订阅者（开场动画）会每帧 setState，白白重渲染。
   * ready 翻转必须通知，哪怕 progress 数值没动。
   */
  if (next.progress === lastProgress.progress && next.ready === lastProgress.ready && next.phase === lastProgress.phase) return
  lastProgress = next
  for (const fn of listeners) fn(next)
}

/** 当前可用的点阵（增量生成中返回已生成的部分） */
export function currentGlobePoints(): GeoPoint[] {
  return cachedGlobePoints ?? buildingPoints ?? []
}

/* ------------------------------------------------------------------ *
 * 增量生成
 * ------------------------------------------------------------------ */

/** 每帧时间预算（毫秒）。7ms 给浏览器留出 ~9ms 做样式/合成，稳定 60fps。 */
const FRAME_BUDGET_MS = 7

let rafId = 0
let running = false

/**
 * 推进一小块生成。
 * @returns 是否已完成
 */
function buildStep(): boolean {
  if (cachedGlobePoints) return true
  if (!landShapes) {
    // geojson 还在动态导入中：进度先给一小段（0 → 0.06），等它就位
    void loadLandShapes()
    emit({ progress: 0.06, phase: 'shapes', ready: false })
    return false
  }
  if (!buildingPoints) buildingPoints = []
  const pts = buildingPoints
  const shapes = landShapes
  const deadline = performance.now() + FRAME_BUDGET_MS

  // 阶段 0：陆地点阵（逐格点做面内测试，最贵）
  while (buildCursor.phase === 0) {
    const { lat, lon } = buildCursor
    /*
     * ══ 抖动与测试的**顺序**（橙点落海的根因）═════════════════════════
     * 旧实现：先测格点 (lat,lon) 是否在陆地内，通过后再把坐标抖动
     * ±0.7° / ±0.55° 推入点阵 —— 于是「通过测试的是格点，落进点阵的却是
     * 格点旁边那个点」，实测约 15% 的 land 点被抖到了海岸线外的海里。
     * 这些点视觉上无害（紧贴海岸，肉眼分不出），但**橙点吸附到它们就会
     * 飘在海面上**（用户报的 bug）。
     * 现在：先抖动、后测试 —— 点阵里每个 land 点都保证真实落在陆地多边形
     * 内部，橙点吸上去必然在大陆上。成本完全不变（仍是一次射线测试）。
     */
    const jLon = lon + (buildRandom() - 0.5) * 1.4
    const jLat = lat + (buildRandom() - 0.5) * 1.1
    if (isLand(jLon, jLat, shapes) && buildRandom() > 0.08) {
      pts.push({ lon: jLon, lat: jLat, size: 0.4 + buildRandom() * 1.5, land: true })
    }
    buildCursor.gridDone++
    buildCursor.lon += 1.8
    if (buildCursor.lon > 178) {
      buildCursor.lon = -178
      buildCursor.lat += 1.65
      if (buildCursor.lat > 78) buildCursor.phase = 1
    }
    // 时间到就收手，下一帧继续（保证开场动画不掉帧）
    if (performance.now() >= deadline) {
      emit(landProgress())
      return false
    }
  }
  // 阶段 1：背景星点（很便宜，但同样按时间片走）
  while (buildCursor.phase === 1 && buildCursor.ambient < AMBIENT_TOTAL) {
    const lat = -80 + buildRandom() * 160
    const lon = -180 + buildRandom() * 360
    pts.push({ lon, lat, size: 0.28 + buildRandom() * 1.05, land: false })
    buildCursor.ambient++
    if (performance.now() >= deadline) {
      emit(landProgress())
      return false
    }
  }
  cachedGlobePoints = pts
  buildingPoints = null
  emit({ progress: 1, phase: 'done', ready: true })
  return true
}

/** 陆地阶段占进度 0.06→0.9，星点阶段 0.9→1（星点很快，给一小段就够） */
function landProgress(): GlobeProgress {
  const landRatio = buildCursor.gridDone / TOTAL_GRID
  const ambientRatio = buildCursor.ambient / AMBIENT_TOTAL
  const progress = 0.06 + landRatio * 0.84 + ambientRatio * 0.1
  return {
    progress: Math.min(0.999, progress),
    phase: buildCursor.phase === 0 ? 'land' : 'ambient',
    ready: false,
  }
}

/**
 * 启动增量生成（幂等）。开场动画与总览页都调它。
 * 完成后 rAF 循环自行停止，不留后台开销。
 */
export function ensureGlobeBuild(): void {
  // 已算完：直接把 ready 补发一次，订阅者不必自己判断缓存状态
  if (cachedGlobePoints) {
    if (!lastProgress.ready) emit({ progress: 1, phase: 'done', ready: true })
    return
  }
  if (running) return
  running = true
  const tick = () => {
    if (buildStep()) {
      running = false
      rafId = 0
      return
    }
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
}

/** 测试/热重载用：停掉后台生成循环 */
export function stopGlobeBuild(): void {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  running = false
}
