/**
 * Verlet 布料。
 *
 * 和蒙皮（garment-mesh.ts）是两套东西：蒙皮是「衣服跟着骨头走」，这里是「衣服自己
 * 有重量、有惯性」。衣服穿在身上时走蒙皮，被脱下来的那一刻交给这里。
 *
 * Verlet 积分不存速度，速度隐含在「当前位置 − 上一帧位置」里。好处是约束求解可以
 * 直接改位置，不用回头修速度，布料这种「一堆距离约束」的东西写起来特别顺。
 */

export interface ClothParams {
  /** 阻尼。每步速度乘这个数，越小越「肉」 */
  friction: number
  /** 重力，单位是 px/步² */
  gravity: number
  /** 约束迭代次数。越多越不像橡皮筋 */
  iterations: number
  /**
   * 每次迭代修正误差的比例。1 = 一次到位（布会变得又硬又容易抽搐），
   * 0.4 偏软，配合多迭代几次，既不锁死又收得住。
   */
  stiffness: number
  /** 微风强度（px/步²）。0 就是没风 */
  wind: number
  /** 加两条对角约束，避免网格剪切成细长的「海带」 */
  shear: boolean
  /** 对角约束相对基础结构的强度；只需轻微保形，太高会像硬纸片 */
  shearStrength: number
  /** 加跨两格的抗弯约束，让布以更完整的一片移动 */
  bend: boolean
}

export const CLOTH_DEFAULTS: ClothParams = {
  friction: 0.94,
  gravity: 0.08,
  iterations: 12,
  stiffness: 0.4,
  wind: 0.06,
  shear: false,
  shearStrength: 0.18,
  bend: false,
}

export interface ClothPull {
  x: number
  y: number
  k: number
  only?: Int32Array
}

/* ── Perlin 噪声 ─────────────────────────────────────────────
 * 微风不能用 Math.random() —— 每帧独立的随机数是白噪声，布会高频抖，像触电。
 * 风得是「空间上连续、时间上连续」的，所以用梯度噪声。
 */
const PERM = new Uint8Array(512)
{
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  // 固定种子的洗牌：每次运行的风场一样，调参时才可复现
  let seed = 1337
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const j = seed % (i + 1)
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const grad2 = (hash: number, x: number, y: number) => {
  switch (hash & 3) {
    case 0: return x + y
    case 1: return -x + y
    case 2: return x - y
    default: return -x - y
  }
}

/** 二维 Perlin，返回大致 [-1, 1] */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x) & 255
  const yi = Math.floor(y) & 255
  const xf = x - Math.floor(x)
  const yf = y - Math.floor(y)
  const u = fade(xf)
  const v = fade(yf)
  const aa = PERM[PERM[xi] + yi]
  const ab = PERM[PERM[xi] + yi + 1]
  const ba = PERM[PERM[xi + 1] + yi]
  const bb = PERM[PERM[xi + 1] + yi + 1]
  const x1 = grad2(aa, xf, yf) + u * (grad2(ba, xf - 1, yf) - grad2(aa, xf, yf))
  const x2 = grad2(ab, xf, yf - 1) + u * (grad2(bb, xf - 1, yf - 1) - grad2(ab, xf, yf - 1))
  return x1 + v * (x2 - x1)
}

/* ── 布 ─────────────────────────────────────────────────────── */

export class Cloth {
  readonly cols: number
  readonly rows: number
  readonly count: number

  /** 当前位置和上一帧位置。速度 = 两者之差 */
  readonly x: Float32Array
  readonly y: Float32Array
  private px: Float32Array
  private py: Float32Array

  /** 1 = 钉住不动 */
  readonly pinned: Uint8Array

  /** 约束：sticks[i*2] 和 sticks[i*2+1] 两个点，静止距离 restLen[i] */
  private sticks: Int32Array
  private restLen: Float32Array
  private stickStrength: Float32Array

  params: ClothParams
  private t = 0

  constructor(cols: number, rows: number, params: Partial<ClothParams> = {}) {
    this.cols = cols
    this.rows = rows
    this.count = cols * rows
    this.params = { ...CLOTH_DEFAULTS, ...params }

    this.x = new Float32Array(this.count)
    this.y = new Float32Array(this.count)
    this.px = new Float32Array(this.count)
    this.py = new Float32Array(this.count)
    this.pinned = new Uint8Array(this.count)

    // 基础结构约束：右邻居 + 下邻居。飞向身体时可以额外打开剪切和抗弯约束，
    // 让衣服保持为一整片；脱下掉落仍沿用默认值，保留更软的折叠感。
    const list: number[] = []
    const strengths: number[] = []
    const add = (a: number, b: number, strength = 1) => {
      list.push(a, b)
      strengths.push(strength)
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        if (c + 1 < cols) add(i, i + 1)
        if (r + 1 < rows) add(i, i + cols)
        if (this.params.shear && r + 1 < rows) {
          if (c + 1 < cols) add(i, i + cols + 1, this.params.shearStrength)
          if (c > 0) add(i, i + cols - 1, this.params.shearStrength)
        }
        if (this.params.bend) {
          if (c + 2 < cols) add(i, i + 2)
          if (r + 2 < rows) add(i, i + cols * 2)
        }
      }
    }
    this.sticks = new Int32Array(list)
    this.restLen = new Float32Array(list.length / 2)
    this.stickStrength = new Float32Array(strengths)
  }

  /**
   * 用一组位置初始化。静止长度按这组位置量 —— 所以从「衣服穿在身上此刻的样子」
   * 接管时，布不会先弹一下再垂下来，是从当前形状无缝接手的。
   */
  reset(x: ArrayLike<number>, y: ArrayLike<number>) {
    this.x.set(x as never)
    this.y.set(y as never)
    this.px.set(this.x)
    this.py.set(this.y)
    this.pinned.fill(0)
    const s = this.sticks
    for (let k = 0; k < this.restLen.length; k++) {
      const a = s[k * 2]
      const b = s[k * 2 + 1]
      this.restLen[k] = Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b])
    }
    this.t = 0
  }

  /**
   * 给每个点撒一点随机位移，让布一开始就不规则 —— 完全对称的初始状态会折得像张纸。
   *
   * 关键：**上一帧位置要跟着挪同样的量**。Verlet 里位置差就是速度，只改当前位置
   * 等于凭空给每个点一个初速度；而 Y 范围是偏上的（−35~5，均值 −15），那就是
   * 整块布被往上弹一下，按 friction 0.965 衰减累计能飘出四百多像素。
   * 这里只要形状上的不规则，垂直方向的运动交给 lift 单独控制，两件事分开才调得动。
   */
  scatter(ax: number, ay0: number, ay1: number) {
    for (let i = 0; i < this.count; i++) {
      if (this.pinned[i]) continue
      const dx = (Math.random() * 2 - 1) * ax
      const dy = ay0 + Math.random() * (ay1 - ay0)
      this.x[i] += dx
      this.y[i] += dy
      this.px[i] += dx
      this.py[i] += dy
    }
  }

  /**
   * 把所有静止边长乘一个系数 —— 布会自己撑开或收拢到新尺寸。
   *
   * 从文件夹里飘出来时用：布一开始只有图标那么大，一路把静止长度放大到身体尺寸，
   * 约束会把顶点慢慢推开。直接改顶点坐标做不到这个效果，那样只是平移缩放，
   * 布不会「撑」。
   */
  scaleRest(f: number) {
    if (f === 1) return
    for (let k = 0; k < this.restLen.length; k++) this.restLen[k] *= f
  }

  /** 给某个点一个瞬时速度（Verlet 里就是把「上一帧位置」往回挪） */
  push(i: number, vx: number, vy: number) {
    this.px[i] -= vx
    this.py[i] -= vy
  }

  /**
   * 整块布一记冲量。脱衣服时「被甩起来」的那一下就是这个。
   *
   * 上升高度 ≈ v / (1 − friction)。friction 0.965 时就是 v 的 28.6 倍 ——
   * 想升 80px 给 2.8 就行，这个旋钮是线性的，好调。
   */
  launch(vx: number, vy: number) {
    for (let i = 0; i < this.count; i++) {
      if (this.pinned[i]) continue
      this.px[i] -= vx
      this.py[i] -= vy
    }
  }

  pin(i: number, on = true) {
    this.pinned[i] = on ? 1 : 0
  }

  /**
   * 走一步。
   *
   * @param pull 吸引力。`only` 给了就**只拽那几个点**，其余靠约束被带过去 ——
   *   这是「布」和「一堆被吸向同一点的粒子」的分界线：全都拽的话网格会塌成退化
   *   三角形，穿插、糊在一起，看着就是碎掉；只拽住领口那几针，剩下的自然垂着
   *   跟过去，形状一直保得住。
   * @param lift 额外的上升力（负 y），做「飘起来」而不是「掉下去」
   */
  step(pull?: ClothPull | ClothPull[], lift = 0) {
    const { friction, gravity, iterations, stiffness, wind } = this.params
    const pulls = pull ? (Array.isArray(pull) ? pull : [pull]) : []
    this.t += 1

    // ① 积分
    for (let i = 0; i < this.count; i++) {
      if (this.pinned[i]) continue
      const vx = (this.x[i] - this.px[i]) * friction
      const vy = (this.y[i] - this.py[i]) * friction
      this.px[i] = this.x[i]
      this.py[i] = this.y[i]

      let ax = 0
      let ay = gravity - lift
      if (wind) {
        // 风场随位置和时间连续变化 —— 这就是「呼吸感」的来源
        ax += noise2(this.x[i] * 0.01, this.t * 0.01) * wind
        ay += noise2(this.y[i] * 0.01, this.t * 0.01 + 100) * wind * 0.4
      }
      for (const p of pulls) {
        if (p.only) continue
        ax += (p.x - this.x[i]) * p.k
        ay += (p.y - this.y[i]) * p.k
      }
      this.x[i] += vx + ax
      this.y[i] += vy + ay
    }

    // ①b 只拽指定的那几针
    for (const p of pulls) {
      if (!p.only) continue
      for (let n = 0; n < p.only.length; n++) {
        const i = p.only[n]
        if (this.pinned[i]) continue
        this.x[i] += (p.x - this.x[i]) * p.k
        this.y[i] += (p.y - this.y[i]) * p.k
      }
    }

    // ② 反复把距离拉回静止长度。一次只修 stiffness 那么多，多来几轮慢慢收敛
    const s = this.sticks
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < this.restLen.length; k++) {
        const a = s[k * 2]
        const b = s[k * 2 + 1]
        const dx = this.x[b] - this.x[a]
        const dy = this.y[b] - this.y[a]
        const d = Math.hypot(dx, dy)
        if (d < 1e-6) continue
        // 误差按比例分摊给两端，被钉住的那端不动
        const diff = ((d - this.restLen[k]) / d) * stiffness * this.stickStrength[k]
        const ox = dx * diff * 0.5
        const oy = dy * diff * 0.5
        const pa = this.pinned[a]
        const pb = this.pinned[b]
        if (pa && pb) continue
        if (!pa && !pb) {
          this.x[a] += ox
          this.y[a] += oy
          this.x[b] -= ox
          this.y[b] -= oy
        } else if (pa) {
          this.x[b] -= ox * 2
          this.y[b] -= oy * 2
        } else {
          this.x[a] += ox * 2
          this.y[a] += oy * 2
        }
      }
    }
  }
}
