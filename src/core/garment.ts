/**
 * 方案 B：肩 + 髋双轴锚定。
 *
 * 肩宽定横向缩放，肩到髋定纵向缩放，肩线定角度。纵向缩放相对横向做钳制，
 * 避免人侧身时肩宽塌掉、衣服被拉成竖条。
 *
 * 坐标全部用 MediaPipe 的 0–1 归一化值乘舞台宽高 —— 因为舞台走的是
 * Fit Best（不裁切），归一化坐标乘舞台尺寸就是屏幕坐标，没有裁切偏移。
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

/** 上衣只用这四个点 */
const R_SHOULDER = 12 // 人物右肩，正面朝镜头时出现在画面左侧
const L_SHOULDER = 11
const R_HIP = 24
const L_HIP = 23

export interface GarmentConfig {
  id: string
  src: string
  /** 以下三点归一化到衣服图片自身 0–1 */
  anchorL: { x: number; y: number } // 图片左侧肩点
  anchorR: { x: number; y: number } // 图片右侧肩点
  hem: { x: number; y: number } // 下摆中点
  /** 宽度余量：衣服总比肩宽大一圈 */
  widthEase: number
  /** 长度余量 */
  lengthEase: number
  /**
   * 角度取自哪条轴。0 = 完全跟肩线，1 = 完全跟躯干轴（肩中点→髋中点）。
   * 只跟肩线，人一扭身下摆就甩出去；只跟躯干轴，耸肩时领口会歪。
   * 默认偏向躯干轴。
   */
  torsoBias: number
}

export interface FitResult {
  cx: number
  cy: number
  angle: number
  sx: number
  sy: number
  /** 侧身程度，0 = 完全侧过去，1 = 正对镜头 */
  facing: number
  alpha: number
}

/* ── One Euro 滤波 ─────────────────────────────────────────────
   骨骼点有 ±2–3px 抖动。平滑加在最终的几个量上（中心、角度、缩放），
   比平滑 33 个点稳得多，也不会互相打架。
   ──────────────────────────────────────────────────────────── */
class OneEuro {
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev = 0

  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1,
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(x: number, tSec: number): number {
    if (this.xPrev === null) {
      this.xPrev = x
      this.tPrev = tSec
      return x
    }
    const dt = Math.max(1e-3, tSec - this.tPrev)
    this.tPrev = tSec

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

/* ── 贴合器 ─────────────────────────────────────────────────── */

export class Garment {
  readonly cfg: GarmentConfig
  private img: HTMLImageElement | null = null
  ready = false

  private fCx = new OneEuro()
  private fCy = new OneEuro()
  private fAngle = new OneEuro(1.5, 0.01)
  private fSx = new OneEuro(0.8, 0.005)
  private fSy = new OneEuro(0.8, 0.005)
  private alpha = 0

  /** 最近一次成功的贴合，侧身时冻结在这里 */
  private last: FitResult | null = null

  constructor(cfg: GarmentConfig) {
    this.cfg = cfg
  }

  async load(): Promise<void> {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`garment load failed: ${this.cfg.src}`))
      img.src = this.cfg.src
    })
    this.img = img
    this.ready = true
  }

  reset() {
    for (const f of [this.fCx, this.fCy, this.fAngle, this.fSx, this.fSy]) f.reset()
    this.alpha = 0
    this.last = null
  }

  /**
   * @param lms  归一化骨骼点
   * @param w/h  舞台像素尺寸
   * @param minVis 可见度阈值
   */
  fit(lms: NormalizedLandmark[], w: number, h: number, minVis: number, tSec: number): FitResult | null {
    if (!this.img) return null

    const need = [R_SHOULDER, L_SHOULDER, R_HIP, L_HIP]
    for (const i of need) {
      const lm = lms[i]
      if (!lm || (lm.visibility ?? 1) < minVis) return this.fade(tSec)
    }

    const px = (i: number) => ({ x: lms[i].x * w, y: lms[i].y * h })
    const pA = px(R_SHOULDER)
    const pB = px(L_SHOULDER)
    const hipMid = {
      x: (lms[R_HIP].x + lms[L_HIP].x) / 2 * w,
      y: (lms[R_HIP].y + lms[L_HIP].y) / 2 * h,
    }
    const shoulderMid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 }

    const shoulderW = Math.hypot(pB.x - pA.x, pB.y - pA.y)
    const torsoH = Math.hypot(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y)
    if (shoulderW < 1 || torsoH < 1) return this.fade(tSec)

    // 侧身判定：正对镜头时肩宽/躯干长大约 0.8–1.3，转过去会塌
    const ratio = shoulderW / torsoH
    const facing = clamp((ratio - 0.35) / (0.6 - 0.35), 0, 1)
    if (facing <= 0) return this.fade(tSec)

    const { cfg } = this
    const iw = this.img.width
    const ih = this.img.height
    const gA = { x: cfg.anchorL.x * iw, y: cfg.anchorL.y * ih }
    const gB = { x: cfg.anchorR.x * iw, y: cfg.anchorR.y * ih }
    const gMid = { x: (gA.x + gB.x) / 2, y: (gA.y + gB.y) / 2 }
    const gHem = { x: cfg.hem.x * iw, y: cfg.hem.y * ih }

    const gW = Math.hypot(gB.x - gA.x, gB.y - gA.y)
    const gH = Math.hypot(gHem.x - gMid.x, gHem.y - gMid.y)

    let sx = (shoulderW / gW) * cfg.widthEase
    let sy = (torsoH / gH) * cfg.lengthEase
    // 关键：纵向相对横向钳制，否则侧身瞬间会被拉成竖条
    sy = clamp(sy, sx * 0.85, sx * 1.15)

    // 两条轴各给一个角度，再按 torsoBias 混合
    const gShoulderAng = Math.atan2(gB.y - gA.y, gB.x - gA.x)
    const gTorsoAng = Math.atan2(gHem.y - gMid.y, gHem.x - gMid.x)
    const angShoulder = Math.atan2(pB.y - pA.y, pB.x - pA.x) - gShoulderAng
    const angTorso = Math.atan2(hipMid.y - shoulderMid.y, hipMid.x - shoulderMid.x) - gTorsoAng
    const angle = lerpAngle(angShoulder, angTorso, cfg.torsoBias)

    // 平滑
    const cx = this.fCx.filter(shoulderMid.x, tSec)
    const cy = this.fCy.filter(shoulderMid.y, tSec)
    const a = this.fAngle.filter(angle, tSec)
    sx = this.fSx.filter(sx, tSec)
    sy = this.fSy.filter(sy, tSec)

    this.alpha = Math.min(1, this.alpha + 0.12) * facing
    const out: FitResult = { cx, cy, angle: a, sx, sy, facing, alpha: this.alpha }
    this.last = out
    return out
  }

  /** 丢失或侧身：不硬贴，冻结上一帧并淡出 */
  private fade(_tSec: number): FitResult | null {
    this.alpha = Math.max(0, this.alpha - 0.15)
    if (this.alpha <= 0.001 || !this.last) return null
    return { ...this.last, alpha: this.alpha }
  }

  draw(ctx: CanvasRenderingContext2D, fit: FitResult) {
    if (!this.img) return
    const iw = this.img.width
    const ih = this.img.height
    const gMid = {
      x: ((this.cfg.anchorL.x + this.cfg.anchorR.x) / 2) * iw,
      y: ((this.cfg.anchorL.y + this.cfg.anchorR.y) / 2) * ih,
    }

    ctx.save()
    ctx.globalAlpha = fit.alpha
    ctx.translate(fit.cx, fit.cy)
    ctx.rotate(fit.angle)
    ctx.scale(fit.sx, fit.sy)
    ctx.drawImage(this.img, -gMid.x, -gMid.y)
    ctx.restore()
  }

  /** 调锚点时用：把衣服的三个锚点画出来，和骨骼点对比就知道差多少 */
  drawAnchors(ctx: CanvasRenderingContext2D, fit: FitResult) {
    if (!this.img) return
    const iw = this.img.width
    const ih = this.img.height
    const gMid = {
      x: ((this.cfg.anchorL.x + this.cfg.anchorR.x) / 2) * iw,
      y: ((this.cfg.anchorL.y + this.cfg.anchorR.y) / 2) * ih,
    }
    const pts: Array<[{ x: number; y: number }, string]> = [
      [this.cfg.anchorL, '#00e5ff'],
      [this.cfg.anchorR, '#00e5ff'],
      [this.cfg.hem, '#ffd166'],
    ]

    ctx.save()
    ctx.translate(fit.cx, fit.cy)
    ctx.rotate(fit.angle)
    ctx.scale(fit.sx, fit.sy)
    for (const [p, color] of pts) {
      ctx.beginPath()
      ctx.arc(p.x * iw - gMid.x, p.y * ih - gMid.y, 6 / Math.max(fit.sx, 0.01), 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }
    ctx.restore()
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 角度插值要走最短弧，否则在 ±π 附近会整圈翻转 */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/* ── 素材配置 ───────────────────────────────────────────────────
   锚点是目测的初值，需要对着真人调。开发时可以在控制台改：
     __garment.cfg.anchorL.y = 0.28
   调好之后把数值写回这里。
   ──────────────────────────────────────────────────────────── */
export const TOP_01: GarmentConfig = {
  id: 'top-01',
  src: '/garments/outdoor/look1/top.png',
  anchorL: { x: 0.265, y: 0.305 },
  anchorR: { x: 0.755, y: 0.105 },
  hem: { x: 0.5, y: 1.575 },
  widthEase: 1.15,
  lengthEase: 0.9,
  torsoBias: 0.95,
}
