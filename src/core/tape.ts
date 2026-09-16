/**
 * 贴在衣服边缘的透明胶带。
 *
 * 形状和渐变是 Figma 那条 path 原样搬过来的（6:219 / 6:215）：撕口的平行四边形，
 * 白色，从右上的实心渐到左下的 56% 透明。
 *
 * 画在舞台那张 2D 画布上，坐标和 MeshGarment 的顶点是同一套 —— 位置、角度、
 * 拉伸都由 garment.sample() 给，所以衣服怎么形变，胶带就怎么跟着走。
 */

/** Figma 6:219 的 path，坐标在 76×69 的框里 */
const TAPE_D =
  'M59.097 -3.30366e-06L2.83509 43.8613L-4.81893e-05 47.1789L3.47856 47.1789L1.09976 51.9476L7.99382 50.7986L5.6958 56.7432L12.7886 54.2251L11.0766 57.9996L17.5542 56.7432L14.3513 62.2821L20.829 61.0258L17.5542 68.6082L72.3383 25.5203L75.1203 20.3498L67.7422 20.3498L70.7598 14.6047L62.5717 14.6047L66.0187 7.71068L56.8266 7.71068L59.097 -3.30366e-06Z'
const TAPE_W = 76
const TAPE_H = 69
/** 渐变的两端，同样抄自 Figma（userSpaceOnUse，所以就是这个框里的坐标） */
const GRAD = { x1: 80.3814, y1: 3.68916, x2: 1.09977, y2: 58.2671 }

/** Path2D 建一次就够，每帧重建纯属浪费 */
let path: Path2D | null = null
const tapePath = () => (path ??= new Path2D(TAPE_D))

/** 一片胶带贴在哪儿：v 是平铺图的高度比例，side 是贴哪条边，rot 是它自己的倾角 */
export interface TapeSlot {
  v: number
  side: 'l' | 'r'
  /** 角度，度。叠在衣服当前朝向之上 */
  rot: number
  /**
   * 胶带长度，**相对肩宽**的倍数。
   *
   * 不按衣服自己的尺寸算 —— 网格在不同位置的拉伸差得很远（实测裤子那一行的
   * 形变宽度是上衣的 1.5 倍），按它来算的话同一卷胶带贴到裤子上会大一圈。
   * 人有多大，胶带就有多大，上下装才是同一卷。
   */
  len: number
}

/**
 * 每种衣服贴几片、贴哪儿。数值来自 Figma：
 *   上装 6:217 —— 右肩一片（-10.98°）、左袖一片（59.52°）
 *   下装 6:213 —— 右侧腰下一片、左侧裤脚一片，都是 17.81°
 * u 不写死：每片按所在行去问衣服的轮廓边在哪，胶带**骑在边上**，一半贴在衣服上、
 * 一半悬空 —— 换任何一件衣服都不用重新量。
 */
export const TAPE_SLOTS: Record<'top' | 'bottom', TapeSlot[]> = {
  // Figma 里那卷胶带占衣服框宽的 22%（上装）/ 24.6%（下装）。拿实际画面量过：
  // 上衣那一行的形变宽度 218px、肩宽 115px，所以 0.222 × 218 ≈ 48px ≈ 0.42 倍肩宽。
  // 四片按这个基准换算，相互的长短关系保持 Figma 原样，最后整体再缩 0.8 ——
  // 换算出来的那档压在真人身上偏大了
  top: [
    { v: 0.137, side: 'r', rot: -10.98, len: 0.336 }, // 0.42 × 0.8
    { v: 0.427, side: 'l', rot: 59.52, len: 0.288 }, // 0.36 × 0.8
  ],
  bottom: [
    { v: 0.373, side: 'r', rot: 17.81, len: 0.368 }, // 0.46 × 0.8
    { v: 0.837, side: 'l', rot: 17.81, len: 0.368 },
  ],
}

export interface TapeDraw {
  /** 舞台坐标 */
  x: number
  y: number
  /** 弧度，已经把衣服朝向和这片自己的倾角加在一起 */
  angle: number
  /** 画出来多长（px） */
  len: number
  /** 0–1，贴上去的过程用 */
  progress: number
}

/**
 * 画一片。
 *
 * 「贴上去」那一下：先大一点、淡一点，再压实到正常大小 —— 像被手按下去。
 */
export function drawTape(ctx: CanvasRenderingContext2D, t: TapeDraw) {
  const p = Math.max(0, Math.min(1, t.progress))
  if (p <= 0) return
  // 压下去的手感：位置不动，只有尺寸从 1.3 收到 1
  const press = 1 + 0.3 * (1 - p) * (1 - p)
  const k = (t.len / TAPE_W) * press

  ctx.save()
  ctx.translate(t.x, t.y)
  ctx.rotate(t.angle)
  ctx.scale(k, k)
  ctx.globalAlpha = p
  // 绕自身中心转，所以先把这 76×69 的框挪到原点上
  ctx.translate(-TAPE_W / 2, -TAPE_H / 2)

  const g = ctx.createLinearGradient(GRAD.x1, GRAD.y1, GRAD.x2, GRAD.y2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0.56)')
  ctx.fillStyle = g
  ctx.fill(tapePath())
  ctx.restore()
}
