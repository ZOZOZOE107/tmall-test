/**
 * 骨骼绘制。坐标是 MediaPipe 的 0–1 归一化值，直接乘舞台宽高即可 —— 因为
 * 舞台就是视频矩形本身（Fit Best，没有裁切偏移）。
 */
import { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { Category, NormalizedLandmark } from '@mediapipe/tasks-vision'

/** 贴合算法真正要用的锚点：肩、髋、膝 */
export const ANCHOR_IDS = new Set([11, 12, 23, 24, 25, 26])

/** 五个指尖 */
export const FINGER_TIP_IDS = new Set([4, 8, 12, 16, 20])
/** 拇指尖 + 食指尖：捏取手势靠这两个点的距离 */
const THUMB_TIP = 4
const INDEX_TIP = 8

const HAND_COLORS = ['#4dd9ff', '#ffd166']

export interface DrawOptions {
  minVisibility: number
  showIndex: boolean
  /** 舞台被镜像时，文字要单独翻回来 */
  mirrored: boolean
}

let cachedCanvas: HTMLCanvasElement | null = null
let cachedCtx: CanvasRenderingContext2D | null = null

export function resizeCanvas(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  dprCap = 1.5,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap)
  const pw = Math.max(1, Math.round(w * dpr))
  const ph = Math.max(1, Math.round(h * dpr))
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
  }
  // getContext 每帧调一次也不便宜，缓存住
  if (cachedCanvas !== canvas) {
    cachedCanvas = canvas
    cachedCtx = canvas.getContext('2d')
  }
  if (!cachedCtx) return null
  cachedCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return cachedCtx
}

export function clear(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.clearRect(0, 0, w, h)
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  w: number,
  h: number,
  opts: DrawOptions,
) {
  const visible = (lm: NormalizedLandmark) => (lm.visibility ?? 1) >= opts.minVisibility
  const px = (lm: NormalizedLandmark) => [lm.x * w, lm.y * h] as const

  // 骨架线
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(255,255,255,0.88)'
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 6

  ctx.beginPath()
  for (const c of PoseLandmarker.POSE_CONNECTIONS) {
    const a = landmarks[c.start]
    const b = landmarks[c.end]
    if (!a || !b || !visible(a) || !visible(b)) continue
    const [ax, ay] = px(a)
    const [bx, by] = px(b)
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
  }
  ctx.stroke()
  ctx.shadowBlur = 0

  // 关节点
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i]
    if (!lm || !visible(lm)) continue
    const [x, y] = px(lm)
    const isAnchor = ANCHOR_IDS.has(i)

    ctx.beginPath()
    ctx.arc(x, y, isAnchor ? 7 : 4, 0, Math.PI * 2)
    ctx.fillStyle = isAnchor ? '#ff0036' : 'rgba(77,155,255,0.95)'
    ctx.fill()

    if (isAnchor) {
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.stroke()
    }
  }

  // 肩线与髋线：贴合精度靠这两条，单独描出来方便肉眼校验
  drawAxis(ctx, landmarks, 11, 12, w, h, opts.minVisibility, 'rgba(255,0,54,0.55)')
  drawAxis(ctx, landmarks, 23, 24, w, h, opts.minVisibility, 'rgba(255,0,54,0.35)')

  if (opts.showIndex) drawIndices(ctx, landmarks, w, h, opts)
}

export function drawHands(
  ctx: CanvasRenderingContext2D,
  hands: NormalizedLandmark[][],
  handedness: Category[][],
  w: number,
  h: number,
  opts: DrawOptions,
) {
  hands.forEach((lms, i) => {
    const color = HAND_COLORS[i % HAND_COLORS.length]

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 2.5
    ctx.strokeStyle = color
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = 5

    ctx.beginPath()
    for (const c of HandLandmarker.HAND_CONNECTIONS) {
      const a = lms[c.start]
      const b = lms[c.end]
      if (!a || !b) continue
      ctx.moveTo(a.x * w, a.y * h)
      ctx.lineTo(b.x * w, b.y * h)
    }
    ctx.stroke()
    ctx.shadowBlur = 0

    for (let j = 0; j < lms.length; j++) {
      const lm = lms[j]
      const isTip = FINGER_TIP_IDS.has(j)
      const isPinch = j === THUMB_TIP || j === INDEX_TIP

      ctx.beginPath()
      ctx.arc(lm.x * w, lm.y * h, isPinch ? 6 : isTip ? 4.5 : 2.5, 0, Math.PI * 2)
      ctx.fillStyle = isPinch ? '#ff0036' : color
      ctx.fill()

      if (isPinch) {
        ctx.lineWidth = 1.5
        ctx.strokeStyle = 'rgba(255,255,255,0.95)'
        ctx.stroke()
      }
    }

    // 捏取指示线：拖衣服和画毛线都会用这两点的距离做判定
    const thumb = lms[THUMB_TIP]
    const index = lms[INDEX_TIP]
    if (thumb && index) {
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(255,0,54,0.7)'
      ctx.beginPath()
      ctx.moveTo(thumb.x * w, thumb.y * h)
      ctx.lineTo(index.x * w, index.y * h)
      ctx.stroke()
      ctx.restore()
    }

    if (opts.showIndex) {
      const label = handedness[i]?.[0]?.categoryName
      const wrist = lms[0]
      if (label && wrist) {
        ctx.save()
        ctx.translate(wrist.x * w, wrist.y * h + 18)
        if (opts.mirrored) ctx.scale(-1, 1)
        ctx.font = '600 11px ui-monospace, "SF Mono", monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(0,0,0,0.65)'
        ctx.strokeText(label, 0, 0)
        ctx.fillStyle = color
        ctx.fillText(label, 0, 0)
        ctx.restore()
      }
    }
  })
}

function drawAxis(
  ctx: CanvasRenderingContext2D,
  lms: NormalizedLandmark[],
  a: number,
  b: number,
  w: number,
  h: number,
  minVis: number,
  color: string,
) {
  const p = lms[a]
  const q = lms[b]
  if (!p || !q) return
  if ((p.visibility ?? 1) < minVis || (q.visibility ?? 1) < minVis) return
  ctx.save()
  ctx.setLineDash([8, 6])
  ctx.lineWidth = 2
  ctx.strokeStyle = color
  ctx.beginPath()
  ctx.moveTo(p.x * w, p.y * h)
  ctx.lineTo(q.x * w, q.y * h)
  ctx.stroke()
  ctx.restore()
}

function drawIndices(
  ctx: CanvasRenderingContext2D,
  lms: NormalizedLandmark[],
  w: number,
  h: number,
  opts: DrawOptions,
) {
  ctx.font = '600 11px ui-monospace, "SF Mono", monospace'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'

  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i]
    if (!lm || (lm.visibility ?? 1) < opts.minVisibility) continue
    const x = lm.x * w
    const y = lm.y * h - 14

    ctx.save()
    ctx.translate(x, y)
    if (opts.mirrored) ctx.scale(-1, 1) // 舞台镜像时把文字翻回来
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'
    ctx.strokeText(String(i), 0, 0)
    ctx.fillStyle = ANCHOR_IDS.has(i) ? '#ff6b8a' : '#ffffff'
    ctx.fillText(String(i), 0, 0)
    ctx.restore()
  }
}
