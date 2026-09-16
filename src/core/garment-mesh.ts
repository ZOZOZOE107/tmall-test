/**
 * 方案 C：网格变形（2D 线性混合蒙皮）。
 *
 * 把衣服图切成网格，每个顶点按「到各条骨头的距离」分配权重。每帧根据骨骼点
 * 算出五条骨头的相似变换，顶点位置 = 各骨头变换的加权混合。抬手时袖子跟着走。
 *
 * 上衣和下装共用这套代码，区别只在 rig.ts 里的骨架定义。
 *
 * Canvas 2D 做不了任意网格变形（drawImage 只能仿射），所以这层走 WebGL。
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { RIGS, resolveRef, refJoints, type Rig, type RigName, type V2 } from './rig'
import { Cloth, type ClothParams, type ClothPull } from './cloth'

/** 平铺图上的「静止姿势骨架」，关节名对应 rig.landmarks，值归一化到图片 0–1 */
export type RestSkeleton = Record<string, V2>

/** 左右两侧各一条折线，点归一化到图片 0–1 */
export interface SidePaths {
  r: V2[]
  l: V2[]
}

export interface MeshGarmentConfig {
  id: string
  src: string
  rig: RigName
  rest: RestSkeleton
  /** 网格密度，越大越细也越慢 */
  grid: number
  /** 主干骨权重加成，防止身体被四肢拽走 */
  torsoBias: number
  /** 权重衰减指数，越大四肢影响范围越窄 */
  falloff: number
  widthEase: number
  lengthEase: number
  /**
   * 沿躯干轴整体位移，单位是主干骨长度的倍数。正数往下。
   *
   * 关节点要放在解剖学正确的位置（肩点 = 真实肩缝），否则手臂骨起点跑偏，
   * 袖子会把肩部撕开。领口/腰头高低改用这个参数单独控制。
   */
  offsetY?: number

  /**
   * 袖窿分割线（只有上衣用）。
   *
   * 权重本来是「到骨头的距离取倒数」，纯几何，不认衣服结构 —— 侧腰离垂下来的
   * 小臂骨很近，于是有一半归手臂管，一抬手半个腰跟着走。这条线是一道影响力
   * 屏障：顶点连到骨头的那条线如果穿过它，距离就乘 seamPenalty，影响力只能
   * 绕过去。不归零，所以袖子和身体仍是一张连续的网，腋下不会裂开。
   */
  seam?: SidePaths
  /** 穿过分割线时距离乘多少。1 = 不切，越大越接近彻底切断 */
  seamPenalty?: number

  /**
   * 图钉（只有上衣用）。半径内强行把权重拉回主干骨，下摆角就不会被袖子拽变形。
   * 和 PS 的钉子不一样：这里不是「不动」，是「焊在躯干上」。
   */
  pins?: SidePaths
  /** 图钉作用半径，归一化到图宽 */
  pinRadius?: number

  /**
   * 刚性模式：整块布只套主干骨（肩+髋）算出的相似变换（旋转+等比缩放+位移），
   * 不再按四肢骨头加权蒙皮，缩放也不再横向/纵向分开算 —— 统一按当前肩宽相对
   * 静止肩宽的比例整体放大缩小。跟着人的位置挪、跟着躯干转、跟着肩宽变化整体
   * 缩放，但四条边的比例永远和调参台里调的一致，不会被压扁或拉长。
   * 开了这个，seam/pins 这些形变相关的手柄不再起作用。
   */
  rigid?: boolean
}

/* ── 骨头 ───────────────────────────────────────────────────── */
interface Bone {
  a: V2 // 静止姿势起点（图片像素）
  b: V2 // 静止姿势终点
  /** 当前帧的仿射变换 p' = M·(p − a) + t。主干骨可以非等比，四肢保持等比 */
  m: { a: number; b: number; c: number; d: number; tx: number; ty: number }
  ok: boolean
}

/** 点到线段的最近点，顺带给出距离 —— 屏障判定要用这条连线 */
const closestOnSeg = (p: V2, a: V2, b: V2): { d: number; q: V2 } => {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  if (len2 < 1e-6) return { d: Math.hypot(p.x - a.x, p.y - a.y), q: a }
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
  t = Math.max(0, Math.min(1, t))
  const q = { x: a.x + t * vx, y: a.y + t * vy }
  return { d: Math.hypot(p.x - q.x, p.y - q.y), q }
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx

/** 两条线段是否相交。只要判交不判交点，用朝向测试就够 */
const segHit = (p1: V2, p2: V2, p3: V2, p4: V2): boolean => {
  const d1 = cross(p4.x - p3.x, p4.y - p3.y, p1.x - p3.x, p1.y - p3.y)
  const d2 = cross(p4.x - p3.x, p4.y - p3.y, p2.x - p3.x, p2.y - p3.y)
  const d3 = cross(p2.x - p1.x, p2.y - p1.y, p3.x - p1.x, p3.y - p1.y)
  const d4 = cross(p2.x - p1.x, p2.y - p1.y, p4.x - p1.x, p4.y - p1.y)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

const smoothstep = (t: number) => t * t * (3 - 2 * t)

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/* ── One Euro（和方案 B 同一套，用来平滑骨骼点） ─────────────── */
class OneEuro {
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev = 0
  constructor(private minCutoff = 1.4, private beta = 0.03, private dCutoff = 1) {}
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }
  filter(x: number, t: number): number {
    if (this.xPrev === null) {
      this.xPrev = x
      this.tPrev = t
      return x
    }
    const dt = Math.max(1e-3, t - this.tPrev)
    this.tPrev = t
    const dx = (x - this.xPrev) / dt
    const aD = OneEuro.alpha(this.dCutoff, dt)
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev)
    const a = OneEuro.alpha(cutoff, dt)
    this.xPrev = a * x + (1 - a) * this.xPrev
    return this.xPrev
  }
  reset() {
    this.xPrev = null
    this.dxPrev = 0
  }
}

/* ── WebGL 渲染器 ───────────────────────────────────────────── */
const VS = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec2 uRes;
varying vec2 vUV;
void main() {
  vec2 z = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(z.x, -z.y, 0.0, 1.0);
  vUV = aUV;
}`

const FS = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUV;
void main() {
  gl_FragColor = texture2D(uTex, vUV) * uAlpha;
}`

class MeshRenderer {
  private gl: WebGLRenderingContext
  private prog: WebGLProgram
  private posBuf: WebGLBuffer
  private uvBuf: WebGLBuffer
  private idxBuf: WebGLBuffer
  private tex: WebGLTexture | null = null
  private loc: { pos: number; uv: number; res: WebGLUniformLocation; alpha: WebGLUniformLocation }

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: true })
    if (!gl) throw new Error('WebGL not available')
    this.gl = gl

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed')
      }
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed')
    }
    this.prog = p
    this.loc = {
      pos: gl.getAttribLocation(p, 'aPos'),
      uv: gl.getAttribLocation(p, 'aUV'),
      res: gl.getUniformLocation(p, 'uRes')!,
      alpha: gl.getUniformLocation(p, 'uAlpha')!,
    }
    this.posBuf = gl.createBuffer()!
    this.uvBuf = gl.createBuffer()!
    this.idxBuf = gl.createBuffer()!

    // 预乘 alpha + (ONE, 1-SRC_ALPHA)，避免透明 PNG 边缘出黑边
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  setTexture(img: HTMLImageElement) {
    const gl = this.gl
    // 换装会反复建新的 MeshGarment，旧贴图不删的话一张 800×800 就是 2.5MB，攒着不放
    if (this.tex) gl.deleteTexture(this.tex)
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    this.tex = t
  }

  setIndices(idx: Uint16Array) {
    const gl = this.gl
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
  }

  setUVs(uv: Float32Array) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
  }

  resize(w: number, h: number, dpr: number) {
    const pw = Math.max(1, Math.round(w * dpr))
    const ph = Math.max(1, Math.round(h * dpr))
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
    }
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.gl.viewport(0, 0, pw, ph)
  }

  clear() {
    const gl = this.gl
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  draw(positions: Float32Array, count: number, w: number, h: number, alpha: number) {
    const gl = this.gl
    if (!this.tex) return
    gl.useProgram(this.prog)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(this.loc.pos)
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf)
    gl.enableVertexAttribArray(this.loc.uv)
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.uniform2f(this.loc.res, w, h)
    gl.uniform1f(this.loc.alpha, alpha)

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf)
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0)
  }

  /** 同一个 canvas 上换衣服时，旧的这套 GL 资源得自己还回去 */
  dispose() {
    const gl = this.gl
    if (this.tex) gl.deleteTexture(this.tex)
    gl.deleteBuffer(this.posBuf)
    gl.deleteBuffer(this.uvBuf)
    gl.deleteBuffer(this.idxBuf)
    gl.deleteProgram(this.prog)
    this.tex = null
  }
}

/* ── 网格衣服 ───────────────────────────────────────────────── */
export class MeshGarment {
  readonly cfg: MeshGarmentConfig
  private img: HTMLImageElement | null = null
  private gl: MeshRenderer | null = null

  private restPos!: Float32Array // 静止顶点（图片像素）
  private weights!: Float32Array // 每顶点 5 个权重
  /** 每顶点被图钉钉住的程度 0–1。1 = 完全刚性，不吃任何拉伸 */
  private pinW: Float32Array | null = null
  /** 64×64 的 alpha 采样，建网格时顺手留下的。edgeU() 靠它找衣服的轮廓边 */
  private alphaMap: Uint8Array | null = null
  private outPos!: Float32Array
  private idxCount = 0

  /** 主干骨的刚性版本：同样的旋转和位移，但缩放是等比的 */
  private rootRigid = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

  /** 脱下来之后接管形变的布料。非空 = 已经不跟骨头走了 */
  private cloth: Cloth | null = null

  private bones: Bone[] = []
  private smooth = new Map<number, { x: OneEuro; y: OneEuro }>()
  private alpha = 0
  ready = false

  private rig: Rig

  constructor(cfg: MeshGarmentConfig, canvas: HTMLCanvasElement) {
    this.cfg = cfg
    this.rig = RIGS[cfg.rig]
    this.gl = new MeshRenderer(canvas)
  }

  async load(): Promise<void> {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error(`mesh garment load failed: ${this.cfg.src}`))
      img.src = this.cfg.src
    })
    this.img = img
    this.gl!.setTexture(img)
    this.buildMesh()
    this.ready = true
  }

  /** 只重建网格和权重，不重新下载图片 —— 拖骨骼点时每帧都要调 */
  rebuild() {
    if (!this.img) return
    this.buildMesh()
    this.reset()
  }

  /** 建网格 + 预计算权重。只在加载时跑一次 */
  private buildMesh() {
    const { grid, rest, falloff, torsoBias } = this.cfg
    const rig = this.rig
    const iw = this.img!.width
    const ih = this.img!.height

    // 静止骨架解析到图片像素
    const getRest = (k: string): V2 => {
      const v = rest[k]
      if (!v) throw new Error(`rest skeleton missing joint "${k}" for ${this.cfg.id}`)
      return { x: v.x * iw, y: v.y * ih }
    }
    this.bones = rig.bones.map(([a, b]) => ({
      a: resolveRef(a, getRest),
      b: resolveRef(b, getRest),
      m: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      ok: true,
    }))

    // 顶点
    const n = grid + 1
    const vCount = n * n
    this.restPos = new Float32Array(vCount * 2)
    this.outPos = new Float32Array(vCount * 2)
    const uv = new Float32Array(vCount * 2)
    this.weights = new Float32Array(vCount * this.bones.length)

    // 分割线先拍平成像素坐标的线段表，每个顶点都要拿它判一遍
    const penalty = Math.max(1, this.cfg.seamPenalty ?? 1)
    const seams: Array<[V2, V2]> = []
    if (this.cfg.seam && penalty > 1) {
      for (const side of [this.cfg.seam.r, this.cfg.seam.l]) {
        for (let i = 0; i + 1 < side.length; i++) {
          seams.push([
            { x: side[i].x * iw, y: side[i].y * ih },
            { x: side[i + 1].x * iw, y: side[i + 1].y * ih },
          ])
        }
      }
    }

    const pinR = (this.cfg.pinRadius ?? 0) * iw
    const pins: V2[] = []
    if (this.cfg.pins && pinR > 0) {
      for (const side of [this.cfg.pins.r, this.cfg.pins.l]) {
        for (const p of side) pins.push({ x: p.x * iw, y: p.y * ih })
      }
    }

    const nb = this.bones.length
    const ws = new Float64Array(nb)
    // 没钉子的衣服不分配这块内存，热循环里也就不用判
    let pinField: Float32Array | null = null

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        const u = i / grid
        const v = j / grid
        const x = u * iw
        const y = v * ih
        this.restPos[k * 2] = x
        this.restPos[k * 2 + 1] = y
        uv[k * 2] = u
        uv[k * 2 + 1] = v

        // 权重：到骨头距离的反比，falloff 次方
        const p = { x, y }
        let sum = 0
        for (let b = 0; b < nb; b++) {
          const { d, q } = closestOnSeg(p, this.bones[b].a, this.bones[b].b)
          let dist = d / iw
          // 顶点够不着这根骨头（中间隔着分割线），影响力得绕路 —— 体现为距离变远
          if (seams.length && seams.some(([s0, s1]) => segHit(p, q, s0, s1))) dist *= penalty
          let w = 1 / (Math.pow(dist, falloff) + 1e-4)
          if (b === 0) w *= torsoBias
          ws[b] = w
          sum += w
        }
        for (let b = 0; b < nb; b++) ws[b] /= sum

        // 图钉：半径内把权重整体拉向「100% 主干骨」，中心最狠，边缘平滑接回去。
        // 光这样只解决了「不被袖子拽走」，还没解决「不变形」—— 后半截在 fit() 里，
        // 靠 pinW 把这块布切到刚性变换上。
        if (pins.length) {
          let t = 0
          for (const pin of pins) {
            const d = Math.hypot(x - pin.x, y - pin.y)
            if (d < pinR) t = Math.max(t, smoothstep(1 - d / pinR))
          }
          if (t > 0) {
            pinField ??= new Float32Array(vCount)
            pinField[k] = t
            for (let b = 0; b < nb; b++) {
              const target = b === 0 ? 1 : 0
              ws[b] += (target - ws[b]) * t
            }
          }
        }

        for (let b = 0; b < nb; b++) this.weights[k * nb + b] = ws[b]
      }
    }


    this.pinW = pinField

    // 三角形索引，跳过完全透明的格子
    const alphaMap = this.sampleAlpha(64)
    this.alphaMap = alphaMap
    const idx: number[] = []
    const solid = (i: number, j: number) => {
      const u = Math.min(63, Math.floor((i / grid) * 64))
      const v = Math.min(63, Math.floor((j / grid) * 64))
      return alphaMap[v * 64 + u] > 4
    }
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        if (!solid(i, j) && !solid(i + 1, j) && !solid(i, j + 1) && !solid(i + 1, j + 1)) continue
        const a = j * n + i
        const b = a + 1
        const c = a + n
        const d = c + 1
        idx.push(a, b, c, b, d, c)
      }
    }
    this.idxCount = idx.length
    this.gl!.setUVs(uv)
    this.gl!.setIndices(new Uint16Array(idx))
  }

  /** 低分辨率采一遍 alpha，用来裁掉完全透明的格子 */
  private sampleAlpha(size: number): Uint8Array {
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(this.img!, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    const out = new Uint8Array(size * size)
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]
    return out
  }

  private sm(i: number, v: V2, t: number): V2 {
    let f = this.smooth.get(i)
    if (!f) {
      f = { x: new OneEuro(), y: new OneEuro() }
      this.smooth.set(i, f)
    }
    return { x: f.x.filter(v.x, t), y: f.y.filter(v.y, t) }
  }

  reset() {
    this.smooth.clear()
    this.alpha = 0
  }

  /**
   * 算骨头变换 + 蒙皮。返回 false 表示这一帧不该画。
   */
  fit(lms: NormalizedLandmark[], w: number, h: number, minVis: number, t: number): boolean {
    if (!this.img || !this.gl) return false
    const rig = this.rig
    const rigid = this.cfg.rigid ?? false

    const idxOf = (k: string) => rig.landmarks[k]
    const visible = (k: string) => {
      const lm = lms[idxOf(k)]
      return !!lm && (lm.visibility ?? 0) >= minVis
    }
    const cur = (k: string): V2 => {
      const i = idxOf(k)
      return this.sm(i, { x: lms[i].x * w, y: lms[i].y * h }, t)
    }

    for (const k of rig.required) {
      if (!visible(k)) return this.fade()
    }

    // 朝向判定：宽度 / 长度 的比值，侧过去会塌
    const fw = resolveRef(rig.facingWidth[0], cur)
    const fw2 = resolveRef(rig.facingWidth[1], cur)
    const fl = resolveRef(rig.facingLength[0], cur)
    const fl2 = resolveRef(rig.facingLength[1], cur)
    const wLen = Math.hypot(fw2.x - fw.x, fw2.y - fw.y)
    const lLen = Math.hypot(fl2.x - fl.x, fl2.y - fl.y)
    if (wLen < 1 || lLen < 1) return this.fade()
    const [lo, hi] = rig.facingRange
    const facing = clamp((wLen / lLen - lo) / (hi - lo), 0, 1)
    if (facing <= 0) return this.fade()

    // 主干骨缩放，四肢缺失时的兜底基准
    const root = this.bones[0]
    const rootRestLen = Math.hypot(root.b.x - root.a.x, root.b.y - root.a.y)
    const rootScale = lLen / rootRestLen

    const setBone = (bi: number, a1: V2, b1: V2, ok: boolean) => {
      const bone = this.bones[bi]
      bone.ok = ok
      const rx = bone.b.x - bone.a.x
      const ry = bone.b.y - bone.a.y
      const cx = b1.x - a1.x
      const cy = b1.y - a1.y
      const rl = Math.hypot(rx, ry)
      const cl = Math.hypot(cx, cy)
      if (rl < 1e-4 || cl < 1e-4) return
      // 四肢缩放钳制在主干缩放附近，避免透视缩短时被压扁
      const s = clamp(cl / rl, rootScale * 0.55, rootScale * 1.45)
      const ang = Math.atan2(cy, cx) - Math.atan2(ry, rx)
      const co = Math.cos(ang) * s
      const si = Math.sin(ang) * s
      bone.m = { a: co, b: si, c: -si, d: co, tx: a1.x, ty: a1.y }
    }

    // 主干：横向按宽度对、纵向按长度对，分别缩放。
    // 等比缩放会让「主干算出的肩宽」和「手臂骨起点」对不上，肩部被撕开。
    {
      const bone = this.bones[0]
      const rDir = { x: bone.b.x - bone.a.x, y: bone.b.y - bone.a.y }
      const rLen = Math.hypot(rDir.x, rDir.y) || 1
      const ru = { x: rDir.x / rLen, y: rDir.y / rLen }
      const rn = { x: -ru.y, y: ru.x }
      const getRestJ = (k: string): V2 => {
        const v = this.cfg.rest[k]
        return { x: v.x * this.img!.width, y: v.y * this.img!.height }
      }
      const rw0 = resolveRef(rig.facingWidth[0], getRestJ)
      const rw1 = resolveRef(rig.facingWidth[1], getRestJ)
      const restW = Math.abs((rw1.x - rw0.x) * rn.x + (rw1.y - rw0.y) * rn.y) || 1

      const cu = { x: (fl2.x - fl.x) / lLen, y: (fl2.y - fl.y) / lLen }
      const cn = { x: -cu.y, y: cu.x }
      const curW = Math.abs((fw2.x - fw.x) * cn.x + (fw2.y - fw.y) * cn.y) || 1

      const sy = lLen / rLen
      const sx = clamp(curW / restW, sy * 0.6, sy * 1.6)
      const ang = Math.atan2(cu.y, cu.x) - Math.atan2(ru.y, ru.x)
      const co = Math.cos(ang)
      const si = Math.sin(ang)
      // M = R(ang) · diag(sx, sy)，横向 sx、纵向 sy
      bone.m = { a: co * sx, b: si * sx, c: -si * sy, d: co * sy, tx: fl.x, ty: fl.y }
      bone.ok = true

      // 同一个旋转和位移，但缩放等比 —— 图钉钉住的那块布用这个，
      // 人一侧身 sx/sy 分家时，钉住处才不会跟着横向拉扁
      this.rootRigid = { a: co * sy, b: si * sy, c: -si * sy, d: co * sy, tx: fl.x, ty: fl.y }

      // 刚性模式：横向和纵向用同一个缩放（按肩宽算），不再分开算 sx/sy ——
      // 独立缩放才是「扭曲/被压扁」的根源，等比缩放不管怎么转身都不会拉伸变形，
      // 跟着位置挪、跟着躯干转、跟着肩宽整体放大缩小，但四条边的比例永远不变。
      if (rigid) {
        const su = curW / restW
        const rco = co * su
        const rsi = si * su
        bone.m = { a: rco, b: rsi, c: -rsi, d: rco, tx: fl.x, ty: fl.y }
        this.rootRigid = bone.m
      }
    }

    // 四肢：任一端不可见就退回主干变换，衣服刚性跟着主干走
    const rootM = this.bones[0].m
    const applyRoot = (bi: number) => {
      const bone = this.bones[bi]
      const map = (p: V2): V2 => ({
        x: rootM.tx + rootM.a * (p.x - root.a.x) + rootM.c * (p.y - root.a.y),
        y: rootM.ty + rootM.b * (p.x - root.a.x) + rootM.d * (p.y - root.a.y),
      })
      setBone(bi, map(bone.a), map(bone.b), false)
    }

    for (let bi = 1; bi < rig.bones.length; bi++) {
      const [ra, rb] = rig.bones[bi]
      const joints = [...refJoints(ra), ...refJoints(rb)]
      if (joints.every(visible)) {
        setBone(bi, resolveRef(ra, cur), resolveRef(rb, cur), true)
      } else {
        applyRoot(bi)
      }
    }

    // 蒙皮 + 宽松度。
    // 宽松度按「主干权重」加权 —— 身体吃满缩放，四肢几乎不动。
    // 整体缩放会把袖子/裤腿拽进躯干区域，重叠处半透明叠加会出暗带。
    const { widthEase, lengthEase } = this.cfg
    const hasEase = widthEase !== 1 || lengthEase !== 1
    const ux = (fl2.x - fl.x) / lLen
    const uy = (fl2.y - fl.y) / lLen
    const nx = -uy
    const ny = ux

    const nb = this.bones.length
    const rp = this.restPos
    const op = this.outPos
    const wt = this.weights
    const B = this.bones
    const pw = this.pinW
    const R = this.rootRigid
    const rootA = this.bones[0].a
    const rootBoneM = B[0].m
    for (let k = 0, kw = 0, vi = 0; k < rp.length; k += 2, kw += nb, vi++) {
      const x = rp[k]
      const y = rp[k + 1]
      let ox = 0
      let oy = 0

      if (rigid) {
        // 刚性模式：不管四肢骨头，整块布只吃主干骨的变换，形状不变只随人挪、转、缩
        const dx = x - rootA.x
        const dy = y - rootA.y
        ox = rootBoneM.tx + rootBoneM.a * dx + rootBoneM.c * dy
        oy = rootBoneM.ty + rootBoneM.b * dx + rootBoneM.d * dy
      } else {
        for (let b = 0; b < nb; b++) {
          const wgt = wt[kw + b]
          if (wgt < 1e-4) continue
          const m = B[b].m
          const dx = x - B[b].a.x
          const dy = y - B[b].a.y
          ox += wgt * (m.tx + m.a * dx + m.c * dy)
          oy += wgt * (m.ty + m.b * dx + m.d * dy)
        }
      }

      const pt = rigid ? 0 : pw ? pw[vi] : 0

      if (hasEase) {
        // 钉住的地方不吃宽松度 —— 钉子的意思就是这块布保持原样
        // 刚性模式下整块布本来就是同一个变换，宽松度对每个点都全额生效
        const tw = rigid ? 1 : wt[kw] * (1 - pt)
        const we = 1 + (widthEase - 1) * tw
        const le = 1 + (lengthEase - 1) * tw
        const vx = ox - fl.x
        const vy = oy - fl.y
        const along = (vx * ux + vy * uy) * le
        const side = (vx * nx + vy * ny) * we
        ox = fl.x + along * ux + side * nx
        oy = fl.y + along * uy + side * ny
      }

      // 图钉：往刚性变换上靠。中心完全刚性，到半径边缘平滑接回蒙皮结果
      if (pt > 0) {
        const dx = x - rootA.x
        const dy = y - rootA.y
        ox += (R.tx + R.a * dx + R.c * dy - ox) * pt
        oy += (R.ty + R.b * dx + R.d * dy - oy) * pt
      }

      op[k] = ox
      op[k + 1] = oy
    }

    // 整体沿躯干轴平移。纯位移，不会撕开网格
    const off = (this.cfg.offsetY ?? 0) * lLen
    if (off !== 0) {
      for (let k = 0; k < op.length; k += 2) {
        op[k] += ux * off
        op[k + 1] += uy * off
      }
    }

    this.alpha = Math.min(1, this.alpha + 0.12) * facing
    return true
  }

  /* ── 脱下来：从蒙皮交给布料物理 ───────────────────────────── */

  /**
   * 静止骨架不再起作用，这块布开始有自己的重量。
   *
   * 关键是**拿当前帧的顶点位置初始化**，不是拿平铺图的静止位置 —— 布料的静止边长
   * 按接管那一刻的形状来量，所以衣服不会先弹回平铺状再垂下来，是从身上那个姿态
   * 直接接手的。
   */
  release(
    opts: {
      scatter?: [number, number, number]
      /** 整块布的起手速度，做「被甩起来」那一下。负 y 是往上 */
      launch?: [number, number]
      params?: Partial<ClothParams>
    } = {},
  ) {
    if (!this.img || this.cloth) return
    const n = this.cfg.grid + 1
    const count = n * n
    const xs = new Float32Array(count)
    const ys = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      xs[i] = this.outPos[i * 2]
      ys[i] = this.outPos[i * 2 + 1]
    }
    this.cloth = new Cloth(n, n, opts.params)
    this.cloth.reset(xs, ys)
    // 撒一点随机位移，甩起来才会不规则地堆叠
    if (opts.scatter) this.cloth.scatter(opts.scatter[0], opts.scatter[1], opts.scatter[2])
    if (opts.launch) this.cloth.launch(opts.launch[0], opts.launch[1])
    this.alpha = 1
  }

  get released(): boolean {
    return !!this.cloth
  }

  /**
   * 顶边中间那几针 —— 上衣是领口、下装是腰头，都是真拎起来会抓的地方。
   * 只拽这几针，整块布靠约束跟过去，形状才保得住。
   */
  grabPoints(span = 0.34): Int32Array {
    const n = this.cfg.grid + 1
    const half = Math.max(1, Math.round((n * span) / 2))
    const mid = n >> 1
    const out: number[] = []
    for (let i = mid - half; i <= mid + half; i++) {
      if (i >= 0 && i < n) out.push(i) // 第 0 行
    }
    return new Int32Array(out)
  }

  /** 平铺图的像素宽。贴上去的东西按它换算尺寸 */
  get restWidth(): number {
    return this.img?.width ?? 0
  }

  /* ── 往布上贴东西 ───────────────────────────────────────────
   * 贴纸、胶带这类要「长在衣服上」的装饰，位置得用平铺图的坐标来描述，
   * 再由这里翻译成此刻屏幕上的位置 —— 衣服怎么动，贴上去的东西就怎么跟着动。
   */

  /**
   * 第 v 行（0–1，平铺图的高度比例）上，衣服轮廓的左边缘或右边缘在哪（返回 u，0–1）。
   * 整行都是透明就返回 null（比如裤子分叉以下的那道缝）。
   */
  edgeU(v: number, side: 'l' | 'r'): number | null {
    const m = this.alphaMap
    if (!m) return null
    const row = Math.max(0, Math.min(63, Math.floor(v * 64)))
    const base = row * 64
    if (side === 'r') {
      for (let i = 63; i >= 0; i--) if (m[base + i] > 4) return (i + 0.5) / 64
    } else {
      for (let i = 0; i < 64; i++) if (m[base + i] > 4) return (i + 0.5) / 64
    }
    return null
  }

  /**
   * 平铺图上的一点（u、v 都是 0–1），此刻被形变到舞台的哪个位置。
   *
   * 顺带给出这块布在那儿的朝向和拉伸倍数 —— 贴上去的东西跟着转、跟着缩放，
   * 才像是粘在布面上，而不是浮在衣服前面的一张贴图。
   */
  sample(u: number, v: number): { x: number; y: number; angle: number; scale: number } | null {
    if (!this.ready || !this.img) return null
    const g = this.cfg.grid
    const n = g + 1
    const fu = Math.max(0, Math.min(g - 1e-4, u * g))
    const fv = Math.max(0, Math.min(g - 1e-4, v * g))
    const i = Math.floor(fu)
    const j = Math.floor(fv)
    const tu = fu - i
    const tv = fv - j
    const op = this.outPos
    const px = (ii: number, jj: number) => op[(jj * n + ii) * 2]
    const py = (ii: number, jj: number) => op[(jj * n + ii) * 2 + 1]
    const mix = (a: number, b: number, t: number) => a + (b - a) * t

    // 这一格四个角先按 u 插值出上下两点，再按 v 插值出落点
    const topX = mix(px(i, j), px(i + 1, j), tu)
    const topY = mix(py(i, j), py(i + 1, j), tu)
    const botX = mix(px(i, j + 1), px(i + 1, j + 1), tu)
    const botY = mix(py(i, j + 1), py(i + 1, j + 1), tu)

    // u 方向的切线就是这块布此刻的「横向」，长度除以静止格宽即为拉伸倍数
    const tanX = mix(px(i + 1, j) - px(i, j), px(i + 1, j + 1) - px(i, j + 1), tv)
    const tanY = mix(py(i + 1, j) - py(i, j), py(i + 1, j + 1) - py(i, j + 1), tv)
    const rest = this.img.width / g
    return {
      x: mix(topX, botX, tv),
      y: mix(topY, botY, tv),
      angle: Math.atan2(tanY, tanX),
      scale: Math.hypot(tanX, tanY) / rest,
    }
  }

  /** 顶边左右各一针，用来像拎衣服一样把布挂向肩膀或髋部。 */
  grabCorners(inset = 0.18): [Int32Array, Int32Array] {
    const n = this.cfg.grid + 1
    const left = Math.max(0, Math.min(n - 1, Math.round((n - 1) * inset)))
    const right = Math.max(0, Math.min(n - 1, Math.round((n - 1) * (1 - inset))))
    return [new Int32Array([left]), new Int32Array([right])]
  }

  /**
   * 以一块布的形态出现在某个矩形里（还没穿上）。平铺图的网格等比铺进这个矩形，
   * 所以它一开始就是「那张卡片放大版」的样子，和卡片接得上。
   */
  appear(
    rect: { x: number; y: number; w: number; h: number },
    opts: { launch?: [number, number]; params?: Partial<ClothParams> } = {},
  ) {
    if (!this.img) return
    const n = this.cfg.grid + 1
    const count = n * n
    const iw = this.img.width
    const ih = this.img.height
    const xs = new Float32Array(count)
    const ys = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      xs[i] = rect.x + (this.restPos[i * 2] / iw - 0.5) * rect.w
      ys[i] = rect.y + (this.restPos[i * 2 + 1] / ih - 0.5) * rect.h
      this.outPos[i * 2] = xs[i]
      this.outPos[i * 2 + 1] = ys[i]
    }
    this.cloth = new Cloth(n, n, opts.params)
    this.cloth.reset(xs, ys)
    if (opts.launch) this.cloth.launch(opts.launch[0], opts.launch[1])
    this.alpha = 1
  }

  /** 布整体「长大」：静止边长乘系数，顶点被约束慢慢撑开 */
  growCloth(f: number) {
    this.cloth?.scaleRest(f)
  }

  /** 只推进布，不写 outPos —— 飘回身上时 outPos 要留给蒙皮 */
  clothStep(pull?: ClothPull | ClothPull[], lift = 0) {
    this.cloth?.step(pull, lift)
  }

  /**
   * 把布的位置按 (1 − k) 混进 outPos。k = 0 全是布，k = 1 全是蒙皮。
   *
   * 这一步就是「固定住骨骼点」：蒙皮已经把每个顶点该在身上哪儿算好了，
   * 这里只是让布在几百毫秒里慢慢挪过去，而不是啪一下跳过去。
   */
  blendCloth(k: number) {
    if (!this.cloth) return
    const c = this.cloth
    const inv = 1 - k
    for (let i = 0; i < c.count; i++) {
      this.outPos[i * 2] = c.x[i] * inv + this.outPos[i * 2] * k
      this.outPos[i * 2 + 1] = c.y[i] * inv + this.outPos[i * 2 + 1] * k
    }
  }

  /** 贴合完成，布可以扔了 —— 之后纯走蒙皮 */
  dropCloth() {
    this.cloth = null
  }

  /**
   * 布料模式下每帧推一步。
   * @param pull 把整块布往这个点吸（做「被吸进废纸篓」）
   * @param fade 每帧透明度衰减，落地时淡出用
   */
  simulate(
    pull?: ClothPull | ClothPull[],
    fade = 0,
    lift = 0,
  ): boolean {
    if (!this.cloth) return false
    this.cloth.step(pull, lift)
    // 纯布料模式：布的位置就是最终位置
    this.blendCloth(0)
    if (fade) this.alpha = Math.max(0, this.alpha - fade)
    return this.alpha > 0.001
  }

  /** 丢失或侧身：不硬贴，淡出 */
  private fade(): boolean {
    this.alpha = Math.max(0, this.alpha - 0.15)
    return this.alpha > 0.001
  }

  /** 把衣服自己的骨架画在人身上：实心点 = 衣服的骨骼点，线 = 五根骨头 */
  drawRig(ctx: CanvasRenderingContext2D, color = '#00e5ff') {
    if (!this.img || this.alpha <= 0.001) return
    const B = this.bones
    const map = (b: Bone, p: V2): V2 => ({
      x: b.m.tx + b.m.a * (p.x - b.a.x) + b.m.c * (p.y - b.a.y),
      y: b.m.ty + b.m.b * (p.x - b.a.x) + b.m.d * (p.y - b.a.y),
    })

    ctx.save()
    ctx.globalAlpha = this.alpha
    ctx.lineCap = 'round'
    for (let i = 0; i < B.length; i++) {
      const a = map(B[i], B[i].a)
      const b = map(B[i], B[i].b)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineWidth = i === 0 ? 3 : 2
      // 关节不可见、退回主干变换的骨头用虚线标出来
      ctx.setLineDash(B[i].ok ? [] : [5, 4])
      ctx.strokeStyle = color
      ctx.stroke()
      for (const p of [a, b]) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, i === 0 ? 5 : 4, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      }
    }
    ctx.restore()
  }

  /** 角落里放一张平铺图，把静止骨架标在上面 —— 调锚点时对照用 */
  drawRestInspector(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color = '#00e5ff') {
    if (!this.img) return
    const iw = this.img.width
    const ih = this.img.height
    const k = size / Math.max(iw, ih)
    const w = iw * k
    const h = ih * k

    ctx.save()
    ctx.globalAlpha = 0.95
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8)
    ctx.drawImage(this.img, x, y, w, h)

    const rest = this.cfg.rest
    ctx.lineWidth = 1.5
    ctx.strokeStyle = color
    for (const [a, b] of this.rig.bones) {
      const pa = resolveRef(a, (j) => rest[j])
      const pb = resolveRef(b, (j) => rest[j])
      ctx.beginPath()
      ctx.moveTo(x + pa.x * w, y + pa.y * h)
      ctx.lineTo(x + pb.x * w, y + pb.y * h)
      ctx.stroke()
    }
    ctx.font = '600 9px ui-monospace, monospace'
    ctx.textBaseline = 'middle'
    for (const [name, p] of Object.entries(rest)) {
      const px = x + p.x * w
      const py = y + p.y * h
      ctx.beginPath()
      ctx.arc(px, py, 3, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      if (name.startsWith('r')) {
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'right'
        ctx.fillText(`${name.slice(1)} ${p.y.toFixed(2)}`, px - 6, py)
      }
    }
    ctx.restore()
  }

  render(w: number, h: number, dpr: number) {
    if (!this.gl) return
    this.gl.resize(w, h, dpr)
    this.gl.clear()
    if (this.alpha > 0.001) this.gl.draw(this.outPos, this.idxCount, w, h, this.alpha)
  }

  clear(w: number, h: number, dpr: number) {
    if (!this.gl) return
    this.gl.resize(w, h, dpr)
    this.gl.clear()
  }

  dispose() {
    this.gl?.dispose()
    this.gl = null
    this.img = null
    this.ready = false
  }
}
