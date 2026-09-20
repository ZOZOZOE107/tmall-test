/**
 * 舞台：把输入源画面按 Fit Best（= TouchDesigner 的 Fit Best / CSS contain）
 * 放进视口，居中，永不裁切。舞台矩形就是「视频矩形」，所有人体锚定元素
 * 都以它为坐标系 —— MediaPipe 给的是 0–1 归一化坐标，乘舞台宽高即可，零偏移。
 */

export type Orientation = 'landscape' | 'portrait'
export type SizeTier = 'compact' | 'regular' | 'large'

/** 设备档。CSS 用 [data-device=...] 选择器响应，和 JS 共用同一份判定 */
export type DeviceKey =
  | 'phone'
  | 'tablet-portrait'
  | 'tablet-landscape'
  | 'desktop'
  | 'kiosk'

export interface StageRect {
  x: number
  y: number
  w: number
  h: number
  scale: number
}

export interface EnvInfo {
  orientation: Orientation
  tier: SizeTier
  device: DeviceKey
  /** 对应 Figma 舞台画板尺寸（产品 UI 用，工具栏不走这个） */
  canvas: { w: number; h: number }
  label: string
}

export const TIER_MULTIPLIER: Record<SizeTier, number> = {
  compact: 0.85,
  regular: 1,
  large: 1.15,
}

/** Fit Best：完整装下，等比，居中 */
export function fitBest(boxW: number, boxH: number, srcW: number, srcH: number): StageRect {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: 0, h: 0, scale: 1 }
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale }
}

/** Cover：铺满裁切。留作对照，默认不用 */
export function fitCover(boxW: number, boxH: number, srcW: number, srcH: number): StageRect {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: 0, h: 0, scale: 1 }
  const scale = Math.max(boxW / srcW, boxH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale }
}

/**
 * 环境判定：方向决定用哪套 Figma 画板，短边决定尺寸档。
 * 画板只有两套，平板不需要设计师额外画一套。
 */
export function detectEnv(boxW: number, boxH: number): EnvInfo {
  const orientation: Orientation = boxW >= boxH ? 'landscape' : 'portrait'
  const shortSide = Math.min(boxW, boxH)

  let tier: SizeTier
  let device: DeviceKey
  let label: string

  if (orientation === 'portrait') {
    if (shortSide < 768) {
      tier = 'compact'
      device = 'phone'
      label = 'phone'
    } else {
      tier = 'regular'
      device = 'tablet-portrait'
      label = 'tablet ↕'
    }
  } else if (boxW >= 1920) {
    tier = 'large'
    device = 'kiosk'
    label = 'kiosk'
  } else if (shortSide < 900) {
    tier = 'compact'
    device = 'tablet-landscape'
    label = 'tablet ↔'
  } else {
    tier = 'regular'
    device = 'desktop'
    label = 'desktop'
  }

  const canvas = orientation === 'landscape' ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 }
  return { orientation, tier, device, canvas, label }
}

export type Rotation = 0 | 90 | 180 | 270

export interface StageOptions {
  /** true 用 cover 裁切，默认 false 走 Fit Best */
  cover?: boolean
  rotation?: Rotation
  mirrored?: boolean
}

export class Stage {
  readonly el: HTMLElement
  private box = { w: 0, h: 0 }
  private src = { w: 0, h: 0 }
  private opts: StageOptions = { cover: false, rotation: 0, mirrored: false }

  /** 旋转后内容在视口里占的矩形 */
  rect: StageRect = { x: 0, y: 0, w: 0, h: 0, scale: 1 }
  /** 舞台元素本身的尺寸（未旋转的内容尺寸），canvas 按这个开 */
  content = { w: 0, h: 0 }
  env: EnvInfo = detectEnv(1, 1)

  /**
   * #stage 在屏幕上的矩形，缓存起来只在 apply() 时读一次。
   * toLocal() 每帧会被每个文件夹调用一次（最多七个），如果每次都现场
   * getBoundingClientRect，夹在文件夹自己的样式写入中间，就是标准的
   * 「写→读→写→读」布局抖动 —— 扇形展开时 GSAP 还在逐帧写 transform，
   * 叠在一起就是掉帧。#stage 的屏幕位置只有 apply() 跑的时候才会变，
   * 缓存下来足够安全。
   */
  private screenRect = { left: 0, top: 0, width: 0, height: 0 }

  /** 舞台此刻是不是镜像的。叠在舞台上的 UI 要照这个反着抵消一次 */
  get mirrored(): boolean {
    return !!this.opts.mirrored
  }

  onChange?: (rect: StageRect, env: EnvInfo) => void

  constructor(el: HTMLElement, viewport: HTMLElement) {
    this.el = el
    // 监听容器而不是 window，嵌 iframe、分屏、投屏都能正确重算
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      this.box = { w: r.width, h: r.height }
      this.apply()
    })
    ro.observe(viewport)
  }

  setSource(w: number, h: number) {
    this.src = { w, h }
    this.apply()
  }

  setOptions(opts: StageOptions) {
    this.opts = { ...this.opts, ...opts }
    this.apply()
  }

  /**
   * 屏幕坐标 → 舞台本地坐标（左上角原点，单位就是 content 的 px）。
   *
   * 舞台带着 rotate + scaleX(-1)，直接用 getBoundingClientRect 减一下是错的 ——
   * 变换绕中心做，所以反过来也得绕中心逆着来一遍。旋转和镜像的真值只有这里有，
   * 逆映射就放在这儿，别让调用方各自猜一份。
   */
  toLocal(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.screenRect
    const { w, h } = this.content
    // 变换保中心，所以屏幕上的中心就是本地中心
    let dx = clientX - (r.left + r.width / 2)
    let dy = clientY - (r.top + r.height / 2)

    const rot = ((this.opts.rotation ?? 0) % 360) as Rotation
    if (rot === 90) [dx, dy] = [dy, -dx]
    else if (rot === 180) [dx, dy] = [-dx, -dy]
    else if (rot === 270) [dx, dy] = [-dy, dx]

    if (this.opts.mirrored) dx = -dx

    return { x: dx + w / 2, y: dy + h / 2 }
  }

  private apply() {
    const { w: bw, h: bh } = this.box
    const { w: sw, h: sh } = this.src
    this.env = detectEnv(bw, bh)

    const rot = this.opts.rotation ?? 0
    const swapped = rot === 90 || rot === 270

    // 先按「旋转之后」的比例做 Fit Best，算出内容该占多大
    const fit = this.opts.cover ? fitCover : fitBest
    this.rect = fit(bw, bh, swapped ? sh : sw, swapped ? sw : sh)

    // 元素本身还是未旋转的尺寸，绕中心转过去正好落在 rect 里
    const elW = swapped ? this.rect.h : this.rect.w
    const elH = swapped ? this.rect.w : this.rect.h
    this.content = { w: elW, h: elH }

    this.el.style.left = `${this.rect.x + (this.rect.w - elW) / 2}px`
    this.el.style.top = `${this.rect.y + (this.rect.h - elH) / 2}px`
    this.el.style.width = `${elW}px`
    this.el.style.height = `${elH}px`

    const t: string[] = []
    if (rot) t.push(`rotate(${rot}deg)`)
    if (this.opts.mirrored) t.push('scaleX(-1)')
    this.el.style.transform = t.join(' ')
    // 道具层靠这个属性把镜像抵消掉 —— 画面要自拍镜像，上面的字不能跟着翻
    this.el.dataset.mirrored = this.opts.mirrored ? '1' : '0'

    // 环境判定只有这一处。CSS 通过 [data-device] / [data-orientation] 响应，
    // 和 JS 读的是同一份结果，不会出现两套断点各说各话。
    const root = document.documentElement
    root.dataset.device = this.env.device
    root.dataset.orientation = this.env.orientation
    root.dataset.tier = this.env.tier
    root.style.setProperty('--tier', String(TIER_MULTIPLIER[this.env.tier]))

    this.onChange?.(this.rect, this.env)

    // 这一次 apply() 已经在写样式了，索性把这次强制布局的账一起还掉，
    // 缓存的矩形够用到下一次 apply()（分辨率变、旋转变、窗口 resize）为止
    const rect = this.el.getBoundingClientRect()
    this.screenRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }
}
