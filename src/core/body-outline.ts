/**
 * 人形轮廓：把 Pose 模型的人物置信度遮罩描成一圈闭合折线，用来画「贴着人」的
 * 站位引导线。
 *
 * 为什么不用 33 个关键点连线：关键点最远只到手腕脚踝，连出来是一圈骨架折线，
 * 不像人。分割遮罩是逐像素的，描出来就是这个人真实的外轮廓（头发、手臂、裤腿
 * 都算数），人胖瘦高矮、抬不抬手，线都跟着走。
 *
 * 三步：
 *   1. marching squares 走 0.5 等值线。遮罩是 0~1 的软置信度，在等值线上做
 *      线性插值，描出来是斜线，不会有一格一格的像素台阶；
 *   2. 遮罩上会有好几圈闭合线（零碎噪点、腿缝），只留面积最大的那一圈 ——
 *      那就是人的外轮廓；
 *   3. 按弧长重采样成固定点数，再和上一帧做指数平滑。两帧的点序不一定从同一
 *      个地方起头，所以先整体循环位移找最贴合的起点再逐点混合，否则轮廓会
 *      绕着圈抽。
 *
 * 输出坐标是 0~1 归一化值（和关键点同一套），乘舞台宽高即可。
 */

export interface PoseMaskLike {
  data: Float32Array
  width: number
  height: number
}

/** 轮廓点数。96 个点够画一圈平滑的虚线，再多只是白白增加平滑和对齐的开销 */
const SAMPLE_COUNT = 96
/** 分割置信度的等值线。0.5 是 MediaPipe 自己推荐的二值化阈值 */
const THRESHOLD = 0.5
/** 每帧把新轮廓往旧轮廓拉多少：太小会拖影，太大遮罩边缘的抖动就盖不住 */
const SMOOTHING = 0.35
/** 对齐后平均偏差超过这个值（归一化）就当成换人了，直接跳到新轮廓，不拖过去 */
const SNAP_DISTANCE = 0.08

/**
 * 轮廓调试开关。
 *
 * 浏览器里没有 process —— 直接写 `process?.env?.OUTLINE_DEBUG` 会抛
 * ReferenceError，而且是在每帧的循环里抛，人一进画面整个渲染就断在这儿
 * （后面的帧绘制、站位判定全都被跳过）。所以从 globalThis 上取：
 * 页面里恒为 false，node 下跑脚本时 OUTLINE_DEBUG=1 照旧有用。
 */
const OUTLINE_DEBUG = !!(
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env?.OUTLINE_DEBUG

export class BodyOutline {
  private prev: Float32Array | null = null

  /** 喂一帧遮罩，返回这一帧的轮廓；没有人（或遮罩太小）返回 null */
  update(mask: PoseMaskLike | null): Float32Array | null {
    if (!mask || mask.width < 4 || mask.height < 4 || !mask.data.length) {
      this.prev = null
      return null
    }

    const outer = pickOuter(marchingSquares(mask.data, mask.width, mask.height, THRESHOLD))
    if (!outer) {
      this.prev = null
      return null
    }

    const next = resample(outer, SAMPLE_COUNT, mask.width, mask.height)
    this.prev = this.prev ? blend(this.prev, next, SMOOTHING) : next
    return this.prev
  }

  reset() {
    this.prev = null
  }
}

/* ── marching squares ──────────────────────────────────────────── */

/**
 * 格子四个角按 上左/上右/下右/下左 记成 v0/v1/v2/v3，用 8/4/2/1 拼成 0~15 的
 * 编号，查表连线。每条被穿过的格子边只会被相邻两个格子各用一次（一个当出口、
 * 一个当入口），所以「边的编号」天然就是有向图的节点，顺着走一圈就是一环。
 *
 * 方向统一成「人在行进方向右侧」，这样每帧描出来的绕行方向一致，平滑时不会
 * 一帧顺时针一帧逆时针地拧。
 *
 * 遮罩外面虚拟补一圈 0（人在画面边缘被切掉时就是靠这圈把轮廓沿着画框边闭合
 * 起来的），所以格子坐标从 -1 开始。
 */
function marchingSquares(
  f: Float32Array,
  w: number,
  h: number,
  t: number,
): number[][] {
  const points: number[] = []
  const ids = new Map<number, number>()
  const nextOf = new Map<number, number[]>()

  // 越界一律当 0（人以外都是背景）
  const at = (px: number, py: number): number =>
    px < 0 || py < 0 || px >= w || py >= h ? 0 : f[py * w + px]

  /**
   * 边的编号：格点坐标先整体 +1 挪成非负（x,y ∈ [-1,w]×[-1,h]），
   * 按 (y+1)*(w+2)+(x+1) 排号，水平边 (x,y)-(x+1,y) 记 *2，竖直边记 *2+1。
   */
  const edgePoint = (key: number): number => {
    const cached = ids.get(key)
    if (cached !== undefined) return cached
    const orient = key & 1
    const cell = (key - orient) / 2
    const x = (cell % (w + 2)) - 1
    const y = (cell - (x + 1)) / (w + 2) - 1
    let px: number
    let py: number
    if (orient === 0) {
      const a = at(x, y)
      const b = at(x + 1, y)
      px = x + (t - a) / (b - a)
      py = y
    } else {
      const a = at(x, y)
      const b = at(x, y + 1)
      px = x
      py = y + (t - a) / (b - a)
    }
    points.push(px, py)
    const id = points.length / 2 - 1
    ids.set(key, id)
    return id
  }

  const link = (from: number, to: number) => {
    const list = nextOf.get(from)
    if (list) list.push(to)
    else nextOf.set(from, [to])
  }

  const row = w + 2
  const key = (x: number, y: number, orient: number) => (((y + 1) * row + (x + 1)) * 2) + orient

  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const v0 = at(x, y)
      const v1 = at(x + 1, y)
      const v2 = at(x + 1, y + 1)
      const v3 = at(x, y + 1)

      const b0 = v0 > t
      const b1 = v1 > t
      const b2 = v2 > t
      const b3 = v3 > t
      const code = (b0 ? 8 : 0) | (b1 ? 4 : 0) | (b2 ? 2 : 0) | (b3 ? 1 : 0)
      if (code === 0 || code === 15) continue

      const top = key(x, y, 0)
      const right = key(x + 1, y, 1)
      const bottom = key(x, y + 1, 0)
      const left = key(x, y, 1)

      switch (code) {
        case 1: link(left, bottom); break
        case 2: link(bottom, right); break
        case 3: link(left, right); break
        case 4: link(right, top); break
        case 5: {
          // 对角两格在内，是鞍点：看中心值决定两片是连着还是分开
          const center = (v0 + v1 + v2 + v3) / 4
          if (center > t) {
            link(top, left)
            link(right, bottom)
          } else {
            link(right, top)
            link(left, bottom)
          }
          break
        }
        case 6: link(bottom, top); break
        case 7: link(left, top); break
        case 8: link(top, left); break
        case 9: link(top, bottom); break
        case 10: {
          const center = (v0 + v1 + v2 + v3) / 4
          if (center > t) {
            link(right, top)
            link(bottom, left)
          } else {
            link(bottom, right)
            link(top, left)
          }
          break
        }
        case 11: link(top, right); break
        case 12: link(right, left); break
        case 13: link(right, bottom); break
        case 14: link(bottom, left); break
        default: break
      }
    }
  }

  // 顺着有向边把线段串成环，串过的边划掉，避免重复走
  const loops: number[][] = []
  for (const start of [...nextOf.keys()]) {
    let cur = start
    const loop: number[] = []
    while (true) {
      const outs = nextOf.get(cur)
      if (!outs || !outs.length) break
      const nxt = outs.pop() as number
      loop.push(edgePoint(cur)) // 先收点下标，串完再换成坐标
      cur = nxt
      if (cur === start) break
    }
    if (cur === start && loop.length >= 3) loops.push(loop)
    if (OUTLINE_DEBUG) console.log('walk', { start, cur, len: loop.length, closed: cur === start })
  }
  if (OUTLINE_DEBUG) console.log('edges', nextOf.size, 'points', points.length / 2, 'loops', loops.length)
  // 点下标 → 坐标：points 是 x,y 交替排的
  return loops.map((loop) => loop.flatMap((i) => [points[i * 2], points[i * 2 + 1]]))
}

/* ── 取外轮廓 / 重采样 / 平滑 ───────────────────────────────────── */

/** 环的带符号面积，既用来挑最大的那圈，也用来看绕行方向 */
function signedArea(pts: number[]): number {
  let sum = 0
  for (let i = 0, n = pts.length / 2; i < n; i++) {
    const j = (i + 1) % n
    sum += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]
  }
  return sum / 2
}

function pickOuter(loops: number[][]): number[] | null {
  let best: number[] | null = null
  let bestArea = 0
  for (const loop of loops) {
    const area = Math.abs(signedArea(loop))
    if (area > bestArea) {
      bestArea = area
      best = loop
    }
  }
  return best
}

/**
 * 按弧长把闭合折线切成固定点数的等分点，顺便归一化到 0~1、统一成逆时针。
 * 固定点数 + 统一起点之后，两帧的轮廓才能一一对应着混合。
 */
function resample(pts: number[], count: number, w: number, h: number): Float32Array {
  const n = pts.length / 2
  const ordered = signedArea(pts) < 0 ? reverse(pts) : pts

  const segLen: number[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = ordered[j * 2] - ordered[i * 2]
    const dy = ordered[j * 2 + 1] - ordered[i * 2 + 1]
    const len = Math.hypot(dx, dy)
    segLen.push(len)
    total += len
  }

  const out = new Float32Array(count * 2)
  if (total <= 0) return out
  const step = total / count
  let seg = 0
  let walked = 0
  for (let k = 0; k < count; k++) {
    const target = k * step
    while (seg < n - 1 && walked + segLen[seg] < target) {
      walked += segLen[seg]
      seg++
    }
    const t = segLen[seg] > 0 ? (target - walked) / segLen[seg] : 0
    const i = seg
    const j = (seg + 1) % n
    const x = ordered[i * 2] + (ordered[j * 2] - ordered[i * 2]) * t
    const y = ordered[i * 2 + 1] + (ordered[j * 2 + 1] - ordered[i * 2 + 1]) * t
    // 按遮罩栅格的整宽整高归一化：轮廓点可以落在虚拟的第 w/h 列上（贴着画框
    // 边闭合的那段），除 w-1 / h-1 会稍微溢出画框
    out[k * 2] = x / w
    out[k * 2 + 1] = y / h
  }
  return out
}

function reverse(pts: number[]): number[] {
  const out: number[] = []
  for (let i = pts.length / 2 - 1; i >= 0; i--) out.push(pts[i * 2], pts[i * 2 + 1])
  return out
}

/**
 * 把新轮廓整体转若干格，转到和上一帧最贴合的位置再逐点混合。
 * 平均偏差太大（人换了、人跳进来）就不混合了，直接换成新轮廓。
 */
function blend(prev: Float32Array, next: Float32Array, alpha: number): Float32Array {
  const n = next.length / 2
  let bestShift = 0
  let bestErr = Infinity
  for (let s = 0; s < n; s++) {
    let err = 0
    for (let i = 0; i < n; i++) {
      const j = (i + s) % n
      const dx = next[j * 2] - prev[i * 2]
      const dy = next[j * 2 + 1] - prev[i * 2 + 1]
      err += dx * dx + dy * dy
    }
    if (err < bestErr) {
      bestErr = err
      bestShift = s
    }
  }
  if (Math.sqrt(bestErr / n) > SNAP_DISTANCE) return next

  const out = new Float32Array(next.length)
  for (let i = 0; i < n; i++) {
    const j = (i + bestShift) % n
    out[i * 2] = prev[i * 2] + (next[j * 2] - prev[i * 2]) * alpha
    out[i * 2 + 1] = prev[i * 2 + 1] + (next[j * 2 + 1] - prev[i * 2 + 1]) * alpha
  }
  return out
}
